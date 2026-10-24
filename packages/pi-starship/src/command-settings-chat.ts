import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { captureCommitExpectation, commitActiveDocument, commitOwnerCurrent } from "./command-commit.js";
import type { WorkflowOwner } from "./command-configuration.js";
import { showPreviewActionMenu } from "./command-preview.js";
import { saveAsProfile } from "./command-profiles.js";
import type { StarshipCommandOptions } from "./commands.js";
import { assertProfileUnchanged } from "./profile-store.js";
import { createSettingsAgent, starshipPackageRoot } from "./settings-agent.js";
import {
  type ChatViewState,
  renderSettingsChatPreview,
  settingsChatTranscript,
  showSettingsChat,
} from "./settings-chat-ui.js";
import { createSettingsDraft } from "./settings-draft.js";

export async function showSettingsAgentChat(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  base: WorkflowOwner,
): Promise<"applied" | "close"> {
  if (ctx.mode !== "tui" || base.signal.aborted || !base.isCurrent()) return "close";
  const expected = await withFileMutationQueue(options.settingsPath, async () => {
    if (base.signal.aborted || !base.isCurrent()) return undefined;
    return captureCommitExpectation(options);
  });
  if (!expected || base.signal.aborted || !base.isCurrent()) return "close";
  const owner: WorkflowOwner = {
    signal: base.signal,
    isCurrent: () => commitOwnerCurrent(options, base, expected),
    isSessionCurrent: base.isSessionCurrent ?? base.isCurrent,
  };
  const packageRoot = starshipPackageRoot();
  const draft = createSettingsDraft({
    settingsPath: options.settingsPath,
    baseline: expected.disk.rawBytes,
    packageRoot,
    isCurrent: owner.isCurrent,
    onPreview: (loaded) => {
      if (owner.isCurrent()) options.preview?.(loaded, ctx);
    },
  });
  let agent: ReturnType<typeof createSettingsAgent> | undefined;
  let closing: Promise<void> | undefined;
  const cleanup = () => {
    if (closing) return closing;
    agent?.abort();
    closing = (async () => {
      try {
        await agent?.waitForIdle();
      } finally {
        agent?.reset();
        draft.dispose();
      }
    })();
    return closing;
  };
  const abort = () => {
    agent?.abort();
  };
  const unregister = options.registerChatCleanup?.(cleanup);
  owner.signal.addEventListener("abort", abort, { once: true });
  const state: ChatViewState = { input: "", error: "" };
  const preview = (width: number) => {
    const candidate = draft.candidate;
    return candidate
      ? (options.renderPreview?.(candidate, width, ctx) ?? ["Footer preview unavailable"])
      : ["Invalid draft; the last valid footer preview is retained."];
  };
  try {
    if (!owner.isCurrent()) return "close";
    agent = createSettingsAgent(ctx, draft, packageRoot);
    while (owner.isCurrent()) {
      const action = await showSettingsChat(ctx, agent, draft, state, owner, preview);
      if (!owner.isCurrent() || action === "discard") return "close";
      const result = await showPreviewActionMenu(
        ctx,
        "Configuration chat — preview only",
        (width, theme) => [
          "The agent has not changed the active settings file.",
          "Preview uses cached data; enabling modules here does not run commands or network requests.",
          ...renderSettingsChatPreview(width, preview(width), theme),
          ...sanitizeTerminalDocument(draft.diagnostics).split("\n"),
        ],
        [
          { value: "continue", label: "Continue conversation" },
          { value: "document", label: "Review exact draft…" },
          { value: "transcript", label: "Review full conversation…" },
          ...(draft.candidate ? [{ value: "save" as const, label: "Save draft as profile…" }] : []),
          { value: "discard", label: "Discard preview and close" },
        ],
        owner.signal,
        owner.isCurrent,
      );
      if (!owner.isCurrent() || !result || result.kind === "closed") return "close";
      if (result?.kind !== "selected") continue;
      if (result.value === "discard") return "close";
      if (result.value === "document" || result.value === "transcript") {
        const reviewed = await reviewText(
          ctx,
          owner,
          result.value === "document" ? "Settings draft" : "Configuration conversation",
          result.value === "document" ? draft.rawDocument : settingsChatTranscript(agent).join("\n\n"),
          result.value === "document",
        );
        if (!owner.isCurrent() || !reviewed) return "close";
        continue;
      }
      if (result.value !== "save" || !draft.candidate) continue;
      const candidate = draft.candidate;
      const revision = draft.revision;
      const reviewed = await reviewText(ctx, owner, "Review draft before saving", candidate.rawDocument ?? "", true);
      if (!owner.isCurrent() || !reviewed) return "close";
      draft.assertRevision(revision);
      const saved = await saveAsProfile(
        ctx,
        options,
        { ...owner, isCurrent: () => owner.isCurrent() && draft.revision === revision },
        candidate.rawDocument ?? "",
      );
      if (!owner.isCurrent() || saved === "close") return "close";
      draft.assertRevision(revision);
      if (!saved) continue;
      const repair = expected.previous.diagnostics.some((item) => item.severity === "error");
      const confirmed = await ctx.ui.confirm(
        "Apply saved profile?",
        [
          `Profile saved: ${sanitizeTerminalDocument(saved.name)}. Apply it to the current footer without reload?`,
          "This replaces the complete active settings document. Declining keeps the profile and leaves active settings unchanged.",
          "Applying can run enabled module commands and network requests; review their configuration before accepting.",
          "The previous file is retained in History. Detected concurrent edits block replacement.",
          ...(repair ? ["The original settings document is invalid. Confirm only if you requested its repair."] : []),
          ...candidate.diagnostics.map((item) => `${item.severity}: ${item.path}: ${item.message}`),
        ].join("\n"),
        { signal: owner.signal },
      );
      if (!owner.isCurrent()) return "close";
      if (!confirmed) return "close";
      try {
        const result = await commitActiveDocument(ctx, options, candidate, owner, expected, repair, () => {
          draft.assertRevision(revision);
          assertProfileUnchanged(options.settingsPath, saved);
        });
        if (result === "applied") return "applied";
        return "close";
      } catch (error) {
        if (!base.signal.aborted && base.isCurrent())
          ctx.ui.notify(
            `Profile was saved as ${sanitizeTerminalDocument(saved.name)}. Settings were not applied: ${sanitizeTerminalDocument(error instanceof Error ? error.message : String(error))}`,
            "error",
          );
      }
    }
    return "close";
  } finally {
    owner.signal.removeEventListener("abort", abort);
    try {
      await cleanup();
    } finally {
      unregister?.();
      // A successful save changes the loaded revision, but clearing this workflow's preview
      // is safe while the session still owns the serialized settings workflow.
      if (!base.signal.aborted && base.isCurrent()) options.preview?.(undefined, ctx);
    }
  }
}

async function reviewText(
  ctx: ExtensionCommandContext,
  owner: WorkflowOwner,
  title: string,
  content: string,
  toml: boolean,
) {
  let continued = false;
  const menu = defineMenu<undefined, "review", "continue", ExtensionCommandContext>({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title,
        content,
        enableSearch: true,
        format: toml ? { kind: "code", language: "toml" } : { kind: "text" },
        confirm: { id: "continue", label: "Continue", action: "continue" },
        hint: "close",
      }),
    },
    actions: {
      continue: () => {
        continued = true;
        return { kind: "close" };
      },
    },
  });
  const result = await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: owner.signal,
    isCurrent: owner.isCurrent,
  });
  return result.kind === "closed" && continued;
}
