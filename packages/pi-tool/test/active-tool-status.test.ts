import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import {
  ACTIVE_TOOL_REFRESH_INTERVAL_MS,
  ACTIVE_TOOL_WIDGET_KEY,
  createActiveToolStatusController,
  formatActiveToolWidget,
  renderActiveToolWidget,
  sanitizeToolName,
} from "../src/active-tool-status.js";

type WidgetFactory = (_tui: never, theme: Theme) => Component;
type WidgetRecord = [string, string[] | WidgetFactory | undefined, { placement: "aboveEditor" } | undefined];

const DIVIDER = "─".repeat(80);
const IDENTITY_THEME = {
  fg: (_role: string, text: string) => text,
} as unknown as Theme;

afterEach(() => {
  vi.useRealTimers();
});

function toolInfo(name: string, overrides: Partial<ToolInfo> = {}): ToolInfo {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    exposure: "direct",
    sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
    ...overrides,
  };
}

function createHarness(initialTools: string[] = []) {
  let activeTools = initialTools;
  let configuredTools = initialTools.map((name) => toolInfo(name));
  const pi = {
    getActiveTools() {
      return [...activeTools];
    },
    getAllTools() {
      return [...configuredTools];
    },
  } as unknown as ExtensionAPI;
  return {
    controller: createActiveToolStatusController(pi),
    setActiveTools(toolNames: string[]) {
      activeTools = toolNames;
      configuredTools = toolNames.map((name) => toolInfo(name));
    },
    setConfiguredTools(tools: ToolInfo[]) {
      configuredTools = tools;
    },
  };
}

function createContext(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  const widgets: WidgetRecord[] = [];
  const sessionManager = {} as ExtensionContext["sessionManager"];
  const ctx = {
    mode,
    hasUI,
    sessionManager,
    ui: {
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement: "aboveEditor" }) {
        widgets.push([key, content, options]);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets };
}

function renderWidgetRecord(record: WidgetRecord | undefined, width = 80): WidgetRecord | undefined {
  if (!record) return undefined;
  const [key, content, options] = record;
  const rendered = typeof content === "function" ? content(undefined as never, IDENTITY_THEME).render(width) : content;
  return [key, rendered, options];
}

