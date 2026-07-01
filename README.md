# ioBroker.laundrylens

[![NPM version](https://img.shields.io/npm/v/iobroker.laundrylens.svg)](https://www.npmjs.com/package/iobroker.laundrylens)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-learning ioBroker adapter that monitors household appliances (washing machine, dryer) via smart plug power measurements. Detects cycles, matches power traces against learned programs and estimates remaining time – fully local, no cloud.

---

## Features

- **Cycle detection** via state machine (OFF → STARTING → RUNNING ↔ PAUSED → ENDING)
- **Self-learning program matching**: segment-weighted correlation of the early phase + DTW tiebreak against stored profiles
- **Score accumulation over multiple rounds** with device-specific confidence thresholds, so a single outlier does not trigger a false match
- **Override lock**: manually selected programs are not overwritten by background matching
- **Adaptive remaining time estimation** combining time-based and energy-rate signals
- **Admin UI**: expandable cycle list with inline canvas graph, phase legend, trim (two drag lines) and split (one drag line) via touch/drag
- **Telegram notifications** with configurable update thresholds, placeholders (`{progress}`, `{prevTime}`) and conditional text blocks `[Text {prevTime}]` that are automatically hidden when the placeholder is empty
- **Multiple devices**: any number of devices per adapter instance

### Data points per device

| Data point | Type | Description |
|---|---|---|
| `state` | string | off / starting / running / paused / ending |
| `running` | boolean | Simple on/off indicator |
| `program` | string | Detected program (e.g. "Cotton 60") |
| `confidence` | number | Match confidence in % |
| `timeRemaining` | number | Remaining time in seconds |
| `totalDuration` | number | Estimated total duration in seconds |
| `cycleProgress` | number | Progress 0–100 % |
| `phase` | string | Current phase of the cycle |
| `lastMessage` | string | Last sent Telegram message |
| `lastCycleProgram` | string | Program of the last cycle |
| `lastCycleDuration` | number | Duration of the last cycle in minutes |
| `lastCycleEnergy` | number | Energy consumption of the last cycle in Wh |

---

## Requirements

- ioBroker with js-controller ≥ 5.0.0
- Node.js ≥ 18
- A smart plug / power meter adapter that provides a watt data point per device (e.g. Shelly EM)

---

## Installation

Via the ioBroker admin: **Adapters → ⚙ (top right) → Install from custom URL/GitHub**

```
https://github.com/backfisch88/ioBroker.laundrylens
```

Or via CLI:

```bash
iobroker url https://github.com/backfisch88/ioBroker.laundrylens --allow-root
iobroker add laundrylens --allow-root
```

Then create a separate adapter instance for each device (washing machine, dryer, …) and select the appropriate watt data point in the instance configuration.

---

## Getting started

LaundryLens learns from your devices. There are no pre-built profiles – every program is trained individually on your machine. A few things to keep in mind:

- **Give it time.** The first few cycles of a program will not be reliably detected. Recognition improves with every completed cycle.
- **Start with fewer programs.** The fewer different programs you teach it, the higher the detection accuracy. Start with the 2–3 programs you use most often.
- **Tested on**: washing machine and dryer (Siemens iQ series). Dishwasher and washer-dryer are supported in code but not yet tested in practice – feedback welcome.

---

## Configuration

Each instance has the following settings you can tune if detection does not work well out of the box:

| Setting | Description |
|---|---|
| Power threshold (W) | Minimum wattage for "device is running" detection |
| Off delay (min) | How long to wait after power drops before ending the cycle |
| Start energy gate (Wh) | Prevents short power spikes from being mistaken for a cycle start |
| Duration tolerance | How much the cycle length may deviate from the learned average |
| Match confirmations | How many consecutive rounds a match must hold before it is accepted |
| Auto-confirm threshold (%) | Confidence level at which a match is confirmed automatically |
| Instant-confirm threshold (%) | Confidence level at which a match is accepted immediately (2 rounds in a row) |
| Program detection threshold (%) | Minimum confidence for a program to be considered at all |
| Ignore anti-crease | For dryers with anti-crease phases that would otherwise disturb detection |

The defaults are tuned to work on Siemens iQ appliances. Different brands and models may have very different power curves – that is exactly what these settings are for. There is no single right answer: lowering the detection threshold gives you faster notifications but increases the risk of a wrong match. Finding the right balance takes a bit of experimentation.

---

## Development

```bash
git clone https://github.com/backfisch88/ioBroker.laundrylens.git
cd ioBroker.laundrylens
npm install
npm test
```

### Project structure

```
ioBroker.laundrylens/
├── main.js                  ← Adapter entry point
├── io-package.json          ← Adapter metadata
├── package.json
├── lib/
│   ├── cycleDetector.js     ← State machine
│   ├── mathUtils.js         ← Correlation, DTW-lite
│   ├── profileStore.js      ← Profile matching + persistence
│   ├── traceStore.js        ← Power curve recording
│   └── washDataManager.js   ← Central orchestrator
├── admin/
│   ├── jsonConfig.json      ← Admin UI instance configuration
│   ├── tab_m.html           ← Admin tab (cycle/profile management)
│   └── icon.png
└── tests/
    └── test_basics.js       ← Unit tests
```

Profiles and cycle history are stored via the ioBroker file system (**Admin → Files → laundrylens.0**).

---

## Contributing

Issues and pull requests are welcome: [Issues](https://github.com/backfisch88/ioBroker.laundrylens/issues)

---

## License

MIT License, see [LICENSE](LICENSE).

LaundryLens was originally inspired by the idea of the Home Assistant project [ha_washdata](https://github.com/3dg1luk43/ha_washdata), but has been reimplemented from scratch for ioBroker with its own state machine, matching algorithm and admin UI.
