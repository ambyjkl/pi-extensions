import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  createSettingsChatComponent,
  SettingsChatEditor,
  settingsChatReviewInput,
  showSettingsChat,
} from "../src/settings-chat-ui.js";
import { createSettingsDraft } from "../src/settings-draft.js";
import { response, settingsChatCustom, testModel } from "./settings-chat-support.js";

function fixture(
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"] = () =>
    response([{ type: "text", text: "Preview updated\x1b]52;c;secret\x07" }]),
) {
  const root = mkdtempSync(join(tmpdir(), "starship-ui-test-"));
  const controller = new AbortController();
  const draft = createSettingsDraft({
    settingsPath: join(root, "pi-starship.toml"),
    baseline: undefined,
    packageRoot: resolve(import.meta.dirname, ".."),
    isCurrent: () => !controller.signal.aborted,
    onPreview() {},
  });
  const agent = new Agent({ initialState: { model: { ...testModel, input: ["text"] }, tools: draft.tools }, streamFn });
  const tui = createTuiHarness({ rows: 32 });
  const overlayOptions: unknown[] = [];
  const ctx = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: settingsChatCustom(tui.custom, (options) => overlayOptions.push(options)),
  }).ctx as ExtensionCommandContext;
  const state = { input: "", error: "" };
  const running = showSettingsChat(
    ctx,
    agent,
    draft,
    state,
    { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
    () => ["FOOTER PREVIEW"],
  );
  return {
    root,
    controller,
    draft,
    agent,
    tui,
    state,
    running,
    overlayOptions,
    async dispose() {
      controller.abort();
      tui.dispose();
      await running;
      agent.abort();
      await agent.waitForIdle();
      draft.dispose();
      rmSync(root, { force: true, recursive: true });
    },
  };
}

test("editor border labels preserve native hidden-line indicators", () => {
  class NativeEditor extends Editor {
    borders(width: number, hidden: number) {
      return [this.renderTopBorder(width, hidden), this.renderBottomBorder(width, hidden)];
    }
  }
  class LabeledEditor extends SettingsChatEditor {
    borders(width: number, hidden: number) {
      return [this.renderTopBorder(width, hidden), this.renderBottomBorder(width, hidden)];
    }
  }
  const tui = { requestRender() {} } as ConstructorParameters<typeof Editor>[0];
  const theme = { fg: (_role: string, value: string) => value } as ConstructorParameters<typeof SettingsChatEditor>[1];
  const plain = (value: string) => value;
  const native = new NativeEditor(tui, {
    borderColor: plain,
    selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
  });
  const labeled = new LabeledEditor(tui, theme, () => ({ top: "pi-starship", bottom: "Valid · unsaved" }));
  for (const width of [0, 1, 5, 80]) {
    for (const hidden of [1, 12, 100]) assert.deepEqual(labeled.borders(width, hidden), native.borders(width, hidden));
    assert.ok(labeled.borders(width, 0).every((line) => visibleWidth(line) <= width));
  }
});

