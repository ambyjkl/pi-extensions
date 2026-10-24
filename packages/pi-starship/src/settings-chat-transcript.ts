import { stripVTControlCharacters } from "node:util";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";

/** Display-only copies keep terminal controls out of native renderers without changing agent history. */
function displayValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeTerminalDocument(value) as T;
  if (Array.isArray(value)) return value.map(displayValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, displayValue(item)])) as T;
  }
  return value;
}

export interface SettingsChatAnchor {
  message: AgentMessage | symbol;
  row: number;
  width: number;
  offset: number;
  text: string;
}

/** Reuse Pi's public message components, not another extension's renderer or private settings. */
export function createSettingsChatTranscript(agent: Agent, tui: TUI, cwd: string) {
  const messages = new Map<AgentMessage, Component>();
  const tools = new Map<string, { component: ToolExecutionComponent; result?: AgentMessage }>();
  const definitions = {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
  };
  // Agent emits a new object for each partial update and another at finalization.
  // Keep one response identity across those events, including frames with no render.
  const identities = new WeakMap<AgentMessage, symbol>();
  let streamingIdentity: symbol | undefined;
  const initial = agent.state.streamingMessage;
  if (initial?.role === "assistant") {
    streamingIdentity = Symbol();
    identities.set(initial, streamingIdentity);
  }
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "agent_end") streamingIdentity = undefined;
    if (
      (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      if (event.type === "message_start") streamingIdentity = Symbol();
      streamingIdentity ??= Symbol();
      identities.set(event.message, streamingIdentity);
      if (event.type === "message_end") streamingIdentity = undefined;
    }
  });
  let spans: Array<{ message: AgentMessage | symbol; start: number; end: number; offsets: number[]; text: string }> =
    [];
  let renderedWidth = 0;
  let streaming: AssistantMessageComponent | undefined;
  let disposed = false;
  let expanded = true;
  return {
    render(width: number): string[] {
      spans = [];
      if (disposed || width <= 0) return [];
      const results = new Map(
        agent.state.messages.flatMap((message) =>
          message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
        ),
      );
      const visible = agent.state.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-30);
      const activeMessages = new Set<AgentMessage>();
      const activeTools = new Set<string>();
      const lines: string[] = [];
      renderedWidth = width;
      const recordSpan = (message: AgentMessage | symbol, start: number) => {
        let offset = 0;
        let text = "";
        const offsets = lines.slice(start).map((line) => {
          const before = offset;
          // Display-only offsets ignore padding and wrap-boundary whitespace.
          const content = stripVTControlCharacters(line).replace(/\s/gu, "");
          text += content;
          offset += content.length;
          return before;
        });
        spans.push({ message, start, end: lines.length, offsets, text });
      };
      const appendAssistant = (message: AssistantMessage, component: AssistantMessageComponent) => {
        lines.push(...component.render(width));
        for (const call of message.content) {
          if (call.type !== "toolCall") continue;
          activeTools.add(call.id);
          let tool = tools.get(call.id);
          if (!tool) {
            const definition =
              call.name === "read" || call.name === "write" || call.name === "edit"
                ? definitions[call.name]
                : undefined;
            const component = new ToolExecutionComponent(
              sanitizeTerminalDocument(call.name),
              sanitizeTerminalDocument(call.id),
              displayValue(call.arguments),
              { showImages: false, outputPad: 1 },
              definition,
              tui,
              sanitizeTerminalDocument(cwd),
            );
            component.setExpanded(expanded);
            component.setArgsComplete();
            component.markExecutionStarted();
            tool = { component };
            tools.set(call.id, tool);
          }
          const result = results.get(call.id);
          if (result && tool.result !== result) {
            tool.component.updateResult({
              content: displayValue(result.content),
              details: displayValue(result.details),
              isError: result.isError,
              durationMs: result.durationMs,
            });
            tool.result = result;
          }
          lines.push(...tool.component.render(width));
        }
      };
      for (const message of visible) {
        activeMessages.add(message);
        let start = lines.length;
        let component = messages.get(message);
        if (message.role === "user") {
          if (lines.length) lines.push("");
          start = lines.length;
          if (!component) {
            const text =
              typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n");
            component = new UserMessageComponent(sanitizeTerminalDocument(text));
            messages.set(message, component);
          }
          lines.push(...component.render(width));
        } else if (message.role === "assistant") {
          if (!component) {
            component = new AssistantMessageComponent(displayValue(message), true);
            messages.set(message, component);
          }
          appendAssistant(message, component as AssistantMessageComponent);
        }
        recordSpan(identities.get(message) ?? message, start);
      }
      const partial = agent.state.streamingMessage;
      if (partial?.role === "assistant") {
        streaming ??= new AssistantMessageComponent(undefined, true);
        streaming.updateContent(displayValue(partial), true);
        // Tool calls are rendered after finalization, not from incomplete streaming arguments.
        const start = lines.length;
        lines.push(...streaming.render(width));
        recordSpan(identities.get(partial) ?? partial, start);
      } else streaming = undefined;
      for (const message of messages.keys()) if (!activeMessages.has(message)) messages.delete(message);
      for (const id of tools.keys()) if (!activeTools.has(id)) tools.delete(id);
      return lines;
    },
    anchorAt(row: number): SettingsChatAnchor | undefined {
      const span = spans.find((item) => row < item.end);
      return span
        ? {
            message: span.message,
            row: row - span.start,
            width: renderedWidth,
            offset: span.offsets[Math.max(0, row - span.start)] ?? 0,
            text: span.text.slice(
              span.offsets[Math.max(0, row - span.start)] ?? 0,
              span.offsets[Math.max(0, row - span.start) + 1],
            ),
          }
        : undefined;
    },
    rowAt(anchor: SettingsChatAnchor): number {
      const span = spans.find((item) => item.message === anchor.message);
      // If the anchored message was evicted, show the oldest retained content.
      if (!span) return 0;
      let row = anchor.row;
      const currentText = span.text.slice(span.offsets[Math.max(0, row)], span.offsets[Math.max(0, row) + 1]);
      if (anchor.width !== renderedWidth || currentText !== anchor.text) {
        // Restore retained content after reflow or tool expansion/collapse.
        // Match the row's content, not the accumulated length of earlier rows:
        // Markdown rules and other decoration can change width independently.
        let offset = anchor.offset;
        if (anchor.text) {
          let match = span.text.indexOf(anchor.text);
          let best = -1;
          while (match >= 0) {
            if (best < 0 || Math.abs(match - anchor.offset) < Math.abs(best - anchor.offset)) best = match;
            match = span.text.indexOf(anchor.text, match + 1);
          }
          if (best >= 0) offset = best;
        }
        row = 0;
        for (let index = 0; index < span.offsets.length; index++) {
          if (span.offsets[index] > offset) break;
          row = index;
        }
      }
      return Math.max(0, span.start + Math.min(row, span.end - span.start - 1));
    },
    toggleTools() {
      if (disposed) return;
      expanded = !expanded;
      for (const { component } of tools.values()) component.setExpanded(expanded);
      tui.requestRender();
    },
    invalidate() {
      if (disposed) return;
      // Native Markdown themes can retain concrete colors. Recreate display components
      // rather than retaining colors captured before a host theme change.
      messages.clear();
      tools.clear();
      streaming = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      streamingIdentity = undefined;
      spans = [];
      messages.clear();
      tools.clear();
      streaming = undefined;
    },
  };
}
