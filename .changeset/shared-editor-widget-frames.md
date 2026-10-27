---
"@narumitw/pi-ticker": patch
"@narumitw/pi-chat": patch
"@narumitw/pi-file-context": patch
---

Use Pi TUI Kit's existing `EditorStatusWidget` for passive editor widgets. Share the muted separator and terminal-width bounds while retaining extension-owned content, refresh scheduling, cleanup, and RPC behavior. Sanitize untrusted display values before styling and wrapping without changing raw payloads.
