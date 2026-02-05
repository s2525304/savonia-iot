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
