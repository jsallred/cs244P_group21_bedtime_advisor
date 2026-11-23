// Bedtime Cooling Advisor - ESP32 firmware (vertical-slice version)
// Reads BMP280 + pot, gets time via NTP, advises OFF/LOW/HIGH, shows on OLED + LEDs,
// publishes JSON over MQTT/TLS to EMQX Cloud.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_BMP280.h>
#include <Adafruit_SSD1306.h>
#include <time.h>
#include "secrets.h"

// ---------------- Pins ----------------
// Matches the Fall 2026 kit pin map (Lab 1)
#define PIN_POT     34   // ADC1, target temp
#define PIN_LED_G   15   // OFF   (green)
#define PIN_LED_Y   4    // LOW   (yellow)
#define PIN_LED_R   2    // HIGH  (red)
#define PIN_SDA     21   // I2C: BMP280 only
#define PIN_SCL     22
// SPI OLED: SCK 18, MOSI(SDA) 23
#define OLED_CS     5
#define OLED_DC     16
#define OLED_RST    17

// ---------------- Config ----------------
static const char* DEVICE_ID = "T21";
static const int   DEADLINE_HOUR = 21;          // 9 PM
static const long  PUBLISH_MS = 60000;          // 10 s for demo; set 60000 for final
static const long  SENSE_MS   = 2000;
static const float TEMP_OFFSET_F = 0.0f;        // calibrate vs reference thermometer
static const float TARGET_MIN_F = 55.0f, TARGET_MAX_F = 80.0f;

// Calibrated cooling rates, degF per minute (defaults - replace after calibration)
static const float RATE_OFF  = 0.02f;
static const float RATE_LOW  = 0.08f;
static const float RATE_HIGH = 0.15f;

// Pacific time with DST
static const char* TZ_INFO = "PST8PDT,M3.2.0,M11.1.0";

enum Advice { ADV_OFF = 0, ADV_LOW = 1, ADV_HIGH = 2 };
static const char* ADV_NAME[] = {"OFF", "LOW", "HIGH"};

// ---------------- Globals ----------------
Adafruit_BMP280 bmp;
Adafruit_SSD1306 oled(128, 64, &SPI, OLED_DC, OLED_RST, OLED_CS);
WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

bool haveBmp = false, haveOled = false;
float tempF = NAN, targetF = 65.0f;
Advice advice = ADV_OFF, lastPublishedAdvice = (Advice)-1;
bool cannotReach = false;
int minutesLeft = -1;       // -1 = holding mode / time unknown
float predictedF = NAN;
uint32_t seqNum = 0;
unsigned long tSense = 0, tPublish = 0, tMqttTry = 0, tHeartbeat = 0;

String topic(const char* leaf) { return String("iot/") + DEVICE_ID + "/" + leaf; }

bool timeSynced() { return time(nullptr) > 1700000000; }

String isoUtc() {
  time_t now = time(nullptr);
  if (now < 1700000000) return "unsynced";
  struct tm t; gmtime_r(&now, &t);
  char buf[25]; strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

// ---------------- Advice logic ----------------
void computeAdvice() {
  minutesLeft = -1;
  cannotReach = false;
  predictedF = tempF;
  if (isnan(tempF)) return;

  bool holdMode = true;
  if (timeSynced()) {
    time_t now = time(nullptr);
    struct tm lt; localtime_r(&now, &lt);
    int nowMin = lt.tm_hour * 60 + lt.tm_min;
    // Between 6 AM and 9 PM we work toward the deadline; otherwise hold the target.
    if (lt.tm_hour >= 6 && lt.tm_hour < DEADLINE_HOUR) {
      minutesLeft = DEADLINE_HOUR * 60 - nowMin;
      holdMode = false;
    }
  }

  float drop = tempF - targetF;
  Advice a = ADV_OFF;
  if (holdMode) {
    // Hold within ~1 F of target
    if (drop > 3.0f) a = ADV_HIGH;
    else if (drop > 1.0f) a = ADV_LOW;
    else a = ADV_OFF;
    // hysteresis: stay in LOW until within 0.5 F
    if (advice == ADV_LOW && drop > 0.5f && a == ADV_OFF) a = ADV_LOW;
    predictedF = tempF;
  } else {
    if (drop <= 0) {
      a = ADV_OFF;
    } else {
      float need = drop / max(1, minutesLeft);   // F/min required
      if (need <= RATE_OFF) a = ADV_OFF;
      else if (need <= RATE_LOW) a = ADV_LOW;
      else { a = ADV_HIGH; cannotReach = need > RATE_HIGH; }
    }
    float r = (a == ADV_OFF) ? RATE_OFF : (a == ADV_LOW ? RATE_LOW : RATE_HIGH);
    predictedF = tempF - r * minutesLeft;
  }
  advice = a;
}

// ---------------- Outputs ----------------
void updateLeds() {
  digitalWrite(PIN_LED_G, advice == ADV_OFF);
  digitalWrite(PIN_LED_Y, advice == ADV_LOW);
  digitalWrite(PIN_LED_R, advice == ADV_HIGH);
}

void updateOled() {
  if (!haveOled) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.printf("Temp:   %.1f F", tempF);
  oled.setCursor(0, 10);
  oled.printf("Target: %.0f F", targetF);
  oled.setCursor(0, 20);
  if (minutesLeft >= 0) oled.printf("To 9PM: %d min", minutesLeft);
  else oled.print(timeSynced() ? "Holding target" : "Time: syncing...");
  oled.setTextSize(2);
  oled.setCursor(0, 32);
  oled.printf("AC:%s", ADV_NAME[advice]);
  oled.setTextSize(1);
  oled.setCursor(0, 54);
  if (cannotReach) oled.print("CANNOT REACH TARGET");
  else oled.printf("WiFi:%s MQTT:%s", WiFi.status() == WL_CONNECTED ? "ok" : "--", mqtt.connected() ? "ok" : "--");
  oled.display();
}

// ---------------- Connectivity ----------------
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  static unsigned long last = 0;
  if (millis() - last < 10000 && last != 0) return;
  last = millis();
  Serial.println("WiFi connecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void publishStatus(const char* s) {
  mqtt.publish(topic("status").c_str(), s, true);
}

void ensureMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - tMqttTry < 5000 && tMqttTry != 0) return;
  tMqttTry = millis();
  Serial.println("MQTT connecting...");
  String cid = String("esp32-") + DEVICE_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  bool ok = mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS,
                         topic("status").c_str(), 1, true, "offline");
  if (ok) {
    Serial.println("MQTT connected");
    publishStatus("online");
    lastPublishedAdvice = (Advice)-1;  // force advice publish
  } else {
    Serial.printf("MQTT failed rc=%d\n", mqtt.state());
  }
}