test("fullscreen dock handles zero dimensions, callback theme changes, and read-only preview", async () => {
  const f = fixture();
  const roles: string[] = [];
  const dimLabels: string[] = [];
  type Options = Parameters<typeof createSettingsChatComponent>[0];
  const terminal = { rows: 40 };
  let previewLines = ["read-only footer"];
  const previewWidths: number[] = [];
  const component = createSettingsChatComponent({
    agent: f.agent,
    draft: f.draft,
    state: f.state,
    tui: { terminal, requestRender() {} } as Options["tui"],
    theme: {
      fg: (role: string, value: string) => {
        roles.push(role);
        if (role === "dim") dimLabels.push(value);
        return value;
      },
      bold: (value: string) => value,
    } as Options["theme"],
    keybindings: getKeybindings() as unknown as Options["keybindings"],
    signal: f.controller.signal,
    preview: (width) => {
      previewWidths.push(width);
      return previewLines;
    },
    complete() {},
  });
  try {
    await f.tui.waitForOpen();
    component.focused = true;
    assert.equal(component.focused, true);
    assert.deepEqual(component.render(0), []);
    const frame = component.render(80);
    assert.equal(frame.length, 40);
    assert.equal(frame.filter((line) => /^─+$/u.test(line)).length, 0);
    const previewRow = frame.findIndex((line) => line.includes("read-only footer"));
    assert.ok(!frame.some((line) => /─ Preview /u.test(line)));
    assert.equal(previewRow, frame.length - 1);
    assert.match(frame[previewRow - 3], /^─ pi-starship ─+$/u);
    assert.match(frame[previewRow - 1], /^─ Valid · unsaved · Cancel review · Ctrl\+C discard ─+$/u);
    assert.ok(dimLabels.some((label) => label.includes("pi-starship")));
    assert.ok(dimLabels.some((label) => label.includes("Valid · unsaved")));
    assert.ok(!frame.some((line) => line.includes("Active file unchanged")));
    assert.ok(previewWidths.every((width) => width === 80));
    assert.ok(roles.includes("borderMuted") && roles.includes("dim"));
    const calls = roles.length;
    component.invalidate();
    component.render(80);
    assert.ok(roles.length > calls);
    assert.ok(!frame.find((line) => line.includes("read-only footer"))?.includes("→"));
    previewLines = ["PREVIEW-FIRST", "\x1b[31mPREVIEW-SECOND 中文\x1b[39m"];
    for (const [rows, shown] of [
      [4, 0],
      [6, 2],
      [7, 2],
      [8, 2],
      [12, 2],
      [40, 2],
    ]) {
      terminal.rows = rows;
      const resized = component.render(80);
      assert.ok(resized.length <= rows);
      const start = resized.findIndex((line) => line.includes("PREVIEW-FIRST"));
      if (shown > 0) {
        assert.ok(start >= 0);
        assert.ok(!resized.some((line) => /─ Preview /u.test(line)));
        assert.equal(resized[start + 1], previewLines[1]);
        assert.equal(start + shown, resized.length);
      } else {
        assert.equal(start, -1);
        assert.ok(!resized.some((line) => line.includes("PREVIEW-SECOND")));
      }
      assert.ok(resized.some((line) => line.includes(CURSOR_MARKER)));
    }
    terminal.rows = 40;
    previewLines = ["ONE", "TWO", "THREE", "FOUR", "FIVE"];
    assert.deepEqual(component.render(80).slice(-5), previewLines);
    f.state.error = "Provider error\x1b]52;c;secret\x07";
    const failed = component.render(80);
    assert.match(failed.join("\n"), /─ Agent error · unsaved/u);
    assert.ok(failed.includes("Provider error"));
    assert.deepEqual(failed.slice(-5), previewLines);
    assert.ok(!failed.join("\n").includes("\x1b]52"));
    terminal.rows = 0;
    assert.deepEqual(component.render(80), []);
  } finally {
    component.dispose();
    await component.waitForPending();
    await f.dispose();
  }
});

test("chat retains native editing, expanded paste, focus, bounded framing, and sanitized conversation", async () => {
  let submitted = "";
  const f = fixture((_model, context) => {
    const last = context.messages.at(-1);
    if (last?.role === "user")
      submitted =
        typeof last.content === "string"
          ? last.content
          : last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return response([{ type: "text", text: "Safe reply\x1b]52;c;secret\x07" }]);
  });
  try {
    await f.tui.waitForOpen();
    assert.deepEqual(f.overlayOptions, [
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
    ]);
    assert.equal(f.tui.isFocusable, true);
    f.tui.setFocused(true);
    assert.equal(f.tui.focused, true);
    assert.match(f.tui.render().join("\n"), /FOOTER PREVIEW/u);
    const previewRow = f.tui.render().findIndex((line) => line.includes("FOOTER PREVIEW"));
    f.tui.type("abc");
    f.tui.send("\x7f");
    const paste = "line\n".repeat(40);
    f.tui.send(`\x1b[200~${paste}\x1b[201~`);
    f.tui.send("\r");
    await f.tui.waitForPending();
    assert.equal(submitted, `ab${paste}`.trim());
    assert.ok(!submitted.includes("[paste #"));
    const frame = f.tui.render();
    assert.equal(frame.length, 32);
    assert.equal(
      frame.findIndex((line) => line.includes("FOOTER PREVIEW")),
      previewRow,
    );
    assert.ok(!frame.join("\n").includes("\x1b]52"));
    for (const rows of [4, 8, 24])
      for (const width of [1, 5, 80]) {
        f.tui.resize({ rows, width: Math.max(1, width) });
        const lines = f.tui.render(width);
        assert.ok(lines.length <= rows);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width > 5) assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
      }
    f.tui.invalidate();
    f.tui.send("\x1b");
    assert.equal(await f.running, "review");
    assert.equal(existsSync(join(f.root, "pi-starship.toml")), false);
  } finally {
    await f.dispose();
  }
});

