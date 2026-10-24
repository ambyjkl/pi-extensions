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

/** Reuse Pi's public message components, not another extension's renderer or private settings. */
export function createSettingsChatTranscript(agent: Agent, tui: TUI, cwd: string) {
  const messages = new Map<AgentMessage, Component>();
  const tools = new Map<string, { component: ToolExecutionComponent; result?: AgentMessage }>();
  const definitions = {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
  };
  let streaming: AssistantMessageComponent | undefined;
  let disposed = false;
  let expanded = true;
  return {
    render(width: number): string[] {
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
        let component = messages.get(message);
        if (message.role === "user") {
          if (lines.length) lines.push("");
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
      }
      const partial = agent.state.streamingMessage;
      if (partial?.role === "assistant") {
        streaming ??= new AssistantMessageComponent(undefined, true);
        streaming.updateContent(displayValue(partial), true);
        // Tool calls are rendered after finalization, not from incomplete streaming arguments.
        lines.push(...streaming.render(width));
      } else streaming = undefined;
      for (const message of messages.keys()) if (!activeMessages.has(message)) messages.delete(message);
      for (const id of tools.keys()) if (!activeTools.has(id)) tools.delete(id);
      return lines;
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
      disposed = true;
      messages.clear();
      tools.clear();
      streaming = undefined;
    },
  };
}
