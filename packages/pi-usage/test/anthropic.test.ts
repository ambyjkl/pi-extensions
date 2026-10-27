import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { UsageRateLimitedError } from "../src/core.js";
import { formatUsageReport, formatUsageStatusline } from "../src/format.js";
import { normalizeAnthropicUsagePayload } from "../src/providers/anthropic.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "../src/query.js";
import type { ResolvedUsageAuth } from "../src/types.js";
import usageExtension from "../src/usage.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const OAUTH_TOKEN = "sk-ant-oat01-secret";
const model = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
};

function anthropicContext(resolved: string, baseUrl?: string) {
  return createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: resolved }),
      getProviderAuth: async () => ({ auth: { apiKey: resolved, ...(baseUrl ? { baseUrl } : {}) } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  }).ctx;
}

const payload = {
  five_hour: { utilization: 2.0, resets_at: "2026-10-28T02:40:00.013762+00:00" },
  seven_day: { utilization: 41.5, resets_at: "2026-10-30T21:00:00+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 10, resets_at: null },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, currency: "USD", decimal_places: 2 },
};

test("anthropic is registered", () => {
  assert.equal(adapterForProvider("anthropic")?.displayName, "Anthropic");
});

test("normalizes utilization windows and extra usage", () => {
  const report = normalizeAnthropicUsagePayload(payload, 123);
  assert.equal(report.semantics.kind, "consumer-subscription");
  assert.deepEqual(report.buckets[0], {
    id: "five-hour",
    label: "5-hour limit",
    used: 2,
    remaining: 98,
    limit: 100,
    unit: "percent",
    windowMinutes: 300,
    resetsAt: Math.floor(Date.parse("2026-10-28T02:40:00.013762+00:00") / 1000),
  });
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five-hour", "weekly", "weekly-sonnet"],
  );
  assert.equal(report.buckets[2]?.resetsAt, undefined);
  assert.deepEqual(report.metrics, [
    { id: "extra-usage-used", label: "Extra usage spent", value: 12.34, unit: "currency", currency: "USD" },
    { id: "extra-usage-limit", label: "Extra usage limit", value: 50, unit: "currency", currency: "USD" },
  ]);
  const formatted = formatUsageReport(report, "current");
  assert.match(formatted, /5-hour limit:\s+\[█{20}\] 98% left/);
  assert.match(formatted, /Weekly limit:\s+.* 59% left/);
  assert.match(formatted, /Extra usage spent:\s+\$12\.34/);
});

test("statusline shows five-hour and weekly remaining with countdowns", () => {
  const report = normalizeAnthropicUsagePayload(payload, 0);
  const now = Date.parse("2026-10-28T00:10:00Z");
  assert.equal(formatUsageStatusline(report, undefined, now), "claude 98% ↻ 2h30m · 59% ↻ 2d20h");
});

test("clamps utilization, ignores disabled extra usage, and rejects missing windows", () => {
  const report = normalizeAnthropicUsagePayload(
    { five_hour: { utilization: 140 }, seven_day: { utilization: -5 }, extra_usage: { is_enabled: false } },
    0,
  );
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.remaining),
    [0, 100],
  );
  assert.deepEqual(report.metrics, []);
  assert.throws(() => normalizeAnthropicUsagePayload({}, 0), /no supported limit window/);
  assert.throws(() => normalizeAnthropicUsagePayload({ five_hour: { utilization: "x" } }, 0), /utilization/);
});

