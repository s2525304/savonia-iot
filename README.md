# savonia-iot
Savonia Iot-ohjelmointi harjoitustyö.


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
