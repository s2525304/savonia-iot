## Raspberry Pi (IoT Edge)

Tässä projektissa Raspberry Pi toimii IoT edge -laitteena. Se lukee anturidataa, puskuroi mittaukset paikallisesti ja välittää ne pilveen (Azure IoT Hub) luotettavasti myös verkkokatkojen yli.

### Arkkitehtuurin yleiskuva

Raspberry Pi:llä ajetaan kahta pääprosessia:

1. **sensor-reader**  
   - Ajetaan systemd-timerin kautta
   - Lukee yhden sensorin mittausarvon
   - Tallentaa mittauksen paikalliseen SQLite-tietokantaan
   - Prosessi on *one-shot*: lukee, tallentaa ja poistuu

2. **measurement-transferrer**  
   - Ajetaan systemd-timerin kautta
   - Tarkistaa säännöllisesti SQLite-puskurin
   - Lähettää mittaukset yksi kerrallaan IoT Hubiin
   - Poistaa onnistuneesti lähetetyt mittaukset puskurista

Näin sensoriluku ja tiedonsiirto on erotettu toisistaan, ja ratkaisu toimii myös verkkokatkojen aikana.

---

### Hakemistorakenne (Raspberry Pi)

```
raspberry/
├── src/
│   ├── sensor-reader.ts        # Sensorin lukuprosessi (one-shot)
│   ├── measurement-transferrer.ts  # Mittausten siirto pilveen
│   ├── lib/
│   │   ├── config.ts            # Konfiguraation luku ja validointi
│   │   ├── sqlite.ts            # SQLite-tietokanta (puskuri)
│   │   └── log.ts               # Winston-pohjainen lokitus
│   └── sensors/
│       ├── index.ts             # Sensorien rekisteri
│       ├── types.ts             # Sensorirajapinta
│       ├── random-temp.ts       # Simuloitu lämpötila-anturi
│       └── pi-cpu-temp.ts       # Raspberry Pi CPU -lämpötila
├── dist/                        # Käännetty JavaScript (tsc)
├── config/
│   └── config.json              # Raspberry Pi -konfiguraatio
└── scripts/
    ├── install.sh               # Asennusskripti Raspberry Pi:lle
    └── systemd/                 # systemd service- ja timer-templatet
```

---

### Konfiguraatio (config.json)

Raspberry Pi käyttää JSON-konfiguraatiotiedostoa, joka määrittää laitteen, polut ja sensorit.

Esimerkki:

```json
{
  "device": {
    "deviceId": "pi-01",
    "location": "livingroom"
  },
  "paths": {
    "sqlite": "./tmp/buffer.sqlite",
    "logDir": "./tmp/savonia-iot"
  },
  "sensors": [
    {
      "sensorId": "pi-cpu-temp",
      "type": "pi_cpu_temp",
      "intervalMs": 60000
    },
    {
      "sensorId": "random-temp",
      "type": "random_temp",
      "intervalMs": 60000
    }
  ]
}
```

- `deviceId`: IoT-laitteen tunniste
- `paths.sqlite`: SQLite-puskurin sijainti
- `paths.logDir`: lokitiedostojen hakemisto
- `intervalMs`: kuinka usein sensori luetaan (millisekunteina)

---

### Asennus Raspberry Pi:lle

Edellytykset:
- Raspberry Pi OS (Bookworm)
- Node.js 20 asennettuna järjestelmätasolle (`/usr/bin/node`)
- git

Asennus:

```bash
git clone https://github.com/s2525304/savonia-iot.git
cd savonia-iot
npm run install:raspberry
```

Asennusskripti tekee seuraavaa:
- asentaa npm-riippuvuudet
- kääntää TypeScript-koodin
- asentaa systemd service- ja timer-yksiköt
- generoi automaattisesti timerit kaikille config.json:ssa määritellyille sensoreille

---

### systemd-ajomalli

Jokaiselle sensorille luodaan oma systemd-timer:

```
savonia-iot-sensor-<sensorId>.timer
```

Timer käynnistää geneerisen service-yksikön:

```
savonia-iot-sensor@<sensorId>.service
```

Measurement-transferrer käyttää omaa timeriä:

```
savonia-iot-transferrer.timer
```

Tämä malli:
- estää pitkään ajettavat prosessit
- helpottaa virhetilanteiden hallintaa
- tekee ajoväleistä helposti konfiguroitavia

---

### Lokit ja vianetsintä

Sensorin lokit:

