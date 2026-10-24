---
"@narumitw/pi-langfuse": patch
---

Keep OpenTelemetry dependencies compatible with the tracing SDK by bounding the API below 1.10 and declaring the matching OTLP exporter base directly. This prevents runtime import failures from the incompatible exporter release line.
