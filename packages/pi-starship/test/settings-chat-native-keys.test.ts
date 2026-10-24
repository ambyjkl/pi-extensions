import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { SettingsChatEditor } from "../src/settings-chat-ui.js";

const definitions = {
  ...TUI_KEYBINDINGS,
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
  "app.interrupt": { defaultKeys: "escape" },
  "app.exit": { defaultKeys: "ctrl+d" },
  "app.message.followUp": { defaultKeys: "alt+enter" },
  "app.message.dequeue": { defaultKeys: "alt+up" },
} as const;

function compare(
  bindings: Record<string, string | string[]>,
  run: (pair: { native: CustomEditor; chat: SettingsChatEditor; pages: number[]; events: string[][] }) => void,
  kitty = false,
) {
  const previous = getKeybindings();
  const previousKitty = isKittyProtocolActive();
  const keys = new KeybindingsManager(definitions, bindings as never);
  setKeybindings(keys);
  setKittyProtocolActive(kitty);
  try {
    const plain = (value: string) => value;
    const tui = { requestRender() {}, terminal: { rows: 24 } } as ConstructorParameters<typeof CustomEditor>[0];
    const theme = {
      borderColor: plain,
      selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
    };
    const native = new CustomEditor(tui, theme, keys as never);
    const chat = new SettingsChatEditor(
      tui,
      { fg: (_role: string, value: string) => value } as never,
      () => ({ top: "", bottom: "" }),
      keys as never,
    );
    const pages: number[] = [];
    chat.onTranscriptPage = (direction) => pages.push(direction);
    const events: string[][] = [[], []];
    for (const [index, editor] of [native, chat].entries()) {
      editor.setText("alpha beta\ngamma");
      editor.addToHistory("older prompt");
      editor.onSubmit = (text) => events[index]?.push(`submit:${text}`);
      editor.onAction("app.message.followUp", () => events[index]?.push("followUp"));
      editor.onAction("app.message.dequeue", () => events[index]?.push("dequeue"));
      editor.onPasteImage = () => events[index]?.push("pasteImage");
      editor.render(40);
    }
    run({ native, chat, pages, events });
  } finally {
    setKeybindings(previous);
    setKittyProtocolActive(previousKitty);
  }
}

const earlier = [
  "tui.input.copy",
  "tui.editor.undo",
  "tui.input.tab",
  "tui.editor.deleteToLineEnd",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.historyPrevious",
  "tui.editor.historyNext",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.input.newLine",
  "tui.input.submit",
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorRight",
  "tui.editor.cursorLeft",
  "app.clipboard.pasteImage",
  "app.interrupt",
  "app.message.followUp",
  "app.message.dequeue",
];
for (const action of earlier) {
  test(`native ${action} wins a remapped page collision`, () => {
    compare({ [action]: "pageUp" }, ({ native, chat, pages, events }) => {
      for (const editor of [native, chat]) editor.handleInput("\x1b[5~");
      assert.deepEqual(pages, []);
      assert.equal(chat.getText(), native.getText());
      assert.deepEqual(chat.getCursor(), native.getCursor());
      assert.deepEqual(events[1], events[0]);
    });
  });
}

for (const empty of [false, true]) {
  test(`native exit collision is conditional on empty=${empty}`, () => {
    compare({ "app.exit": "pageUp" }, ({ native, chat, pages }) => {
      if (empty) for (const editor of [native, chat]) editor.setText("");
      for (const editor of [native, chat]) editor.handleInput("\x1b[5~");
      assert.deepEqual(pages, empty ? [] : [-1]);
      assert.equal(chat.getText(), native.getText());
    });
  });
}

test("explicit history wins registered message actions before paging", () => {
  compare(
    { "tui.editor.historyPrevious": "pageUp", "app.message.followUp": "pageUp" },
    ({ native, chat, pages, events }) => {
      for (const editor of [native, chat]) editor.handleInput("\x1b[5~");
      assert.deepEqual(pages, []);
      assert.deepEqual(events, [[], []]);
      assert.equal(chat.getText(), native.getText());
      assert.equal(chat.getText(), "older prompt");
    },
  );
});

for (const [key, input] of [
  ["shift+backspace", "\x1b[127;2u"],
  ["shift+delete", "\x1b[3;2~"],
  ["ctrl+j", "\n"],
  ["alt+enter", "\x1b\r"],
  ["shift+enter", "\x1b[13;2~"],
] as const) {
  test(`unconditional native editing wins page binding ${key}`, () => {
    compare(
      {
        "tui.editor.pageUp": key,
        "tui.input.newLine": [],
        "tui.editor.deleteCharBackward": [],
        "tui.editor.deleteCharForward": [],
        "app.message.followUp": [],
      },
      ({ native, chat, pages }) => {
        for (const editor of [native, chat]) editor.handleInput(input);
        assert.deepEqual(pages, []);
        assert.equal(chat.getText(), native.getText());
        assert.deepEqual(chat.getCursor(), native.getCursor());
      },
    );
  });
}

