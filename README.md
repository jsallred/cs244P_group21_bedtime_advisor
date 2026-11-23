# Bedtime Cooling Advisor (Team 21)

An ESP32 that measures bedroom air temperature, recommends whether to run the AC **Off, Low or High** so the room reaches a target by 9 PM, and streams the data to a cloud dashboard with 72 hours of history.

Course project for CS 244P (Internet of Things), Fall 2026.

## How it works

```
BMP280 --I2C--> ESP32 --Wi-Fi--> MQTT over TLS --> EMQX Cloud (broker)
EMQX HTTP rule --HTTPS POST--> Cloudflare Worker --> D1 database
Browser --> Cloudflare Worker --> dashboard (live + 72 h history, gaps, coverage)
```

- **Device:** reads the BMP280, reads a potentiometer for the target (55-80 F), gets the time from NTP, picks OFF/LOW/HIGH from the temperature drop needed per minute until 9 PM, and shows it on an OLED and three LEDs. It keeps working with no internet.
- **Messaging:** publishes JSON over MQTT/TLS (port 8883) to EMQX Serverless. A Last Will message reports when the device drops offline.
- **Cloud:** an EMQX rule forwards every message to a Cloudflare Worker, which stores it in D1 and serves the dashboard.

### MQTT topics

| Topic | Payload | When |
|---|---|---|
| `iot/T21/temp` | `device_id, timestamp, sequence, temperature_f, target_f` | every `PUBLISH_MS` |
| `iot/T21/advice` | `advice, predicted_f, minutes_left, cannot_reach` | when the advice changes |
| `iot/T21/status` | `online` / `offline` (retained, Last Will) | connect, heartbeat, disconnect |

## Repository layout

```
platformio.ini            PlatformIO config (ESP32 dev board, libraries)
src/main.cpp              Firmware
include/secrets.h.example Template for local credentials (copy to secrets.h)
cloud/worker.js           Cloudflare Worker: /ingest, /api/data, dashboard page
cloud/schema.sql          D1 database tables
cloud/SETUP-CLOUD.md      Step-by-step cloud setup
```

`include/secrets.h` is git-ignored and holds your real credentials.

## Hardware (Fall 2026 kit pin map)

| Part | Pins |
|---|---|
| BMP280 (I2C, address 0x76) | SDA 21, SCL 22, CSB to 3V3, SDO to GND |
| SPI OLED (SSD1306) | SCK 18, MOSI 23, CS 5, DC 16, RES 17 |
| LEDs via 220 ohm | green 15 (OFF), yellow 4 (LOW), red 2 (HIGH) |
| Potentiometer (target temperature) | 34 |

Power: 5 V USB wall adapter. Wi-Fi must be **2.4 GHz** (an iPhone hotspot needs Maximize Compatibility on).

## Setup

1. **Firmware credentials:** copy `include/secrets.h.example` to `include/secrets.h` and fill in your Wi-Fi, EMQX DNS hostname, username and password. Replace `MQTT_CA_CERT` with the complete trusted CA PEM downloaded from your EMQX deployment console. The placeholder cannot establish a TLS connection.
2. **EMQX:** create a free Serverless deployment (set Spend Limit to 0), and add an authentication user under Access Control.
3. **Cloud:** follow `cloud/SETUP-CLOUD.md` to create the D1 database, Worker, and EMQX rule.
4. **Flash:** open the folder in PlatformIO (VS Code), then Upload and open the Serial Monitor at 115200.
   Expected: `BMP280 OK`, then after Wi-Fi and NTP synchronization, `MQTT connected` and `pub temp ... -> ok`.
5. **Dashboard:** open `https://bedtime-advisor.<your-subdomain>.workers.dev/?key=<VIEW_KEY>`.

**Upgrading an existing checkout:** Git does not update your ignored
`include/secrets.h`. Keep your existing credentials and manually add the
`MQTT_CA_CERT` declaration from `include/secrets.h.example`, replacing its
placeholder with your deployment's trusted CA PEM. Otherwise compilation fails
with `MQTT_CA_CERT was not declared`. Do not overwrite your credentials by
copying the whole example over an existing file.

## Configuration (top of `src/main.cpp`)

| Constant | Meaning |
|---|---|
| `PUBLISH_MS` | reading interval; 10000 for demos, 60000 for the 72-hour run |
| `DEADLINE_HOUR` | target time (21 = 9 PM) |
| `TEMP_OFFSET_F` | calibration offset against a reference thermometer |
| `RATE_OFF/LOW/HIGH` | cooling rates in F per minute (calibrate before the final test) |

## Dashboard

Shows current temperature, target, AC advice, minutes until 9 PM, a 6/24/72 h chart, readings received, coverage percentage, a table of every gap over 2.5 minutes, and device online/offline events.

## Security notes

- No credentials are stored in the repository; `secrets.h` is ignored and the cloud keys live only in Cloudflare and EMQX.
- MQTT uses a username and password over TLS. The Worker accepts writes only with a secret bearer key, and the dashboard needs a view key.
- The ESP32 verifies the broker certificate chain using `MQTT_CA_CERT` and validates the DNS hostname in `MQTT_HOST`. MQTT attempts wait for an NTP synchronization callback after boot and a clock sanity check (Unix time > 1700000000). NTP is not authenticated.
- Maintain the trusted CA when the deployment certificate chain changes. Never fall back to disabling verification on connection errors.

### Local TLS validation

Run `pio run` to compile after configuring `include/secrets.h`. Compilation alone does not verify TLS behavior. On an ESP32, check:

1. Correct CA, broker DNS hostname, and synchronized time: MQTT connects and publishes.
2. An unrelated CA: TLS fails and MQTT stays disconnected.
3. A hostname absent from the server certificate (using a controlled test broker): TLS fails before MQTT authentication.
4. After a cold boot with NTP blocked: MQTT stays disconnected while sensing, LEDs, and display continue; restoring NTP allows a connection.

Use a controlled broker and disposable credentials for negative tests. NTP synchronization is required once per boot; it does not establish authenticated time or guarantee continued freshness.

## Known limitations

- No local buffering of readings while offline.
- Cooling rates are placeholders until calibrated.
- Wi-Fi credentials are compiled in; a real product would need a provisioning flow.