test("resolves only OAuth access tokens on the official origin", async () => {
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const auth = await resolveUsageAuth(anthropicContext(OAUTH_TOKEN), adapter);
  assert.deepEqual(auth?.headers, {
    Authorization: `Bearer ${OAUTH_TOKEN}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  assert.ok(auth?.secrets.includes(OAUTH_TOKEN));
  await assert.rejects(resolveUsageAuth(anthropicContext("sk-ant-api03-key"), adapter), /OAuth login/);
  await assert.rejects(
    resolveUsageAuth(anthropicContext(OAUTH_TOKEN, "https://proxy.example.com"), adapter),
    /proxy-resolved credential/,
  );
});

test("queries the usage endpoint with OAuth headers and redacts failures", async () => {
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const auth: ResolvedUsageAuth = {
    apiKey: OAUTH_TOKEN,
    headers: { Authorization: `Bearer ${OAUTH_TOKEN}`, "anthropic-beta": "oauth-2025-04-20" },
    fingerprint: "f",
    secrets: [OAUTH_TOKEN, `Bearer ${OAUTH_TOKEN}`],
    model: model as never,
  };
  let seen: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen = { url, init };
    return Response.json(payload);
  }) as typeof fetch;
  const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);
  assert.equal(seen?.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(seen?.init?.redirect, "error");
  assert.equal(((seen?.init?.headers ?? {}) as Record<string, string>)["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(report.providerId, "anthropic");

  globalThis.fetch = (async () => new Response(`bad ${OAUTH_TOKEN}`, { status: 401 })) as typeof fetch;
  await assert.rejects(
    queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
    (error: Error) => /401/.test(error.message) && !error.message.includes(OAUTH_TOKEN),
  );
});

test("rate-limit responses carry a clamped Retry-After delay", async () => {
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  const auth: ResolvedUsageAuth = {
    apiKey: OAUTH_TOKEN,
    headers: { Authorization: `Bearer ${OAUTH_TOKEN}` },
    fingerprint: "f",
    secrets: [OAUTH_TOKEN],
    model: model as never,
  };
  for (const [header, retryAfterMs, text] of [
    ["600", 600_000, "10m"],
    [null, 300_000, "5m"],
    ["1", 60_000, "1m"],
    ["999999", 3_600_000, "60m"],
    ["garbage", 300_000, "5m"],
  ] as const) {
    globalThis.fetch = (async () =>
      new Response("slow down", {
        status: 429,
        ...(header ? { headers: { "retry-after": header } } : {}),
      })) as typeof fetch;
    await assert.rejects(queryProviderUsage(adapter, auth, new AbortController().signal, 1_000), (error: unknown) => {
      assert.ok(error instanceof UsageRateLimitedError);
      assert.equal(error.retryAfterMs, retryAfterMs);
      assert.equal(error.message, `Anthropic usage rate limited; retry in ${text}`);
      return true;
    });
  }
});

test("polls Anthropic sparingly and honors a rate limit across forced and scheduled refreshes", async () => {
  vi.useFakeTimers();
  const mock = createMockPi();
  usageExtension(mock.pi);
  const actions = ["Refresh current usage", "Close"];
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model,
    select: async () => actions.shift() ?? "Close",
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: OAUTH_TOKEN } }),
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "Anthropic",
    },
  });
  let requests = 0;
  let throttled = false;
  vi.stubGlobal("fetch", async () => {
    requests += 1;
    return throttled
      ? new Response("slow down", { status: 429, headers: { "retry-after": "600" } })
      : Response.json(payload);
  });
  try {
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requests, 1);
    assert.match(String(statuses.get("usage")), /^claude 98%/u);
    // The default five-minute refresh would have re-requested by now.
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await mock.events.get("turn_start")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requests, 1);

    throttled = true;
    // Each publication restarts the scheduled refresh, so the next one is 15 minutes after the last turn.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    assert.equal(requests, 2, "scheduled refresh after the 15-minute interval");
    assert.match(String(statuses.get("usage")), /^claude 98%/u, "a 429 keeps the stale statusline");

    // Manual refresh and new turns must not extend the throttle with more requests.
    await mock.commands.get("usage")?.handler("", ctx);
    await mock.events.get("turn_start")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requests, 2);
    assert.match(String(statuses.get("usage")), /^claude 98%/u);

    throttled = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await mock.events.get("turn_start")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requests, 3);
    assert.match(String(statuses.get("usage")), /^claude 98%/u);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("a rate limit with no prior report clears the checking status instead of showing an error", async () => {
  vi.useFakeTimers();
  const mock = createMockPi();
  usageExtension(mock.pi);
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: OAUTH_TOKEN } }),
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "Anthropic",
    },
  });
  vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
  try {
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(statuses.get("usage"), undefined);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
