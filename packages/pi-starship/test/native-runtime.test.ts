import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { StarshipCommandOptions } from "../src/commands.js";
import { nativeFooterConfig, validateConfigDocument } from "../src/config.js";
import type { WorkspaceExec } from "../src/runtime/workspace.js";

let commandOptions: StarshipCommandOptions | undefined;
vi.mock("../src/commands.js", () => ({
  handleStarshipCommand: async (_args: string, _ctx: unknown, options: StarshipCommandOptions) => {
    commandOptions = options;
  },
}));

const roots: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function setup(document?: string) {
  const root = mkdtempSync(join(tmpdir(), "starship-native-runtime-"));
  roots.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, "pi-starship.toml");
  if (document !== undefined) writeFileSync(path, document);
  vi.resetModules();
  commandOptions = undefined;
  const { default: piStarship } = await import("../src/pi-starship.js");
  const mock = createMockPi();
  const exec = vi.fn<WorkspaceExec>(async () => ({ stdout: "", stderr: "", code: 1, killed: false }));
  piStarship(mock.pi, { gitExec: exec, githubPrExec: exec });
  const context = createMockContext({ mode: "tui", hasUI: true });
  const emit = async (name: string, ctx = context.ctx) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
  };
  await emit("session_start");
  await mock.commands.get("starship")?.handler("status", context.ctx);
  return { root, path, mock, context, emit, exec, options: capturedOptions() };
}

function capturedOptions(): StarshipCommandOptions {
  assert.ok(commandOptions);
  return commandOptions;
}

function mount(context: ReturnType<typeof createMockContext>) {
  const unsubscribe = vi.fn();
  let branchChange: (() => void) | undefined;
  const factory = context.footer as NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
  const component = factory(
    { requestRender() {} } as never,
    { colors: {} } as never,
    {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      onBranchChange: (callback: () => void) => {
        branchChange = callback;
        return unsubscribe;
      },
    } as never,
  );
  return { component, unsubscribe, branchChange: () => branchChange?.() };
}

const custom = () => validateConfigDocument("preset.toml", "format = 'custom footer'\n");

test("missing settings retain the native footer without timers, collectors, or file creation", async () => {
  vi.useFakeTimers();
  const state = await setup();
  assert.equal(state.context.footer, undefined);
  assert.equal(state.exec.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(existsSync(state.path), false);
  await state.emit("agent_end");
  await state.emit("session_tree");
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(state.exec.mock.calls.length, 0);
  await state.emit("session_shutdown");
  await state.emit("session_shutdown");
});

test("invalid settings still install the custom fallback and warn", async () => {
  const state = await setup("format = [\n");
  assert.equal(typeof state.context.footer, "function");
  assert.equal(state.context.notifications.length, 1);
  await state.emit("session_shutdown");
});

test("native restore releases footer resources and permits a later preset without invalidating the menu", async () => {
  vi.useFakeTimers();
  const state = await setup();
  const owner = state.options.getMenuOwner?.();
  state.options.apply(custom(), state.context.ctx);
  const mounted = mount(state.context);
  assert.ok(vi.getTimerCount() > 0);
  state.options.apply(nativeFooterConfig(state.path), state.context.ctx);
  assert.equal(state.context.footer, undefined);
  assert.equal(mounted.unsubscribe.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
  mounted.branchChange();
  mounted.component.dispose?.();
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(owner?.isCurrent(), true);
  state.options.apply(custom(), state.context.ctx);
  const replacement = mount(state.context);
  assert.deepEqual(replacement.component.render(80), ["custom footer"]);
  await state.emit("session_shutdown");
  assert.equal(replacement.unsubscribe.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("preview cancellation returns to native and shutdown rejects stale preview or apply", async () => {
  vi.useFakeTimers();
  const state = await setup();
  state.options.preview?.(custom(), state.context.ctx);
  const preview = mount(state.context);
  assert.deepEqual(preview.component.render(80), ["custom footer"]);
  state.options.preview?.(undefined, state.context.ctx);
  assert.equal(state.context.footer, undefined);
  assert.equal(preview.unsubscribe.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
  state.options.preview?.(custom(), state.context.ctx);
  const pending = mount(state.context);
  await state.emit("session_shutdown");
  state.options.preview?.(custom(), state.context.ctx);
  assert.equal(state.context.footer, undefined);
  assert.throws(() => state.options.apply(custom(), state.context.ctx), /replaced/u);
  assert.equal(pending.unsubscribe.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("session replacement releases preview resources and ignores its stale cancellation", async () => {
  vi.useFakeTimers();
  const state = await setup();
  state.options.preview?.(custom(), state.context.ctx);
  const preview = mount(state.context);
  const replacement = createMockContext({ mode: "tui", hasUI: true });
  await state.emit("session_start", replacement.ctx);
  assert.equal(preview.unsubscribe.mock.calls.length, 1);
  assert.equal(state.context.footer, undefined);
  assert.equal(replacement.footer, undefined);
  state.options.preview?.(undefined, state.context.ctx);
  state.options.apply(custom(), replacement.ctx);
  const mounted = mount(replacement);
  state.options.preview?.(undefined, state.context.ctx);
  assert.equal(typeof replacement.footer, "function");
  await state.emit("session_shutdown", replacement.ctx);
  assert.equal(mounted.unsubscribe.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("native restore aborts pending collectors and rejects late publication", async () => {
  vi.useFakeTimers();
  const state = await setup();
  let resolve: ((value: Awaited<ReturnType<WorkspaceExec>>) => void) | undefined;
  const pending = new Promise<Awaited<ReturnType<WorkspaceExec>>>((done) => {
    resolve = done;
  });
  const signals: AbortSignal[] = [];
  state.exec.mockImplementation(async (_command, _args, options) => {
    if (options.signal) signals.push(options.signal);
    return pending;
  });
  state.options.apply(validateConfigDocument(state.path, "format = '$github_pr$git_branch'\n"), state.context.ctx);
  const mounted = mount(state.context);
  assert.ok(signals.length >= 2);
  state.options.apply(nativeFooterConfig(state.path), state.context.ctx);
  assert.ok(signals.every((signal) => signal.aborted));
  resolve?.({ stdout: "", stderr: "", code: 1, killed: false });
  await pending;
  await Promise.resolve();
  mounted.branchChange();
  assert.equal(state.context.footer, undefined);
  assert.equal(vi.getTimerCount(), 0);
  await state.emit("session_shutdown");
});