void publishTemp() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["timestamp"] = isoUtc();
  doc["sequence"] = seqNum++;
  doc["temperature_f"] = roundf(tempF * 10) / 10.0f;
  doc["target_f"] = targetF;
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  bool ok = mqtt.publish(topic("temp").c_str(), (const uint8_t*)buf, n, false);
  Serial.printf("pub temp %s -> %s\n", buf, ok ? "ok" : "FAIL");
}

void publishAdvice() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["timestamp"] = isoUtc();
  doc["advice"] = ADV_NAME[advice];
  doc["predicted_f"] = roundf(predictedF * 10) / 10.0f;
  doc["minutes_left"] = minutesLeft;
  doc["cannot_reach"] = cannotReach;
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topic("advice").c_str(), (const uint8_t*)buf, n, true);
  lastPublishedAdvice = advice;
}

// ---------------- BMP280 helpers ----------------
void i2cScan() {
  Serial.print("I2C devices:");
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf(" 0x%02X", a); found++; }
  }
  Serial.printf("  (%d found; BMP280 should be 0x76)\n", found);
}

bool initBmp() {
  if (bmp.begin(0x76)) { Serial.println("BMP280 OK at 0x76"); return true; }
  if (bmp.begin(0x77)) { Serial.println("BMP280 OK at 0x77"); return true; }
  Serial.println("BMP280 init FAILED (will retry)");
  return false;
}

// ---------------- Setup / loop ----------------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED_G, OUTPUT); pinMode(PIN_LED_Y, OUTPUT); pinMode(PIN_LED_R, OUTPUT);
  analogReadResolution(12);

  delay(300);  // let sensors power up
  Serial.println("\n=== Bedtime Cooling Advisor boot ===");
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);   // same as the lab code
  i2cScan();
  SPI.begin();
  haveOled = oled.begin(SSD1306_SWITCHCAPVCC);
  if (!haveOled) Serial.println("OLED init failed - check the 7 SPI wires");
  haveBmp = initBmp();

  // LED self-test
  digitalWrite(PIN_LED_G, HIGH); delay(200); digitalWrite(PIN_LED_G, LOW);
  digitalWrite(PIN_LED_Y, HIGH); delay(200); digitalWrite(PIN_LED_Y, LOW);
  digitalWrite(PIN_LED_R, HIGH); delay(200); digitalWrite(PIN_LED_R, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTzTime(TZ_INFO, "pool.ntp.org", "time.nist.gov");

  // Demo shortcut: skip certificate validation. For the final build, load HiveMQ's
  // root CA (ISRG Root X1) with tlsClient.setCACert(...) instead.
  tlsClient.setInsecure();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(30);
  mqtt.setBufferSize(512);
}

void loop() {
  ensureWifi();
  ensureMqtt();
  if (mqtt.connected()) mqtt.loop();

  unsigned long now = millis();
  if (now - tSense >= SENSE_MS || tSense == 0) {
    tSense = now;
    if (!haveBmp) haveBmp = initBmp();   // keep retrying if the boot-time init missed
    if (haveBmp) {
      float c = bmp.readTemperature();
      if (isfinite(c) && c > -40.0f && c < 85.0f) tempF = c * 9.0f / 5.0f + 32.0f + TEMP_OFFSET_F;
      else tempF = NAN;
    }
    int raw = analogRead(PIN_POT);
    targetF = roundf(TARGET_MIN_F + (raw / 4095.0f) * (TARGET_MAX_F - TARGET_MIN_F));
    computeAdvice();
    updateLeds();
    updateOled();
    Serial.printf("T=%.1fF target=%.0fF advice=%s minsLeft=%d\n", tempF, targetF, ADV_NAME[advice], minutesLeft);
  }

  if (mqtt.connected()) {
    if (!isnan(tempF) && (now - tPublish >= PUBLISH_MS || tPublish == 0)) {
      tPublish = now;
      publishTemp();
    }
    if (advice != lastPublishedAdvice && !isnan(tempF)) publishAdvice();
    if (now - tHeartbeat >= 60000) { tHeartbeat = now; publishStatus("online"); }
  }
}
