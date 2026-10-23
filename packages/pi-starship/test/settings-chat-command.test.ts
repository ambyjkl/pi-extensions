import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { showSettingsAgentChat } from "../src/command-settings-chat.js";
import { registerStarshipCommand, type StarshipCommandOptions } from "../src/commands.js";
import { type LoadedStarshipConfig, loadStarshipConfig } from "../src/config.js";
import { listHistory } from "../src/profile-store.js";
import { response, testModel } from "./settings-chat-support.js";

function fixture(
  original: string | null = "# retained\nformat = '$model'\n",
  overrides: Partial<StarshipCommandOptions> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "starship-chat-command-"));
  const settingsPath = join(root, "pi-starship.toml");
  if (original !== null) writeFileSync(settingsPath, original);
  let loaded = loadStarshipConfig(settingsPath);
  let revision = 1;
  let applied = 0;
  let cleanup: (() => Promise<void>) | undefined;
  const previews: Array<LoadedStarshipConfig | undefined> = [];
  const tui = createTuiHarness({ rows: 40 });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    model: { ...testModel, input: ["text"] },
  });
  const ctx = context.ctx as ExtensionCommandContext;
  const controller = new AbortController();
  let draftPath: string | undefined;
  let request = 0;
  ctx.modelRegistry.streamSimple = (_model, input) => {
    request += 1;
    const system = input.messages[0];
    assert.ok(system?.role === "system");
    const text = typeof system.content === "string" ? system.content : "";
    draftPath = /Draft path: ([^\n]+)/u.exec(text)?.[1];
    assert.ok(draftPath);
    if (request % 2 === 1)
      return response(
        [
          {
            type: "toolCall",
            id: `write-${request}`,
            name: "write",
            arguments: { path: draftPath, content: "# retained\nformat = '$directory'\n" },
          },
        ],
        "toolUse",
      );
    return response([{ type: "text", text: "The draft is ready for preview." }]);
  };
  const options: StarshipCommandOptions = {
    settingsPath,
    getLoaded: () => loaded,
    getLoadedRevision: () => revision,
    apply(next) {
      loaded = next;
      revision += 1;
      applied += 1;
    },
    preview: (next) => previews.push(next),
    renderPreview: () => ["LIVE FOOTER PREVIEW"],
    registerChatCleanup(fn) {
      cleanup = fn;
      return () => {
        cleanup = undefined;
      };
    },
    ...overrides,
  };
  const running = showSettingsAgentChat(ctx, options, {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  });
  return {
    root,
    settingsPath,
    tui,
    ctx,
    context,
    controller,
    options,
    previews,
    running,
    get loaded() {
      return loaded;
    },
    get applied() {
      return applied;
    },
    get draftPath() {
      return draftPath;
    },
    get cleanup() {
      return cleanup;
    },
    async submit() {
      await tui.waitForOpen();
      tui.type("Show the directory");
      tui.send("\r");
      await tui.waitForPending();
    },
    async chooseSave(continueReview = true) {
      tui.send("\x1b");
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /Save and apply reviewed draft/u);
      for (let index = 0; index < 3; index++) tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /Review draft before saving/u);
      if (continueReview) tui.press("tui.select.confirm");
    },
    async dispose() {
      controller.abort();
      tui.dispose();
      await running.catch(() => {});
      rmSync(root, { force: true, recursive: true });
    },
  };
}

test("agent edits preview immediately; only explicit reviewed save publishes and applies with History", async () => {
  const f = fixture();
  try {
    await f.submit();
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
    assert.equal(f.applied, 0);
    assert.match(f.previews.at(-1)?.rawDocument ?? "", /\$directory/u);
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.equal(f.applied, 1);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$directory'\n");
    assert.equal(f.loaded.rawDocument, readFileSync(f.settingsPath, "utf8"));
    assert.equal(listHistory(f.settingsPath).length, 1);
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(f.cleanup, undefined);
    assert.equal(existsSync(f.draftPath ?? ""), false);
  } finally {
    await f.dispose();
  }
});

