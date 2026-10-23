import type { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isKeyRelease,
  Key,
  matchesKey,
  parseKey,
  type TUI,
  TUI_KEYBINDINGS,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrame, runCustomInteraction } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import type { WorkflowOwner } from "./command-configuration.js";
import { createSettingsChatTranscript } from "./settings-chat-transcript.js";
import type { SettingsDraft } from "./settings-draft.js";

export interface ChatViewState {
  input: string;
  error: string;
}

/** Use the same full-width preview boundary in the conversation and review menu. */
export function renderSettingsChatPreview(
  width: number,
  preview: readonly string[],
  theme: Pick<Theme, "fg">,
): string[] {
  if (width <= 0) return [];
  const ruleStyle = (text: string) => theme.fg("border", text);
  const top = new HorizontalRule({
    label: "Footer preview — not saved",
    labelAlignment: "left",
    ruleStyle,
    labelStyle: (text) => theme.fg("muted", text),
  });
  const bottom = new HorizontalRule({ ruleStyle });
  return [top.render(width)[0] ?? "", ...preview, bottom.render(width)[0] ?? ""];
}

/** Editor actions win collisions. Escape remains a review fallback for unusable cancel settings. */
export function settingsChatReviewInput(data: string, keybindings: Pick<KeybindingsManager, "matches">): boolean {
  const editorKeys = getKeybindings();
  const parsed = parseKey(data);
  const textKey = parsed?.startsWith("shift+") ? parsed.slice(6) : parsed;
  const printable =
    data.charCodeAt(0) >= 32 || (textKey !== undefined && (Array.from(textKey).length === 1 || textKey === "space"));
  // These native Editor branches remain active even when their configurable actions are remapped.
  const nativeEditing =
    printable ||
    matchesKey(data, "shift+backspace") ||
    matchesKey(data, "shift+delete") ||
    data.charCodeAt(0) === 10 ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.includes("\x1b") && data.includes("\r"));
  const editing =
    nativeEditing ||
    (Object.keys(TUI_KEYBINDINGS) as Array<keyof typeof TUI_KEYBINDINGS>)
      .filter((key) => key.startsWith("tui.editor.") || key.startsWith("tui.input."))
      .some((key) => editorKeys.matches(data, key));
  return !editing && (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape));
}

export function settingsChatTranscript(agent: Agent): string[] {
  return [...agent.state.messages, ...(agent.state.streamingMessage ? [agent.state.streamingMessage] : [])]
    .filter((message) => message.role !== "system")
    .flatMap((message) => {
      if (!("content" in message) || !Array.isArray(message.content)) return [];
      const label = message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "Tool";
      const text = message.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "toolCall") return `Using ${part.name}…`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      const error = message.role === "assistant" ? message.errorMessage : undefined;
      const output = [text, error].filter(Boolean).join("\n");
      return output ? [`${label}: ${sanitizeTerminalDocument(output)}`] : [];
    });
}

