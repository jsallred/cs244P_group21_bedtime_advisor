# Cloud setup (logger + 72 h dashboard)

ESP32 -> EMQX (MQTT) -> EMQX HTTP rule -> Cloudflare Worker -> D1 database -> dashboard page

Everything after the ESP32 runs on free tiers, so no laptop is needed while the device is running.

Generate two random secrets (any long random strings) and keep them out of Git:
- `INGEST_KEY`: lets EMQX write data to the Worker
- `VIEW_KEY`: lets you open the dashboard

## A. Cloudflare (browser only)

1. Sign up at dash.cloudflare.com (free plan).
2. Storage & Databases -> D1 -> Create a database named `bedtime-db`.
   Open its Console tab, paste all of `schema.sql`, click Execute.
3. Workers & Pages -> Create -> Worker named `bedtime-advisor`. Deploy the Hello World version,
   click Edit code, replace everything with `worker.js`, and Deploy.
4. Worker -> Settings -> Bindings -> Add -> D1 database. Variable name must be exactly `DB`; select `bedtime-db`.
5. Worker -> Settings -> Variables and Secrets -> add `INGEST_KEY` and `VIEW_KEY` as Secrets.
6. Your address is shown on the Worker page: `https://bedtime-advisor.<your-subdomain>.workers.dev`.
   Open `https://bedtime-advisor.<your-subdomain>.workers.dev/?key=<VIEW_KEY>` to see the dashboard.

## B. EMQX forwards messages to the Worker

In the EMQX deployment -> Data Integration:
1. New Connector -> HTTP Server.
   - URL: `https://bedtime-advisor.<your-subdomain>.workers.dev/ingest`
   - Headers: `authorization: Bearer <INGEST_KEY>` and `content-type: application/json`
   - Enable TLS and set SNI to `bedtime-advisor.<your-subdomain>.workers.dev`
   - Click Test, then New.
2. New Rule:
   - SQL: `SELECT topic, payload FROM "iot/T21/#"`
   - Action: the HTTP connector (POST, default body).

## C. Check it

Within about 15 s of the ESP32 publishing, the dashboard shows the temperature and a green "live" badge.
In EMQX, the rule's Matched and Success counters increase.

## Troubleshooting

- "cannot reach server" on the dashboard: the D1 binding is missing or not named `DB`, or the schema was not run.
  Open `/api/data?key=<VIEW_KEY>&light=1` to see the exact error.
- Dashboard stays empty: the EMQX rule is disabled, the INGEST_KEY header is wrong, or the URL is wrong.
