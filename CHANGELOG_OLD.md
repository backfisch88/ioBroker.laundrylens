# Older changelog entries

Pre-0.4.0 beta history, moved out of README.md's main Changelog section to
keep that one focused on the current 0.4.x series. See `io-package.json` /
the GitHub releases for the most recent changelog.

### 0.3.0 (2026-07-28)
- New: proper dishwasher phase detection, both live and in the historical cycle graph
- New: email notification support via [ioBroker.email](https://github.com/iobroker-community-adapters/ioBroker.email)
- Fix: `instance` URL parameter and hash-based deep-linking in the admin tab
- Fix: Anti-Knitter checkbox polarity was inverted - "ignorieren" checked/unchecked did the opposite of what it should
- Fix: dryer cycles were cut off immediately on any power drop even with no Anti-Knitter reference pattern saved
- New: delete button for the saved Anti-Knitter reference pattern
- Infrastructure: migrated to the official `@iobroker/eslint-config`, added a real `package-lock.json` and integration test, restructured CI to the current ioBroker workflow template (`check-and-lint`/`adapter-tests`), and reached full compliance with the shared config (Prettier formatting + complete JSDoc coverage, no rules disabled)

### 0.2.8 (2026-07-26)
- New: proper phase detection for dishwashers, both in the historical cycle graph and the live status display (Vorspülen/Hauptspülgang/Klarspülgang/Trocknen based on ordinal heating-block count, instead of a flat per-reading power threshold that mislabeled every heat spike as "Aufheizen")
- Fix: `instance` URL parameter was ignored for initial device pre-selection in the admin tab
- Fix attempt: hash-based deep-linking no longer triggers premature data loading before device discovery completes

### 0.2.7 (2026-07-22)
- Attempted fix: hash-based deep-linking no longer triggers data loading for the target tab before device discovery has completed (visual tab switch only; data loading deferred until devices are known). Addresses a suspected race where early sendTo() calls with an empty deviceId may have interfered with device discovery.

### 0.2.6 (2026-07-22)
- Fix: hash-based deep-linking (`#1`–`#6`) could get stuck showing an empty page when device loading was slow or failed (e.g. standalone access outside Admin). Tab switching via hash now happens immediately on page load, independent of the device data pipeline.

### 0.2.5 (2026-07-14)
- New: separate "Notifications" tab (previously buried under "Export", which testers found unintuitive)
- New: hash-based deep-linking to admin tabs using numbers (`#1`–`#6`), independent of UI language
- New: `availablePrograms` JSON data point per device listing all saved program names, for use in external dropdowns (e.g. VIS program override selector)

### 0.2.4 (2026-07-11)
- Fix: power sensor readings with `ack=false` were silently ignored, causing the adapter to stay "off" forever even at full power. This affects power sensors fed by user scripts (common for `0_userdata.0.*` datapoints) that don't explicitly set `ack: true`.

### 0.2.3 (2026-07-07)
- Fix: `startEnergyThreshold = 0` (and `powerThreshold = 0`) was silently replaced by the default value due to a falsy-zero check — this blocked correct detection for devices with a very low initial power draw (e.g. dishwashers during pump-out)
- Fix: restarting the adapter while the device was already running (with no cycle to restore) could leave the cycle stuck in "starting" instead of resuming "running"

### 0.2.2 (2026-07-01)
- beta release
