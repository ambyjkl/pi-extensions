---
"@narumitw/pi-usage": minor
---

Add Anthropic Claude Pro/Max usage reporting with 5-hour and weekly utilization windows, reset countdowns, and extra-usage spend through `/usage` and the statusline. Anthropic API keys and custom base URLs fail before any request. Anthropic usage is cached and refreshed every 15 minutes, and an HTTP 429 keeps the stale statusline and suppresses all further requests until its `Retry-After` delay (default 5 minutes, at most 60) elapses.

Rename the Codex-only `codexStatusPercentage` setting to `statusPercentage` and apply it to every quota-percentage statusline (Anthropic, Codex, Command Code, Kimi, MiniMax, Z.AI, OpenCode Go, GitHub Copilot). The old field is still read when the new one is absent. OpenCode Go previously always showed used percentages and now defaults to remaining like the others.