```bash
journalctl -u savonia-iot-sensor@pi-cpu-temp.service -f
```

Transferrerin lokit:

```bash
journalctl -u savonia-iot-transferrer.service -f
```

---

### Koodin laajentaminen

Uuden sensorin lisääminen:
1. Lisää uusi moduuli `raspberry/src/sensors/`
2. Toteuta `SensorModule`-rajapinta
3. Rekisteröi sensori `sensors/index.ts`-tiedostoon
4. Lisää sensori `config.json`-tiedostoon

Systemd-timer generoituu automaattisesti asennuksen yhteydessä.

---

## Azure (Backend & Web UI)

Tässä projektissa pilvipuoli on toteutettu Azuren palveluilla. Raspberry Pi lähettää mittaukset Azure IoT Hubiin, ja Azure Functions prosessoi ne nopeasti sekä välittää ne edelleen tallennukseen ja käyttöliittymälle.

### Arkkitehtuuri (Azure)

Päävirta:

- **Raspberry Pi → Azure IoT Hub**: laite lähettää telemetrian IoT Hubiin.
- **Azure Function `ingest`**: vastaanottaa viestit IoT Hubista ja fan-outtaa ne jatkokäsittelyyn.
- **Azure Storage Queues**: ingest puskee viestit jonoihin (esim. DB-kirjoitus, hälytykset, blob-arkistointi). Tämä auttaa, jos Functionia päivitetään tai jokin alaketju hetkellisesti hidastuu.
- **TimescaleDB (Azure PostgreSQL)**: `timescale-writer` kirjoittaa mittaukset tietokantaan ja `aggregates` päivittää tuntiaggregaatiot.
- **Blob Storage (cold storage)**: `blob-writer` arkistoi telemetrian .jsonl-append-blobeihin.
- **HTTP API (Azure Functions)**: mittaukset, sensorit, triggerit ja alertit tarjotaan HTTP-endpointeilla Web UI:lle.
- **Static Web App (SWA)**: `azure/webui` sisältää selainkäyttöliittymän, joka käyttää Functionien HTTP-rajapintaa.

Azure Functions -kokonaisuus (esimerkkitasolla):
- `ingest` (IoT Hub → jonot)
- `timescale-writer` (jonosta → TimescaleDB)
- `aggregates` (tuntiaggregaattien päivitys)
- `alert` (hälytyslogiikka)
- `blob-writer` (jonosta → Blob Storage)
- `src/functions/http/*` (REST API Web UI:lle)

### HTTP API (Azure Functions)

Web UI käyttää Azure Functionien tarjoamaa HTTP REST -rajapintaa. Rajapinnan base path on **`/api`** (Static Web Apps proxyn kautta) ja se tukee sekä JSON- että CSV-vastauksia.

#### Autentikointi (shared secret)

Rajapinta on suojattu ja vaatii **shared secret** -avaimen.

- Header (suositus): `x-api-key: <SECRET>`
- Vaihtoehtoisesti query-parametrina: `?code=<SECRET>`

#### CSV-vastaus

Useimmat endpointit tukevat CSV-muotoa. Käytä:

- `?format=csv` (esim. mittaukset, hourly, alert)

Joissain endpointeissa CSV valitaan yleisemmällä muodolla (toteutustavasta riippuen), mutta Web UI käyttää käytännössä `format=csv`.

---

#### 1) Listaa laitteet

`GET /api/devices`

Palauttaa laitteet, joilla on havaittua telemetriaa.

**JSON response**

```json
{ "devices": [ { "deviceId": "pi-01", "location": "livingroom" } ] }
```

CSV: `?format=csv`

---

#### 2) Listaa laitteen sensorit

`GET /api/devices/{deviceId}/sensors`

Palauttaa sensoreiden metatiedot ja aikavälin (first/last) sekä havaintojen määrän.

**JSON response**

```json
{ "deviceId": "pi-01", "sensors": [ { "sensorId": "pi-cpu-temp", "type": "pi_cpu_temp", "unit": "C", "location": "livingroom", "firstTs": "...", "lastTs": "...", "count": 123 } ] }
```

CSV: `?format=csv`

---

#### 3) Hae mittaukset

`GET /api/devices/{deviceId}/sensors/{sensorId}/measurements?from&to&limit&afterTs&afterSeq&format`

Palauttaa raakamittaukset aikaväliltä.