test("fragmented paste never triggers cancellation and preserves the unsubmitted editor draft", async () => {
  const f = fixture();
  try {
    await f.tui.waitForOpen();
    f.tui.send("\x1b[200~hello");
    f.tui.send("\x03");
    f.tui.send("\x1b[201~");
    assert.equal(f.tui.isOpen, true);
    f.tui.send("\x1b");
    assert.equal(await f.running, "review");
    assert.equal(f.state.input, "hello");
  } finally {
    await f.dispose();
  }
});

for (const exit of ["escape", "hard cancel", "disposal", "owner abort"] as const) {
  test(`active response cancels and settles on ${exit}`, async () => {
    let ready!: () => void;
    const started = new Promise<void>((done) => {
      ready = done;
    });
    let aborted = false;
    const f = fixture((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          void response([], "aborted")
            .result()
            .then((error) => stream.push({ type: "error", reason: "aborted", error }));
        },
        { once: true },
      );
      ready();
      return stream;
    });
    try {
      await f.tui.waitForOpen();
      f.tui.type("Wait");
      f.tui.send("\r");
      await started;
      assert.match(f.tui.render().join("\n"), /Working/u);
      if (exit === "escape") {
        f.tui.send("\x1b");
        await f.tui.waitForPending();
        assert.equal(f.tui.isOpen, true);
        f.tui.send("\x1b");
      } else if (exit === "hard cancel") f.tui.send("\x03");
      else if (exit === "disposal") f.tui.dispose();
      else f.controller.abort();
      const result = await f.running;
      assert.equal(result, exit === "escape" ? "review" : "discard");
      assert.equal(aborted, true);
      assert.equal(f.agent.state.isStreaming, false);
    } finally {
      await f.dispose();
    }
  });
}

for (const [name, configured, packet, kitty, expected] of [
  ["alias", "esc", "\x1b", false, true],
  ["plain text collision", "x", "x", false, false],
  ["Kitty text collision", "x", "\x1b[120u", true, false],
  ["modifyOtherKeys text collision", "shift+x", "\x1b[27;2;120~", false, false],
  ["native shift delete", "shift+delete", "\x1b[3;2~", false, false],
  ["native alt enter", "alt+enter", "\x1b\r", false, false],
  ["native LF newline", "ctrl+j", "\n", false, false],
  ["modifier order", "alt+ctrl+x", "\x1b[120;7u", true, true],
  ["case", "CTRL+ALT+X", "\x1b[120;7u", true, true],
  ["legacy tab collision", "ctrl+i", "\t", false, false],
  ["legacy return collision", "ctrl+m", "\r", false, false],
  ["Kitty distinct ctrl+i", "ctrl+i", "\x1b[105;5u", true, true],
  ["invalid configured string", "ctrl+", "\x1b", false, true],
  ["invalid modifier", "shift+escape", "\x1b", true, true],
  ["first usable fallback", "ctrl+h", "\x1b", false, true],
  ["preserve delete", "ctrl+h", "\x08", false, false],
] as const) {
  test(`review key respects ${name}`, () => {
    const previous = getKeybindings();
    const previousKitty = isKittyProtocolActive();
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": configured as never });
    setKeybindings(keys);
    setKittyProtocolActive(kitty);
    try {
      assert.equal(settingsChatReviewInput(packet, keys), expected);
    } finally {
      setKeybindings(previous);
      setKittyProtocolActive(previousKitty);
    }
  });
}
