# Older changelog entries

Older versions, moved out of README.md. The README keeps the latest 7.

### 0.4.38 (2026-10-04)
- New: feedback flow (Lernkontrolle) usable from VIS (`pendingFeedback*` data points, `feedbackConfirm`, `feedbackCorrectProgram`, `feedbackDelete`)

### 0.4.37 (2026-10-03)
- Fix: checker findings in test mocks, `@iobroker/testing` update

### 0.4.36 (2026-10-03)
- Fix: `needsFeedback` stayed `true` after deleting a cycle or clearing data

### 0.4.35 (2026-10-03)
- Fix: `phaseText` could lag behind `phase`

### 0.4.34 (2026-10-02)
- Fix: `availablePrograms` empty after restart or auto-learning; `needsFeedback` never written

### 0.4.33 (2026-10-02)
- New: option "Show probable program before confirmation", option "Text data points without emoji"
- Fix: stale guess/progress from the previous cycle

### 0.4.32 (2026-09-27)
- Fix: stale `state` data point re-synced at every start

### 0.4.31 (2026-09-27)
- Fix: dryer anti-crease quick-finish left `state` on "Running"

### 0.4.30 - 0.4.28 (2026-09-27)
- Fix: `elapsedTime` stored in seconds; dependency and checker fixes

### 0.4.27 (2026-09-25)
- Fix: German placeholder in the notification-target dropdown; Telegram names HTML-escaped

### 0.4.26 (2026-09-25)
- Fix: early-confirmed program could revert to "detecting..."

### 0.4.25 (2026-09-23)
- New: per-phase duration learning for a better remaining time

### 0.4.24 (2026-09-23)
- Improved: remaining time/progress, especially for dryers

### 0.4.23 (2026-09-16)
- Fix: cycle stayed "running" after a restart when power had already dropped

### 0.4.22 (2026-09-16)
- Fix: per-device "Off delay" was ignored

### 0.4.21 (2026-09-08)
- Fix: remaining German texts translated, language-neutral `matchedProfile`

### 0.4.20 - 0.4.19 (2026-09-08)
- Fix: CI (Node.js 26), `node:` imports, dependency updates

### 0.4.18 (2026-09-02)
- Fix: dryer anti-crease lock could expire during real tumbling

### 0.4.17 (2026-08-31)
- New: `phaseText`, `stateText`, `programText` and a per-device display language

### 0.4.16 - 0.4.15 (2026-08-31)
- New: `{state:objectId}` placeholder in notifications
- Fix: leftover German text, warning for devices sharing a power sensor

### 0.4.14 (2026-08-30)
- Changed: sharper adapter icon

### 0.4.13 - 0.4.12 (2026-08-27)
- Fix: English log messages and state names (existing installs migrated)
- Fix: multiple devices via the `devices` array
- Docs: requirements Node.js >= 22, js-controller >= 6.0.11

### 0.4.11 - 0.4.9 (2026-08-26)
- Fix: "Notify also for probable program" had no effect
- Fix: `ignoreAntiKnitter`, `matchThreshold`, `instantConfirmThreshold` never reached the manager

### 0.4.8 - 0.4.6 (2026-08-16)
- Fix: wrong phase timestamps on dryers, invalid `cycleProgress` role
- Changed: npm Trusted Publishing

### 0.4.5 (2026-08-08)
- Fix: finished cycle could stay "running" when the sensor stopped reporting

### 0.4.1 (2026-07-30)
- Fix: admin tab crash in some browsers; "File tab.html not found" in newer Admin

### 0.4.0 (2026-07-30)
- New: 11 languages for admin UI, notifications and phase names

### 0.3.0 (2026-07-28)
- New: dishwasher phase detection, email notifications, delete button for the Anti-Knitter reference
- Fix: Anti-Knitter checkbox polarity, dryer cycles cut off without a reference pattern

### 0.2.8 - 0.2.2 (2026-07)
- New: dishwasher phases, separate "Notifications" tab, hash deep-linking, `availablePrograms`
- Fix: `ack=false` readings ignored, thresholds of 0 replaced by the default
- 0.2.2: beta release
