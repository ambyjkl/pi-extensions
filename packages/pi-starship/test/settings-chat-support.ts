import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const testModel = {
  id: "configuration-test",
  name: "Configuration test",
  api: "openai-completions",
  provider: "configuration-test",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;
export function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  stream.push({ type: "done", reason: stopReason as "stop" | "length" | "toolUse", message });
  return stream;
}
