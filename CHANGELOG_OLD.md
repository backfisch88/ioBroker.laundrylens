# Older changelog entries

This file is used by `@alcalzone/release-script` to store changelog entries
that have been moved out of `io-package.json`'s `common.news` section once it
grows too large. There are no older entries yet - see `io-package.json` /
the GitHub releases for the current changelog.

### 0.2.5 (2026-07-14)
- New: separate "Notifications" tab (was previously buried under "Export", which users found unintuitive)
- New: hash-based deep-linking to tabs using numbers (#1-#6), independent of UI language
- New: "availablePrograms" JSON data point per device listing all saved program names, for use in external dropdowns (e.g. VIS)