**Query-parametrit**
- `from` / `to` (ISO8601, esim. `2026-01-29T12:00:00Z`). Jos puuttuu, backend käyttää turvallista oletusikkunaa.
- `limit` (oletus 1000, max 5000)
- `afterTs` + `afterSeq` (cursor-paginointi)
- `format=csv` (valinnainen)

**JSON response**

```json
{
  "deviceId": "pi-01",
  "sensorId": "pi-cpu-temp",
  "from": "...",
  "to": "...",
  "limit": 1000,
  "hasMore": false,
  "nextCursor": null,
  "items": [ ["2026-01-29T12:00:00Z", 1, 45.21] ]
}
```

**Huom:** `items` on tiivis taulukkomuoto: `[ts, seq, value]`.

---

#### 4) Hae tuntiaggregaatti (hourly)

`GET /api/devices/{deviceId}/sensors/{sensorId}/hourly?from&to&limit&afterTs&afterSeq&format`

Palauttaa tuntikohtaiset aggregaatit (materialized view), esimerkiksi keskiarvo/min/max ja näytemäärä.

**Query-parametrit**
- `from` / `to` (ISO)
- `limit` (oletus 1000, max 5000)
- `afterTs` (+ `afterSeq` hyväksytään mutta hourly-rajapinnassa `afterSeq` ei vaikuta)
- `format=csv` (valinnainen)

**JSON response**

```json
{
  "deviceId": "pi-01",
  "sensorId": "pi-cpu-temp",
  "from": "...",
  "to": "...",
  "limit": 1000,
  "hasMore": false,
  "nextCursor": null,
  "items": [ ["2026-01-29T12:00:00Z", 45.1, 44.0, 46.2, 60] ]
}
```

**Huom:** `items` on tiivis taulukkomuoto: `[bucketTs, avg, min, max, samples]`.

---

#### 5) Hae / aseta alert trigger (min/max)

`GET /api/devices/{deviceId}/sensors/{sensorId}/trigger?min&max`

Trigger on sallittu vain numeerisille sensoreille.

**Lukutila** (ei `min`/`max` parametreja):
- Palauttaa nykyisen triggerin.
- Jos triggeriä ei ole, `alertTrigger` on `null`.

**Asetustila** (jos `min` tai `max` annetaan):
- Jos parametri on annettu → arvo asetetaan.
- Jos parametri puuttuu → kyseinen raja tyhjennetään (NULL).
- Jos sekä `min` että `max` tyhjennetään → trigger poistetaan.

**JSON response**

```json
{ "deviceId": "pi-01", "sensorId": "pi-cpu-temp", "alertTrigger": { "max": 24 } }
```

---

#### 6) Hae alertit

`GET /api/alert?device_id&sensor_id&open&limit&format`

Listaa alertit.

**Query-parametrit**
- `device_id` (valinnainen)
- `sensor_id` (valinnainen; vaatii `device_id`)
- `open` (valinnainen boolean: `true/false` tai `1/0`)
- `limit` (oletus 50, max 500)
- `format=csv` (valinnainen)

**Semantiikka**
- Jos `open=true` → palauttaa vain avoimet alertit.
- Muuten → palauttaa viimeisimmät alertit siten, että **avoimet alertit tulevat aina ensin** (ennen suljettuja).

**JSON response**

```json
{
  "deviceId": null,
  "sensorId": null,
  "openOnly": false,
  "limit": 50,
  "count": 1,
  "items": [
    {
      "id": 123,
      "triggerId": 10,
      "deviceId": "pi-01",
      "sensorId": "pi-cpu-temp",
      "startTs": "...",
      "endTs": null,
      "reason": "...",
      "context": { "value": 28.1 },
      "createdAt": "...",
      "updatedAt": "...",
      "triggerName": "...",
      "minValue": null,
      "maxValue": 24,
      "triggerEnabled": true
    }
  ],
  "format": "json"
}
```

---

#### Esimerkkikutsut (curl)

```bash
# Devices
curl -H "x-api-code: $API_CODE" "https://<YOUR-SWA-URL>/api/devices"

# Measurements JSON
curl -H "x-api-code: $API_CODE" "https://<YOUR-SWA-URL>/api/devices/pi-01/sensors/pi-cpu-temp/measurements?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=1000"

# Measurements CSV
curl -H "x-api-code: $API_CODE" "https://<YOUR-SWA-URL>/api/devices/pi-01/sensors/pi-cpu-temp/measurements?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&format=csv" -o measurements.csv

# Trigger: set max=24
curl -H "x-api-code: $API_CODE" "https://<YOUR-SWA-URL>/api/devices/pi-01/sensors/pi-cpu-temp/trigger?max=24"

# Alerts: open only
curl -H "x-api-code: $API_CODE" "https://<YOUR-SWA-URL>/api/alert?open=true&limit=50"
```