test("stays off by default and can start, refresh, and stop in the owned session", async () => {
  vi.useFakeTimers();
  const harness = createHarness(["read", "bash"]);
  const current = createContext();
  harness.controller.start(current.ctx, false);
  assert.deepEqual(current.widgets, []);

  harness.controller.setEnabled(current.ctx, true);
  assert.deepEqual(renderWidgetRecord(current.widgets.at(-1)), [
    ACTIVE_TOOL_WIDGET_KEY,
    [DIVIDER, "Tools (2)", "Built-in (2): read · bash"],
    { placement: "aboveEditor" },
  ]);

  harness.setActiveTools(["read", "edit", "write"]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.deepEqual(renderWidgetRecord(current.widgets.at(-1)), [
    ACTIVE_TOOL_WIDGET_KEY,
    [DIVIDER, "Tools (3)", "Built-in (3): read · edit · write"],
    { placement: "aboveEditor" },
  ]);

  harness.controller.setEnabled(current.ctx, false);
  assert.deepEqual(current.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);
  const countAfterDisable = current.widgets.length;
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  assert.equal(current.widgets.length, countAfterDisable);
});

test("session replacement clears the old widget and ignores stale shutdown", () => {
  const harness = createHarness(["read"]);
  const previous = createContext();
  const current = createContext();
  harness.controller.start(previous.ctx, true);
  harness.controller.start(current.ctx, true);
  assert.deepEqual(previous.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);

  harness.controller.shutdown(previous.ctx);
  assert.equal(harness.controller.isEnabled(), true);
  harness.controller.shutdown(current.ctx);
  assert.deepEqual(current.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);
});

test("keeps RPC widget content as plain strings and does nothing without UI", () => {
  const harness = createHarness(["read"]);
  const rpc = createContext("rpc");
  harness.controller.start(rpc.ctx, true);
  assert.deepEqual(rpc.widgets.at(-1), [
    ACTIVE_TOOL_WIDGET_KEY,
    ["Tools (1)", "Built-in (1): read"],
    { placement: "aboveEditor" },
  ]);
  const print = createContext("print", false);
  harness.controller.start(print.ctx, true);
  assert.deepEqual(print.widgets, []);
  harness.controller.shutdown(print.ctx);
});

test("renders a muted divider and wraps every safe tool name within the available width", () => {
  const roles: string[] = [];
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return text;
    },
  } as unknown as Theme;
  const lines = renderActiveToolWidget(
    ["Active tools (6)", "read · bash · edit · write · runtime_diagnostics · subagent_spawn"],
    theme,
    40,
  );

  assert.deepEqual(lines.map(stripTerminalSequences), [
    "─".repeat(40),
    "Active tools (6)",
    "read · bash · edit · write ·",
    "runtime_diagnostics · subagent_spawn",
  ]);
  assert.deepEqual(roles, ["borderMuted"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test.each([0, 1, 2, 12, 80, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 12.9])(
  "keeps wrapping and row bounds at width %s",
  (width) => {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const body = ["Active tools (3)", "read · 界界 · e\u0301_tool"];
    const wrapped = normalized === 0 ? body.map(() => "") : body.flatMap((line) => wrapTextWithAnsi(line, normalized));
    const lines = renderActiveToolWidget(body, IDENTITY_THEME, width);
    assert.deepEqual(lines, ["─".repeat(normalized), ...wrapped.map((line) => truncateToWidth(line, normalized, ""))]);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    if (normalized === 0) assert.deepEqual(lines, ["", "", ""]);
  },
);

test("uses the callback theme after resize and invalidation without republishing unchanged tools", async () => {
  vi.useFakeTimers();
  const harness = createHarness(["read", "bash"]);
  const current = createContext();
  harness.controller.start(current.ctx, true);
  const factory = current.widgets.at(-1)?.[1];
  assert.equal(typeof factory, "function");
  if (typeof factory !== "function") return;
  let color = "\u001b[31m";
  const fg = vi.fn((_role: string, text: string) => `${color}${text}\u001b[0m`);
  const component = factory(undefined as never, { fg } as unknown as Theme);
  for (const width of [0, 1, 40, 80, 12]) {
    const lines = component.render(width);
    assert.equal(stripTerminalSequences(lines[0] ?? ""), "─".repeat(width));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width === 0) assert.deepEqual(lines, ["", "", ""]);
    else assert.ok(fg.mock.calls.some(([role, text]) => role === "borderMuted" && text === "─".repeat(width)));
  }
  color = "\u001b[32m";
  component.invalidate();
  assert.equal(component.render(80)[0], `${color}${DIVIDER}\u001b[0m`);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  harness.controller.refresh(current.ctx);
  assert.equal(current.widgets.length, 1);
  harness.controller.shutdown(current.ctx);
  harness.controller.shutdown(current.ctx);
  assert.equal(vi.getTimerCount(), 0);
  const writes = current.widgets.length;
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  assert.equal(current.widgets.length, writes);
});

test("groups active and codemode tools in source order and counts each raw name once", () => {
  const tools = [
    toolInfo("deploy", {
      sourceInfo: { path: "/extensions/deploy.ts", source: "local", scope: "user", origin: "top-level" },
    }),
    toolInfo("read"),
    toolInfo("mcp__docs__search", { exposure: "codemode", namespace: { name: "mcp__docs" } }),
    toolInfo("bash"),
  ];
  assert.deepEqual(formatActiveToolWidget(["deploy", "read", "bash", "read", "mcp__docs__search"], tools), [
    "Tools (4)",
    "Built-in (2): read · bash",
    "MCP (1): docs (1)",
    "Extension (1): deploy",
  ]);
  const mcpTool = tools[2];
  assert.ok(mcpTool);
  assert.deepEqual(formatActiveToolWidget([], [mcpTool]), ["Tools (1)", "MCP (1): docs (1)"]);
  assert.equal(formatActiveToolWidget([], []), undefined);
});

test.each([
  ["direct", false, false],
  ["direct", true, true],
  ["model-only", false, false],
  ["model-only", true, true],
  ["codemode", false, true],
  ["codemode", true, true],
  ["deferred", false, true],
  ["deferred", true, true],
  ["hidden", false, false],
  ["hidden", true, false],
] as const)("exposure %s with active=%s has visible=%s", (exposure, active, visible) => {
  const content = formatActiveToolWidget(active ? ["example"] : [], [toolInfo("example", { exposure })]);
  assert.deepEqual(
    content,
    visible
      ? [
          "Tools (1)",
          `Built-in (1): example${exposure === "codemode" || exposure === "deferred" ? ` [${exposure}]` : ""}`,
        ]
      : undefined,
  );
});

test.each([
  ["read", "builtin:read", "builtin", undefined, "Built-in"],
  ["codemode", "builtin:codemode", "builtin", undefined, "Built-in"],
  ["tool_search", "builtin:tool-search", "builtin", undefined, "Built-in"],
  ["mcp__docs__search", "builtin:mcp", "builtin", "mcp__docs", "MCP"],
  ["list_mcp_resources", "builtin:mcp", "builtin", undefined, "MCP"],
  ["custom_search", "/extensions/adapter.ts", "local", "mcp__docs", "MCP"],
  ["mcp__not_a_server__search", "/extensions/example.ts", "local", undefined, "Extension"],
  ["read", "/extensions/read.ts", "npm:custom-read", undefined, "Extension"],
  ["deploy", "/extensions/deploy.ts", "local", "deployment", "Extension"],
  ["custom", "<sdk:custom>", "sdk", undefined, "Extension"],
] as const)("groups %s from %s by metadata", (name, path, source, namespace, group) => {
  const tool = toolInfo(name, {
    sourceInfo: { path, source, scope: "temporary", origin: "top-level" },
    ...(namespace ? { namespace: { name: namespace } } : {}),
  });
  const label = group === "MCP" ? `${namespace?.replace(/^mcp__/, "") ?? "Other"} (1)` : name;
  assert.deepEqual(formatActiveToolWidget([name], [tool]), ["Tools (1)", `${group} (1): ${label}`]);
});

test.each([
  ["codemode", "deferred"],
  ["deferred", "deferred"],
  ["direct", "direct"],
  ["hidden", "hidden"],
] as const)(
  "shows MCP %s tools using the installed adapter's %s exposure",
  async (configuredExposure, runtimeExposure) => {
    // Use Pi's real adapter: MCP config exposure and public ToolInfo exposure are not equivalent.
    const adapterPath = new URL("extensions/mcp/tools.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
    const { toToolExposure } = await import(adapterPath);
    const exposure = toToolExposure(configuredExposure);
    assert.equal(exposure, runtimeExposure);
    const harness = createHarness(["codemode"]);
    harness.setConfiguredTools([
      toolInfo("codemode", { exposure: "model-only" }),
      ...["mcp__docs__search", "list_mcp_resources"].map((name) =>
        toolInfo(name, {
          exposure,
          sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
          ...(name === "mcp__docs__search" ? { namespace: { name: "mcp__docs" } } : {}),
        }),
      ),
    ]);
    const current = createContext("rpc");
    try {
      harness.controller.start(current.ctx, true);
      assert.deepEqual(current.widgets.at(-1)?.[1], [
        `Tools (${runtimeExposure === "deferred" ? 3 : 1})`,
        "Built-in (1): codemode",
        ...(runtimeExposure === "deferred" ? ["MCP (2): docs (1) · Other (1)"] : []),
      ]);
    } finally {
      harness.controller.shutdown(current.ctx);
    }
  },
);

test("keeps active names without metadata in the Extension fallback group", () => {
  assert.deepEqual(formatActiveToolWidget(["unknown"], []), ["Tools (1)", "Extension (1): unknown"]);
});

test("polls source and exposure changes even when the active names do not change", async () => {
  vi.useFakeTimers();
  const harness = createHarness(["read"]);
  const current = createContext("rpc");
  harness.controller.start(current.ctx, true);
  const mcpTool = toolInfo("search", { exposure: "deferred", namespace: { name: "mcp__docs" } });
  harness.setConfiguredTools([toolInfo("read"), mcpTool]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.deepEqual(current.widgets.at(-1)?.[1], ["Tools (2)", "Built-in (1): read", "MCP (1): docs (1)"]);
  harness.setConfiguredTools([
    toolInfo("read"),
    { ...mcpTool, namespace: { name: "mcp__updated" } },
    toolInfo("fetch", { exposure: "codemode", namespace: { name: "mcp__updated" } }),
  ]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.deepEqual(current.widgets.at(-1)?.[1], ["Tools (3)", "Built-in (1): read", "MCP (2): updated (2)"]);
  harness.setConfiguredTools([
    toolInfo("read", {
      sourceInfo: { path: "/extensions/read.ts", source: "local", scope: "user", origin: "top-level" },
    }),
    { ...mcpTool, exposure: "hidden" },
  ]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.deepEqual(current.widgets.at(-1)?.[1], ["Tools (1)", "Extension (1): read"]);
  harness.setConfiguredTools([toolInfo("read", { exposure: "hidden" })]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.equal(current.widgets.at(-1)?.[1], undefined);
  harness.controller.shutdown(current.ctx);
  assert.equal(vi.getTimerCount(), 0);
});

test("summarizes a large MCP catalog without listing tool names or repeated exposure markers", () => {
  const tools = [
    toolInfo("read"),
    ...Array.from({ length: 33 }, (_, index) =>
      toolInfo(`mcp__chrome_devtools__tool_${index}`, {
        exposure: "deferred",
        namespace: { name: "mcp__chrome_devtools" },
      }),
    ),
    ...Array.from({ length: 25 }, (_, index) =>
      toolInfo(`mcp__alphaxiv__tool_${index}`, { exposure: "codemode", namespace: { name: "mcp__alphaxiv" } }),
    ),
    ...Array.from({ length: 27 }, (_, index) =>
      toolInfo(`mcp__firecrawl__tool_${index}`, { exposure: "deferred", namespace: { name: "mcp__firecrawl" } }),
    ),
    ...["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].map((name) =>
      toolInfo(name, {
        exposure: "deferred",
        sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
      }),
    ),
    toolInfo("hidden", { exposure: "hidden", namespace: { name: "mcp__chrome_devtools" } }),
    toolInfo("inactive", { namespace: { name: "mcp__chrome_devtools" } }),
  ];
  const body = formatActiveToolWidget(["read", "mcp__chrome_devtools__tool_0"], tools);
  assert.deepEqual(body, [
    "Tools (89)",
    "Built-in (1): read",
    "MCP (88): chrome_devtools (33) · alphaxiv (25) · firecrawl (27) · Other (3)",
  ]);
  assert.equal(renderActiveToolWidget(body, IDENTITY_THEME, 80).length, 4);
});

test("sanitizes MCP namespace labels without changing their raw metadata", () => {
  const namespace = "mcp__\u001b[31mdocs\n\u001b[0m";
  const tools = [toolInfo("search", { exposure: "deferred", namespace: { name: namespace } })];
  assert.deepEqual(formatActiveToolWidget([], tools), ["Tools (1)", "MCP (1): docs (1)"]);
  assert.equal(tools[0]?.namespace?.name, namespace);
});

test("renders grouped codemode content safely at zero, narrow, and wide widths", () => {
  const body = formatActiveToolWidget(
    ["read", "界界"],
    [toolInfo("read"), toolInfo("界界", { namespace: { name: "mcp__docs" }, exposure: "codemode" })],
  );
  assert.ok(body);
  for (const width of [0, 1, 2, 12, 40, 80]) {
    const lines = renderActiveToolWidget(body, IDENTITY_THEME, width);
    assert.equal(lines[0], "─".repeat(width));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("formats every tool as bounded safe display text without changing raw names", () => {
  const names = ["read", "bash", "edit", "write"];
  assert.deepEqual(
    formatActiveToolWidget(
      names,
      names.map((name) => toolInfo(name)),
    ),
    ["Tools (4)", "Built-in (4): read · bash · edit · write"],
  );
  const rawName = "read\n\u001b[31m";
  const tool = toolInfo(rawName, { exposure: "codemode" });
  assert.deepEqual(formatActiveToolWidget([], [tool]), ["Tools (1)", "Built-in (1): read [codemode]"]);
  assert.equal(tool.name, rawName);
  assert.equal(sanitizeToolName("\u001b]8;;bad\u0007read\n\u202efile"), "readfile");
  assert.equal(sanitizeToolName("\u001b\u0007"), "tool");
  assert.equal(sanitizeToolName("x".repeat(40)), `${"x".repeat(32)}…`);
});
