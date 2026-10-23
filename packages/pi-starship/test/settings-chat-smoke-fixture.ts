import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic provider for the automated PTY smoke; never contacts an external service. */
export default function settingsChatSmokeFixture(pi: ExtensionAPI) {
  const record = {
    requests: 0,
    skillLoaded: false,
    tools: [] as string[],
    mainMessages: -1,
    draftPath: "",
    executedTools: [] as string[],
  };
  const save = () => writeFileSync(join(process.cwd(), "smoke-record.json"), JSON.stringify(record));
  pi.registerProvider("starship-smoke", {
    api: "starship-smoke",
    apiKey: "local-fixture",
    baseUrl: "http://unused.invalid",
    models: [
      {
        id: "configuration-smoke",
        name: "configuration-smoke",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      record.requests += 1;
      const system = context.messages[0];
      assert.ok(system?.role === "system");
      const prompt = typeof system.content === "string" ? system.content : "";
      record.skillLoaded = prompt.includes("# Configure pi-starship") && prompt.includes("Hosted preview-only chat");
      record.tools = system.toolsAdded?.map((tool) => tool.name) ?? [];
      record.draftPath = /Draft path: ([^\n]+)/u.exec(prompt)?.[1] ?? "";
      assert.equal(record.skillLoaded, true);
      assert.deepEqual(record.tools, ["read", "write", "edit"]);
      assert.ok(record.draftPath);
      const toolResults = context.messages.filter((message) => message.role === "toolResult");
      assert.ok(toolResults.every((message) => !message.isError));
      record.executedTools = toolResults.map((message) => message.toolName);
      const second = context.messages.filter((message) => message.role === "user").length > 1;
      const toolsNeeded = context.messages.at(-1)?.role === "user";
      const content: AssistantMessage["content"] = toolsNeeded
        ? [
            {
              type: "toolCall",
              id: `call-${record.requests}`,
              name: second ? "edit" : "write",
              arguments: second
                ? { path: record.draftPath, edits: [{ oldText: "$directory", newText: "$model$directory" }] }
                : { path: record.draftPath, content: "# smoke draft\nformat = '$directory'\n" },
            },
          ]
        : [{ type: "text", text: second ? "SMOKE_SECOND_READY" : "SMOKE_FIRST_READY" }];
      if (toolsNeeded && !second) {
        const skillDirectory = /Skill base directory: ([^\n]+)/u.exec(prompt)?.[1];
        assert.ok(skillDirectory);
        content.unshift({
          type: "toolCall",
          id: `read-${record.requests}`,
          name: "read",
          arguments: { path: join(skillDirectory, "references/configuration.md"), limit: 10 },
        });
      }
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolsNeeded ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: toolsNeeded ? "toolUse" : "stop", message });
      save();
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("STARSHIP_SMOKE_READY", "info");
  });
  pi.registerCommand("smoke-check", {
    description: "Record parent isolation and finish the automated smoke",
    handler: async (_args, ctx) => {
      record.mainMessages = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").length;
      save();
      ctx.shutdown();
    },
  });
}