### Hakemistorakenne (Azure)

Azure-koodi sijaitsee repossa hakemistossa **`<reporoot>/azure`**:

```
azure/
├── functions/               # Azure Functions (TypeScript, build → dist/)
│   ├── src/
│   ├── dist/
│   ├── package.json
│   └── host.json
├── webui/                   # Static Web App -käyttöliittymä
│   ├── index.html
│   ├── app.js
│   ├── graph.js
│   ├── style.css
│   └── api/                 # SWA API-proxy (Functions HTTP)
├── scripts/                 # Azure-resurssien luonti- ja deploy-skriptit
│   ├── 10-*.sh
│   ├── 20-iothub.sh
│   ├── 30-storage.sh
│   ├── 40-postgres.sh
│   ├── 50-functionapp.sh
│   ├── 60-staticwebapp.sh
│   └── azure.sh
├── timescale/               # PostgreSQL / TimescaleDB skeemat (SQL)
│   ├── 00_init_database.sql
│   ├── 10_*.sql
│   └── ...
├── azure.env.example        # Esimerkkikonfiguraatio (kopioi → azure.env)
└── .generated.env           # Skriptien generoima (gitignored)
```

### Azure-konfiguraatio (azure.env)

Azure-skriptit lukevat asetukset tiedostosta **`<reporoot>/azure/azure.env`**.

Aloita kopioimalla esimerkkitiedosto:

```bash
cp azure/azure.env.example azure/azure.env
```

Huom:
- `azure.env` ei kuulu versionhallintaan.
- Skriptit kirjoittavat lisäksi `azure/scripts/.generated.env`-tiedostoon skriptien generoimia arvoja (esim. yhteysmerkkijonot).

### Pakolliset muuttujat (minimi, jotta järjestelmä toimii)

Seuraavat pitää käytännössä aina tarkistaa ja/tai muuttaa omiin arvoihin `azure.env`:ssä:

- `AZURE_SUBSCRIPTION_ID` – mihin subscriptioniin resurssit luodaan
- `AZURE_RESOURCE_GROUP` – resurssiryhmän nimi
- `AZURE_LOCATION` – alue (esim. `northeurope`)
- `IOTHUB_NAME` – IoT Hubin nimi
- `POSTGRES_ADMIN_USER` / `POSTGRES_ADMIN_PASSWORD` – Postgres-palvelimen admin-tunnus
- `POSTGRES_DATABASE` – sovelluksen tietokannan nimi
- `FUNCTIONAPP_NAME` – Function Appin nimi
- `STATICWEBAPP_NAME` – Static Web Appin nimi

Muut muuttujat voi aluksi jättää oletuksiin, mutta ne vaikuttavat esim. jonoihin, säilytysaikoihin ja deploy-polkuun.

### Azure-skriptit ja käyttöönotto

Skriptit sijaitsevat `azure/scripts/`-hakemistossa ja ne ovat idempotentteja (jos resurssi on olemassa, skripti tarkistaa/varmistaa asetukset ja päivittää tarvittaessa).

Tyypillinen ajopolku:

- `10-resourcegroup.sh` (resurssiryhmän luonti)
- `20-iothub.sh` (IoT Hub)
- `30-storage.sh` (Storage account + Queues)
- `40-postgres.sh` (PostgreSQL/Timescale + skeemat `azure/timescale/`)
- `50-functionapp.sh` (Function App + app settings + zip deploy)
- `60-staticwebapp.sh` (SWA env vars + UI deploy)

Lisäksi apuskripti `azure.sh` voi ajaa kaikki vaiheet peräkkäin tai vain osan (esim. vain Function- tai SWA-deploy).

### Deploy-malli (Functions)

Azure Functions deploy tehdään **Zip Deploy** -menetelmällä (Azure CLI), ja build tapahtuu Azuren puolella (Oryx), kun seuraavat ovat päällä:

- `WEBSITE_RUN_FROM_PACKAGE=0`
- `SCM_DO_BUILD_DURING_DEPLOYMENT=1`
- `ENABLE_ORYX_BUILD=true`

Tämä malli välttää tilanteen, jossa Function App näyttää "tyhjältä" (esim. jos build ohitetaan Run-From-Zip/Package -tilassa).
