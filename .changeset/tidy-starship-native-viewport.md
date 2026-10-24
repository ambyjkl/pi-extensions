---
"@narumitw/pi-starship": minor
---

Move configuration chat to a Starship-owned `TuiAltScreen` with native `ScrollView` history and a fixed editor/preview dock. Suspend the parent TUI while the chat owns the shared terminal and restore ownership before review and save screens.

History paging now uses `tui.altScreen.pageUp` and `tui.altScreen.pageDown` instead of `tui.editor.pageUp` and `tui.editor.pageDown`; move custom history paging bindings to the viewport actions. Agent behavior, draft permissions, and settings/profile storage are unchanged.

Align tool displays with Pi's built-in message/tool event lifecycle, including streamed arguments, partial results, native edit previews, final diffs, errors, and per-tool clicks. Seed expansion from the parent once and keep subsequent changes local across review. Restrict preview reads to the owned draft and prevent late native preview callbacks from redrawing disposed UI.

Document the intentional deviation from Pi's single-renderer guidance and the required lifecycle and physical-terminal checks. This change does not establish a diagnosis or verified fix for the originally reported wheel/key failure.
