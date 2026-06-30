# ioBroker.laundrylens

[![NPM version](https://img.shields.io/npm/v/iobroker.laundrylens.svg)](https://www.npmjs.com/package/iobroker.laundrylens)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Überwacht Haushaltsgeräte (Waschmaschine, Trockner) über Smart-Plug-Leistungswerte. Erkennt Zyklen, gleicht erkannte Verläufe gegen gelernte Programme ab und schätzt die Restzeit – vollständig lokal, keine Cloud.

---

## Features

- **Zyklus-Erkennung** via State Machine (OFF → STARTING → RUNNING ↔ PAUSED → ENDING)
- **Selbstlernendes Programm-Matching**: segmentgewichtete Korrelation der frühen Phase + DTW-Tiebreak gegen gespeicherte Profile
- **Score-Akkumulation über mehrere Runden** mit gerätespezifischen Konfidenz-Schwellen, damit ein einzelner Ausreißer keine falsche Erkennung auslöst
- **Override-Sperre**: manuell gewählte Programme werden nicht durch Hintergrund-Matching überschrieben
- **Adaptive Restzeitschätzung** aus Zeit- und Energiesignal kombiniert
- **Admin-UI**: ausklappbare Zyklus-Liste mit Inline-Graph (Canvas), Phasenlegende, Trimmen (zwei Linien) und Teilen (Linie) per Touch/Drag
- **Telegram-Benachrichtigungen** mit konfigurierbaren Update-Schwellen, Platzhaltern (`{progress}`, `{prevTime}`) und bedingten Textblöcken `[Text {prevTime}]`, die automatisch ausgeblendet werden, wenn der Platzhalter leer ist
- **Mehrere Geräte**: beliebig viele Geräte in einer Adapter-Instanz

### Datenpunkte je Gerät

| Datenpunkt | Typ | Beschreibung |
|---|---|---|
| `state` | string | off / starting / running / paused / ending |
| `running` | boolean | Einfacher Ein/Aus-Indikator |
| `program` | string | Erkanntes Programm (z. B. "Baumwolle 60") |
| `confidence` | number | Übereinstimmungs-Konfidenz in % |
| `timeRemaining` | number | Restzeit in Sekunden |
| `totalDuration` | number | Geschätzte Gesamtlaufzeit in Sekunden |
| `cycleProgress` | number | Fortschritt 0–100 % |
| `phase` | string | Aktuelle Phase des Zyklus |
| `lastMessage` | string | Letzte gesendete Telegram-Nachricht |
| `lastCycleProgram` | string | Programm des letzten Zyklus |
| `lastCycleDuration` | number | Dauer des letzten Zyklus in Minuten |
| `lastCycleEnergy` | number | Verbrauch des letzten Zyklus in Wh |

---

## Voraussetzungen

- ioBroker mit js-controller ≥ 5.0.0
- Node.js ≥ 18
- Ein Smart-Plug/Leistungsmesser-Adapter, der pro Gerät einen Watt-Datenpunkt liefert (z. B. Shelly EM)

---

## Installation

Über den ioBroker-Admin: **Adapter → ⚙ (oben rechts) → Benutzerdefiniert von URL/GitHub installieren**

```
https://github.com/backfisch88/ioBroker.laundrylens
```

Oder per CLI:

```bash
iobroker url https://github.com/backfisch88/ioBroker.laundrylens --allow-root
iobroker add laundrylens --allow-root
```

Danach pro Gerät (Waschmaschine, Trockner, …) eine eigene Adapter-Instanz anlegen und in der Instanz-Konfiguration den passenden Leistungs-Datenpunkt auswählen.

---

## Entwicklung

```bash
git clone https://github.com/backfisch88/ioBroker.laundrylens.git
cd ioBroker.laundrylens
npm install
npm test
```

### Projektstruktur

```
ioBroker.laundrylens/
├── main.js                  ← Adapter-Einstiegspunkt
├── io-package.json          ← Adapter-Metadaten
├── package.json
├── lib/
│   ├── cycleDetector.js     ← State Machine
│   ├── mathUtils.js         ← Korrelation, DTW-Lite
│   ├── profileStore.js      ← Profil-Matching + Persistenz
│   ├── traceStore.js        ← Aufzeichnung der Leistungskurven
│   └── washDataManager.js   ← Zentraler Orchestrator
├── admin/
│   ├── jsonConfig.json      ← Admin-UI Instanzkonfiguration
│   ├── tab_m.html           ← Admin-Tab (Zyklus-/Profilverwaltung)
│   └── icon.png
└── tests/
    └── test_basics.js       ← Unit-Tests
```

Profile und Zyklus-Historie werden über das ioBroker-Dateisystem gespeichert (**Admin → Dateien → laundrylens.0**).

> **Tipp**: Lass das Gerät erst einige Zyklen laufen. Der Adapter lernt automatisch die typischen Verläufe und verbessert seine Erkennung mit jedem abgeschlossenen Zyklus.

---

## Mitwirken

Issues und Pull Requests sind willkommen: [Issues](https://github.com/backfisch88/ioBroker.laundrylens/issues)

---

## Lizenz

MIT License, siehe [LICENSE](LICENSE).

LaundryLens ist ursprünglich von der Idee des Home-Assistant-Projekts [ha_washdata](https://github.com/3dg1luk43/ha_washdata) inspiriert, wurde für ioBroker aber als eigenständige Neuentwicklung umgesetzt (eigene State Machine, eigenes Matching, eigene Admin-UI).