for (const reason of ["discard", "session replacement", "component disposal"] as const) {
  test(`${reason} releases draft and child without writing active settings`, async () => {
    const f = fixture();
    try {
      await f.submit();
      if (reason === "discard") f.tui.send("\x03");
      else if (reason === "session replacement") {
        f.controller.abort();
        await f.cleanup?.();
      } else f.tui.dispose();
      assert.equal(await f.running, "close");
      assert.equal(f.applied, 0);
      assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
      assert.equal(listHistory(f.settingsPath).length, 0);
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

for (const failure of [
  "archive",
  "write",
  "apply",
  "disk conflict",
  "runtime conflict",
  "cancel confirmation",
] as const) {
  test(`save handles ${failure} without stale publication`, async () => {
    let failApply = true;
    const f = fixture(undefined, {
      ...(failure === "archive"
        ? {
            archive() {
              throw new Error("archive blocked");
            },
          }
        : {}),
      ...(failure === "write"
        ? {
            save() {
              throw new Error("write blocked");
            },
          }
        : {}),
    });
    const originalApply = f.options.apply;
    if (failure === "apply")
      f.options.apply = (loaded, ctx) => {
        if (failApply) {
          failApply = false;
          throw new Error("apply blocked");
        }
        originalApply(loaded, ctx);
      };
    f.ctx.ui.confirm = async () => {
      if (failure === "disk conflict") writeFileSync(f.settingsPath, "format = '$model$directory'\n");
      if (failure === "runtime conflict") originalApply({ ...f.loaded, rawDocument: "other runtime" }, f.ctx);
      if (failure === "cancel confirmation") f.controller.abort();
      return true;
    };
    try {
      await f.submit();
      await f.chooseSave();
      if (failure === "runtime conflict" || failure === "cancel confirmation" || failure === "apply") {
        assert.equal(await f.running, "close");
        if (failure === "apply") assert.ok(f.context.notifications.some((item) => /not applied/u.test(item.message)));
      } else {
        await f.tui.waitForOpen();
        assert.ok(f.context.notifications.some((item) => /not applied/u.test(item.message)));
        f.tui.send("\x03");
        await f.running;
      }
      const expected =
        failure === "disk conflict" ? "format = '$model$directory'\n" : "# retained\nformat = '$model'\n";
      assert.equal(readFileSync(f.settingsPath, "utf8"), expected);
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

test("explicit repair retains malformed bytes in History", async () => {
  const f = fixture("format = [");
  let confirmation = "";
  f.ctx.ui.confirm = async (_title, message) => {
    confirmation = message;
    return true;
  };
  try {
    await f.submit();
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.match(confirmation, /invalid.*repair/su);
    const history = listHistory(f.settingsPath);
    assert.equal(history.length, 1);
  } finally {
    await f.dispose();
  }
});

test("a missing active file is created only by the explicit save action", async () => {
  const f = fixture(null);
  try {
    await f.submit();
    assert.equal(existsSync(f.settingsPath), false);
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.equal(f.applied, 1);
    assert.equal(listHistory(f.settingsPath).length, 0);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$directory'\n");
  } finally {
    await f.dispose();
  }
});

test("declining a save allows a second explicit attempt without duplicate publication", async () => {
  const f = fixture();
  let confirmations = 0;
  f.ctx.ui.confirm = async () => ++confirmations > 1;
  try {
    await f.submit();
    await f.chooseSave();
    await f.tui.waitForOpen();
    assert.equal(f.applied, 0);
    await f.chooseSave();
    assert.equal(await f.running, "applied");
    assert.equal(f.applied, 1);
    assert.equal(listHistory(f.settingsPath).length, 1);
  } finally {
    await f.dispose();
  }
});

for (const screen of ["actions", "save review"] as const) {
  test(`disposing the ${screen} cannot reopen chat or publish settings`, async () => {
    const f = fixture();
    let confirmed = false;
    f.ctx.ui.confirm = async () => {
      confirmed = true;
      return true;
    };
    try {
      await f.submit();
      if (screen === "save review") await f.chooseSave(false);
      else {
        f.tui.send("\x1b");
        await f.tui.waitForOpen();
      }
      f.tui.dispose();
      assert.equal(await f.running, "close");
      assert.equal(confirmed, false);
      assert.equal(f.applied, 0);
      assert.equal(existsSync(f.draftPath ?? ""), false);
    } finally {
      await f.dispose();
    }
  });
}

test("child initialization failure releases the draft lease and preview", async () => {
  const f = fixture();
  f.ctx.model = undefined;
  try {
    await assert.rejects(f.running, /Select a model/u);
    assert.equal(f.cleanup, undefined);
    assert.equal(f.previews.at(-1), undefined);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "# retained\nformat = '$model'\n");
  } finally {
    await f.dispose();
  }
});

test("menu action is reachable without changing existing routes and non-TUI commands never start a child", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const mock = createMockPi();
    let customCalls = 0;
    const context = createMockContext({
      mode,
      custom: async () => {
        customCalls += 1;
        throw new Error("unexpected UI");
      },
    });
    registerStarshipCommand(mock.pi, {
      settingsPath: "/unused/pi-starship.toml",
      getLoaded: () => loadStarshipConfig("/unused/pi-starship.toml"),
      apply() {
        assert.fail();
      },
    });
    await mock.commands.get("starship")?.handler("", context.ctx);
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(customCalls, 0);
  }
});
