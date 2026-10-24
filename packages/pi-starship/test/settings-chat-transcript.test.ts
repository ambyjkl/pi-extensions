import assert from "node:assert/strict";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createReadToolDefinition,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createSettingsChatTranscript } from "../src/settings-chat-transcript.js";
import { response, testModel } from "./settings-chat-support.js";

initTheme("dark", false);
const cwd = "/private-settings-draft";
function fixture(messages: AgentMessage[]) {
  const agent = new Agent({
    initialState: { model: { ...testModel, input: ["text"] }, messages },
    streamFn: () => response([]),
  });
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as TUI;
  return { agent, tui, transcript: createSettingsChatTranscript(agent, tui, cwd) };
}

test("user and assistant blocks exactly reuse native Markdown, backgrounds, padding, and later-question spacing", async () => {
  const question = "Show **model** in red. 中文 🙂";
  const reply = "Updated the draft.\n\n```toml\n[model]\nstyle = 'red'\n```";
  const next = "Keep the directory too.";
  const assistant = await response([{ type: "text", text: reply }]).result();
  const messages: AgentMessage[] = [
    { role: "user", content: question, timestamp: 1 },
    assistant,
    { role: "user", content: next, timestamp: 2 },
  ];
  const f = fixture(messages);
  try {
    const expected = [
      ...new UserMessageComponent(question).render(80),
      ...new AssistantMessageComponent(assistant, true).render(80),
      "",
      ...new UserMessageComponent(next).render(80),
    ];
    assert.deepEqual(f.transcript.render(80), expected);
    assert.deepEqual(f.transcript.render(80), expected);
    assert.doesNotMatch(expected.join("\n"), /You:|Agent:/u);
    assert.deepEqual(f.transcript.render(0), []);
    initTheme("light", false);
    f.transcript.invalidate();
    assert.deepEqual(f.transcript.render(80), [
      ...new UserMessageComponent(question).render(80),
      ...new AssistantMessageComponent(assistant, true).render(80),
      "",
      ...new UserMessageComponent(next).render(80),
    ]);
  } finally {
    f.transcript.dispose();
    initTheme("dark", false);
  }
});

test("message anchors retain exact rows through eviction and invalidation", () => {
  const f = fixture(
    Array.from({ length: 30 }, (_, index) => ({
      role: "user" as const,
      content: Array.from({ length: (index % 5) + 1 }, (_, row) => `message-${index}-row-${row}`).join("\n"),
      timestamp: index,
    })),
  );
  try {
    const before = f.transcript.render(80);
    const anchors = before.map((line, row) => ({ line, anchor: f.transcript.anchorAt(row) }));
    f.agent.state.messages.push({ role: "user", content: "new message", timestamp: 30 });
    f.transcript.invalidate();
    const after = f.transcript.render(80);
    for (const { line, anchor } of anchors) {
      assert.ok(anchor);
      if (anchor.message === f.agent.state.messages[0]) assert.equal(f.transcript.rowAt(anchor), 0);
      else if (anchor.row >= 0) assert.equal(after[f.transcript.rowAt(anchor)], line);
    }
    f.transcript.dispose();
    assert.equal(f.transcript.anchorAt(0), undefined);
  } finally {
    f.transcript.dispose();
  }
});

for (const isError of [false, true]) {
  test(`tool ${isError ? "error" : "success"} uses native tool framing without changing raw arguments or results`, async () => {
    const unsafe = "\x1b]52;c;secret\x07";
    const assistant = await response(
      [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: `${cwd}/${unsafe}pi-starship.toml` } }],
      "toolUse",
    ).result();
    const result = {
      role: "toolResult" as const,
      toolCallId: "read-call",
      toolName: "read",
      content: [{ type: "text" as const, text: `draft${unsafe}` }],
      isError,
      timestamp: 2,
    };
    const f = fixture([assistant, result]);
    const original = JSON.stringify(f.agent.state.messages);
    try {
      const native = new ToolExecutionComponent(
        "read",
        "read-call",
        { path: `${cwd}/pi-starship.toml` },
        { showImages: false, outputPad: 1 },
        createReadToolDefinition(cwd),
        f.tui,
        cwd,
      );
      native.setExpanded(true);
      native.setArgsComplete();
      native.markExecutionStarted();
      native.updateResult({ content: [{ type: "text", text: "draft" }], isError });
      const actual = f.transcript.render(80);
      assert.deepEqual(actual, native.render(80));
      assert.ok(!actual.join("\n").includes("\x1b]52"));
      assert.doesNotMatch(actual.join("\n"), /to expand/u);
      assert.equal(JSON.stringify(f.agent.state.messages), original);
    } finally {
      f.transcript.dispose();
    }
  });
}

test("unknown tool names, IDs, paths, and results are sanitized before native fallback rendering", async () => {
  const unsafe = "\x1b]52;c;secret\x07";
  const assistant = await response(
    [
      {
        type: "toolCall",
        id: `id${unsafe}`,
        name: `unknown${unsafe}`,
        arguments: { path: `${cwd}/${unsafe}draft.toml` },
      },
    ],
    "toolUse",
  ).result();
  const result = {
    role: "toolResult" as const,
    toolCallId: `id${unsafe}`,
    toolName: `unknown${unsafe}`,
    content: [{ type: "text" as const, text: `Rejected${unsafe}` }],
    isError: true,
    timestamp: 2,
  };
  const f = fixture([assistant, result]);
  const raw = JSON.stringify(f.agent.state.messages);
  try {
    const frame = f.transcript.render(80).join("\n");
    assert.ok(!frame.includes("\x1b]52"));
    assert.match(frame, /unknown/u);
    assert.match(frame, /Rejected/u);
    assert.equal(JSON.stringify(f.agent.state.messages), raw);
  } finally {
    f.transcript.dispose();
  }
});

test("streaming replies use the native assistant block and become one finalized message", async () => {
  const stream = createAssistantMessageEventStream();
  const partial = await response([{ type: "text", text: "Live **reply** 中文" }]).result();
  const agent = new Agent({ initialState: { model: { ...testModel, input: ["text"] } }, streamFn: () => stream });
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as TUI;
  const transcript = createSettingsChatTranscript(agent, tui, cwd);
  let ready!: () => void;
  const updated = new Promise<void>((done) => {
    ready = done;
  });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update") ready();
  });
  const running = agent.prompt("Streaming question");
  try {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Live **reply** 中文", partial });
    await updated;
    const native = new AssistantMessageComponent(undefined, true);
    native.updateContent(partial, true);
    assert.deepEqual(transcript.render(80), [
      ...new UserMessageComponent("Streaming question").render(80),
      ...native.render(80),
    ]);
    stream.push({ type: "done", reason: "stop", message: partial });
    await running;
    assert.deepEqual(transcript.render(80), [
      ...new UserMessageComponent("Streaming question").render(80),
      ...new AssistantMessageComponent(partial, true).render(80),
    ]);
  } finally {
    stream.end(partial);
    await running;
    unsubscribe();
    transcript.dispose();
    assert.deepEqual(transcript.render(80), []);
  }
});

test("native error-only assistant messages retain error styling and sanitized display payloads", async () => {
  const message = await response([]).result();
  message.stopReason = "error";
  message.errorMessage = "Failed\x1b[2J";
  const f = fixture([message]);
  try {
    assert.deepEqual(
      f.transcript.render(80),
      new AssistantMessageComponent({ ...message, errorMessage: "Failed" }, true).render(80),
    );
    assert.equal(message.errorMessage, "Failed\x1b[2J");
  } finally {
    f.transcript.dispose();
  }
});