for (const kitty of [false, true]) {
  for (const [configured, input] of [
    ["pageUp", "\x1b[5~"],
    ["ctrl+alt+u", "\x1b[117;7u"],
    ["alt+ctrl+u", "\x1b[117;7u"],
    ["esc", "\x1b"],
    ["ctrl+i", "\t"],
  ] as const) {
    test(`page dispatch uses native matcher: ${configured}, kitty=${kitty}`, () => {
      compare(
        { "tui.editor.pageUp": configured },
        ({ native, chat, pages }) => {
          for (const editor of [native, chat]) editor.handleInput(input);
          // Escape is owned by app.interrupt; Tab and legacy Ctrl+I by native completion.
          const reserved = configured === "esc" || configured === "ctrl+i";
          assert.deepEqual(pages, reserved ? [] : [-1]);
          assert.equal(chat.getText(), native.getText());
        },
        kitty,
      );
    });
  }
}

test("invalid page key does not block the first usable configured alternative", () => {
  compare({ "tui.editor.pageUp": ["not-a-real-key", "ctrl+alt+u"] }, ({ chat, pages }) => {
    chat.handleInput("\x1b[117;7u");
    assert.deepEqual(pages, [-1]);
  });
});

for (const input of ["x", "\x1b[120u", "\x1b[27;1;120~"]) {
  test(`pending native jump consumes printable page binding ${JSON.stringify(input)}`, () => {
    compare({ "tui.editor.pageUp": "x" }, ({ native, chat, pages }) => {
      for (const editor of [native, chat]) {
        editor.setText("x middle x");
        editor.handleInput("\x01");
        editor.handleInput("\x1d");
        editor.handleInput(input);
      }
      assert.deepEqual(pages, []);
      assert.deepEqual(chat.getCursor(), native.getCursor());
      assert.equal(chat.getText(), native.getText());
    });
  });
}

for (const [key, packet, consumesJump] of [
  ["x", "\x1b[27;1;120~", true],
  ["shift+x", "\x1b[27;2;120~", true],
  ["x", "\x1b[27;65;120~", true],
  ["x", "\x1b[27;129;120~", true],
  ["shift+x", "\x1b[27;194;120~", true],
  ["ctrl+x", "\x1b[27;5;120~", false],
  ["alt+x", "\x1b[27;3;120~", false],
] as const) {
  test(`modifyOtherKeys jump target respects modifiers: ${JSON.stringify(packet)}`, () => {
    compare({ "tui.editor.pageUp": key }, ({ native, chat, pages }) => {
      for (const editor of [native, chat]) {
        editor.setText("x middle x");
        editor.handleInput("\x01");
        editor.handleInput("\x1d");
        editor.handleInput(packet);
      }
      assert.deepEqual(pages, consumesJump ? [] : [-1]);
      if (consumesJump) assert.deepEqual(chat.getCursor(), native.getCursor());
      assert.equal(chat.getText(), native.getText());
    });
  });
}

test("page wins later jump trigger and does not enter jump mode", () => {
  compare({ "tui.editor.jumpForward": "pageUp" }, ({ chat, pages }) => {
    chat.handleInput("\x1b[5~");
    chat.handleInput("z");
    assert.deepEqual(pages, [-1]);
    assert.match(chat.getText(), /z$/u);
  });
});

test("control page cancels pending jump without moving editor cursor", () => {
  compare({}, ({ chat, pages }) => {
    const cursor = chat.getCursor();
    chat.handleInput("\x1d");
    chat.handleInput("\x1b[5~");
    assert.deepEqual(chat.getCursor(), cursor);
    chat.handleInput("z");
    assert.deepEqual(pages, [-1]);
    assert.match(chat.getText(), /z$/u);
  });
});

test("interrupt forwards to native Editor and cancels a pending jump", () => {
  compare({ "tui.editor.pageUp": "x" }, ({ native, chat, pages }) => {
    for (const editor of [native, chat]) {
      editor.handleInput("\x1d");
      editor.handleInput("\x1b");
    }
    chat.handleInput("x");
    assert.deepEqual(pages, [-1]);
    assert.equal(chat.getText(), native.getText());
  });
});

for (const [action, input] of [
  ["app.clipboard.pasteImage", "\x16"],
  ["app.message.followUp", "\x1b\r"],
  ["app.message.dequeue", "\x1b[1;3A"],
] as const) {
  test(`${action} leaves pending native jump active`, () => {
    compare({ "tui.editor.pageUp": "x" }, ({ native, chat, pages }) => {
      for (const editor of [native, chat]) {
        editor.handleInput("\x1d");
        editor.handleInput(input);
        editor.handleInput("x");
      }
      assert.deepEqual(pages, []);
      assert.equal(chat.getText(), native.getText());
      assert.deepEqual(chat.getCursor(), native.getCursor());
    });
  });
}

test("paste clears owned jump tracking and preserves literal shortcut bytes", () => {
  compare({ "tui.editor.pageUp": "x" }, ({ native, chat, pages }) => {
    for (const editor of [native, chat]) editor.handleInput("\x1d");
    native.handleInput("\x1b[200~paste\x1b[5~\x1b[201~");
    chat.handlePasteInput("\x1b[200~paste\x1b[5~\x1b[201~");
    assert.equal(chat.getText(), native.getText());
    chat.handleInput("x");
    assert.deepEqual(pages, [-1]);
  });
});
