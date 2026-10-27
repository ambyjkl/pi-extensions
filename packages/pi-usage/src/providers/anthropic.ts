import type { AnthropicUsagePayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

const WINDOWS = [
  { key: "five_hour", id: "five-hour", label: "5-hour limit", windowMinutes: 300 },
  { key: "seven_day", id: "weekly", label: "Weekly limit", windowMinutes: 10_080 },
  { key: "seven_day_opus", id: "weekly-opus", label: "Weekly Opus limit", windowMinutes: 10_080 },
  { key: "seven_day_sonnet", id: "weekly-sonnet", label: "Weekly Sonnet limit", windowMinutes: 10_080 },
] as const;

/** Normalizes the Claude Pro/Max `GET /api/oauth/usage` response; utilization is a 0–100 used percentage. */
export function normalizeAnthropicUsagePayload(payload: AnthropicUsagePayload, capturedAt: number): UsageReport {
  const buckets: UsageBucket[] = [];
  for (const window of WINDOWS) {
    const value = payload[window.key];
    if (value === null || value === undefined) continue;
    const entry = asObject(value);
    const utilization = asFiniteNumber(entry?.utilization);
    if (utilization === undefined) {
      if (window.key === "five_hour" || window.key === "seven_day") {
        throw new Error(`Anthropic ${window.label.toLowerCase()} utilization was missing or invalid.`);
      }
      continue;
    }
    const used = Math.min(100, Math.max(0, utilization));
    const resetsAt = resetTimestamp(entry?.resets_at);
    buckets.push({
      id: window.id,
      label: window.label,
      used,
      remaining: 100 - used,
      limit: 100,
      unit: "percent",
      windowMinutes: window.windowMinutes,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }

  const metrics: UsageMetric[] = [];
  const extra = asObject(payload.extra_usage);
  if (extra?.is_enabled === true) {
    const currency = typeof extra.currency === "string" && /^[A-Z]{3}$/u.test(extra.currency) ? extra.currency : "USD";
    const decimals = asFiniteNumber(extra.decimal_places);
    const divisor =
      10 ** (decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? decimals : 2);
    const used = asNonnegativeNumber(extra.used_credits);
    const limit = asNonnegativeNumber(extra.monthly_limit);
    if (used !== undefined) {
      metrics.push({
        id: "extra-usage-used",
        label: "Extra usage spent",
        value: used / divisor,
        unit: "currency",
        currency,
      });
    }
    if (limit !== undefined) {
      metrics.push({
        id: "extra-usage-limit",
        label: "Extra usage limit",
        value: limit / divisor,
        unit: "currency",
        currency,
      });
    }
  }

  if (buckets.length === 0) throw new Error("Anthropic usage response contained no supported limit window.");
  return {
    providerId: "anthropic",
    providerName: "Anthropic",
    capturedAt,
    source: "anthropic-oauth-usage",
    semantics: { kind: "consumer-subscription", label: "Claude subscription usage limits" },
    buckets,
    metrics,
  };
}

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : Math.floor(milliseconds / 1000);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number === undefined || number < 0 ? undefined : number;
}