export function createSettingsChatComponent(options: {
  agent: Agent;
  draft: SettingsDraft;
  state: ChatViewState;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  signal: AbortSignal;
  preview(width: number): string[];
  complete(value: "review" | "discard"): void;
}) {
  const { agent, draft, state, tui, theme, keybindings, signal } = options;
  let disposed = false;
  let inPaste = false;
  let pending: Promise<void> | undefined;
  const editor = new Editor(tui, {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  });
  editor.setText(state.input);
  const render = () => {
    if (!disposed && !signal.aborted) tui.requestRender();
  };
  const unsubscribe = agent.subscribe(render);
  const abort = () => {
    agent.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
  const transcript = createSettingsChatTranscript(agent, tui, draft.directory);
  // Native Editor expands paste markers and clears itself before calling onSubmit.
  editor.onSubmit = (input) => {
    if (pending || signal.aborted || disposed) return;
    if (!input.trim()) return;
    editor.addToHistory(input);
    editor.setText("");
    state.error = "";
    editor.disableSubmit = true;
    pending = agent
      .prompt(input)
      .catch((error: unknown) => {
        if (!disposed && !signal.aborted) state.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        pending = undefined;
        editor.disableSubmit = false;
        render();
      });
    render();
  };
  return {
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    render(width: number): string[] {
      if (disposed || signal.aborted || width <= 0) return [];
      const rows = Math.max(0, Math.floor(Number.isFinite(tui.terminal.rows) ? tui.terminal.rows : 24));
      if (rows === 0) return [];
      const input = editor.render(width);
      const cursor = Math.max(
        0,
        input.findIndex((line) => line.includes(CURSOR_MARKER)),
      );
      const preview = options.preview(width).slice(0, Math.max(1, Math.min(4, Math.floor(rows / 4))));
      const diagnostics = sanitizeTerminalDocument(
        state.error || agent.state.errorMessage || draft.diagnostics || "Valid draft. Active file unchanged.",
      )
        .split("\n")
        .slice(0, 3);
      // Match Pi's transcript -> editor -> footer hierarchy. The fullscreen overlay
      // covers the parent footer, so the real draft preview is part of this dock.
      const footer = [
        ...diagnostics.map((line) => theme.fg("muted", line)),
        theme.fg("dim", "pi-starship configuration chat · preview only"),
        theme.fg("muted", pending ? "Agent working · save unavailable" : "Cancel reviews · ctrl+c discards"),
      ];
      // Horizontal boundaries preserve the statusline's full responsive render width.
      // Never show a preview with missing boundaries; optional chrome yields first.
      const previewFrame = renderSettingsChatPreview(width, preview, theme);
      if (input.length + previewFrame.length > rows) {
        return renderBoundedFrame({
          width,
          maxRows: rows,
          rule: rule.render(width)[0] ?? "",
          title: [],
          content: [...input, theme.fg("muted", "Footer preview hidden — enlarge the terminal"), ...footer],
          focusedRow: cursor,
          priorityRows: [cursor, input.length],
        });
      }
      const content = [...input, ...previewFrame, ...footer.slice(0, rows - input.length - previewFrame.length)];
      const available = rows - content.length;
      const history = available > 0 ? transcript.render(width).slice(-available) : [];
      return [...history, ...Array.from({ length: available - history.length }, () => ""), ...content].map((line) =>
        truncateToWidth(line, width, ""),
      );
    },
    invalidate() {
      editor.invalidate();
      transcript.invalidate();
    },
    handleInput(data: string) {
      if (disposed || signal.aborted || isKeyRelease(data)) return;
      // Forward entire paste packets and fragments without interpreting embedded shortcuts.
      if (inPaste || data.includes("\x1b[200~")) {
        inPaste = !data.includes("\x1b[201~");
        editor.handleInput(data);
      } else if (matchesKey(data, Key.ctrl("c"))) {
        agent.abort();
        options.complete("discard");
      } else if (settingsChatReviewInput(data, keybindings)) {
        if (pending) agent.abort();
        else {
          state.input = editor.getExpandedText();
          options.complete("review");
        }
      } else editor.handleInput(data);
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.input = editor.getExpandedText();
      signal.removeEventListener("abort", abort);
      unsubscribe();
      transcript.dispose();
      agent.abort();
    },
    async waitForPending() {
      await pending;
      await agent.waitForIdle();
    },
  };
}

export async function showSettingsChat(
  ctx: ExtensionCommandContext,
  agent: Agent,
  draft: SettingsDraft,
  state: ChatViewState,
  owner: WorkflowOwner,
  preview: (width: number) => string[],
): Promise<"review" | "discard"> {
  // Keep Kit's cancellation/disposal runner, but mount through Pi's public overlay API.
  // No second TUI, terminal handoff, or manipulation of unrelated overlay handles is needed.
  const fullscreenContext: ExtensionCommandContext = {
    ...ctx,
    ui: {
      ...ctx.ui,
      custom: (factory) =>
        ctx.ui.custom(factory, {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
        }),
    },
  };
  const result = await runCustomInteraction<"review" | "discard">(fullscreenContext, {
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    create: ({ tui, theme, keybindings, signal, complete }) =>
      createSettingsChatComponent({
        agent,
        draft,
        state,
        tui,
        theme,
        keybindings,
        signal,
        preview,
        complete,
      }),
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "completed" ? result.value : "discard";
}
