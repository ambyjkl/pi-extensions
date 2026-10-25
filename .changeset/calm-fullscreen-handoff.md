---
"@narumitw/pi-tui-kit": minor
"@narumitw/pi-starship": patch
"@narumitw/pi-btw": patch
---

Add the opt-in `createFullscreenHandoff()` resource and native test harness. Share terminal entry/exit drain, cancellation-safe restoration, keyboard-protocol recovery, owned overlay handling, and cleanup errors through public Pi TUI APIs. Keep ordinary Kit interactions unchanged.

Use the resource in Starship's configuration chat and BTW's multi-screen workspace. Keep each extension's input policy, layouts, domain state, permissions, and persistence local. BTW now waits for native input drain before entry. Changesets raises both consumer floors to the Kit API release; dependent publication requires its exact registry artifact.
