# pi-starship settings side-thread verification

## Outcome

`/starship` → **Configure with agent…** opens a separate, fullscreen, in-memory configuration agent. It explicitly loads the bundled skill and exposes only `read`, `write`, and `edit`. Agent mutations affect a private draft. Valid changes redraw the footer preview without reload; only a reviewed and confirmed user save publishes active settings.

## Architecture and semantic audit

The implementation uses the public `Agent` from Pi agent-core, not a default SDK session. `modelRegistry.streamSimple()` retains the parent's request-time authentication, custom providers, header transforms, and supported virtual-model routing without discovering parent extensions or creating a second credential store. The model/thinking selection and ordered tools are captured at flow start. Consecutive normalized request tests preserve the existing system/tool/message prefix. Each new chat is a separate prefix epoch with fixed draft/resource paths and an independent routing session ID.

The owning extension retains all settings policy. Core file-tool operations enforce the draft boundary after native path resolution. Reads use an immutable active-file snapshot or approved package/draft content. Writes and edits accept only the private draft; symlinks, hard links, non-regular files, stale owners, and oversized drafts are rejected. An outer queue orders reads, mutations, and their diagnostics; core mutators retain their own file-path queue. Invalid draft bytes remain available for repair while the last valid preview stays active.

Preview calls only the existing redraw path; it does not restart module collectors or activate draft-enabled commands/network requests. Publication reuses the existing managed History and guarded atomic commit implementation. The save boundary checks disk bytes/identity, loaded revision, draft revision, and session ownership. Archive/write/apply failures, invalid-original repair, missing-file creation, repeat attempts, conflicts, and cancellation have focused tests.

Lifecycle review covers user cancellation, component disposal, native confirmation, partial initialization, session replacement, reload, and shutdown. The child is aborted and awaited before draft removal. UI subscriptions and abort listeners are removed. Tools remain disabled after a cleanup failure, and draft removal can be retried after permissions recover. Session generation and `sessionManager` ownership prevent stale preview or publication callbacks. Shutdown awaits the registered child cleanup.

The UI uses Pi's public fullscreen overlay, native `Editor`, native user/assistant/tool message components, and Kit review/framing primitives. The transcript grows above a fixed editor/preview dock. Native message backgrounds, Markdown, padding, and inter-question spacing replace flattened role-prefixed text. The body uses Pi's native theme handling; dock chrome uses callback-provided roles. Theme invalidation recreates native components to remove captured colors. Display caches are released on disposal, and disposed or aborted views render no new content. No second TUI or shared-terminal handoff is needed. Native submission already expands paste markers; moving an unsubmitted draft uses `getExpandedText()`. Input-action collisions take precedence over review cancellation. Table-driven tests cover aliases, modifier order, printable input, legacy control collisions, Kitty/modifyOtherKeys packets, invalid bindings, native editing fallbacks, and Escape fallback. Ctrl+C remains hard discard. Display controls are removed before transcript/diagnostic layout; raw agent payloads are unchanged.

## Guides and decisions

Reviewed applicable MUST rules and touched-area checklists in `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. Skill changes follow `create-agent-skills`; child instructions follow the general `prompt-gpt` principles without assuming one provider or model.

The final diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope. No implementation question or required agent check remains open. There are no accepted exceptions to the required root gates.

The existing TOML settings format, single source forwarder, generated entrypoint, and command routes remain unchanged. The new child runtime stays behind a dynamic command import; generated-import and eager-graph tests cover that boundary. The only added Pi peer is agent-core, with its matching workspace development dependency and lockfile entry. A minor Changeset records the published behavior change.

Intentional UI differences are documented in the package README: the fullscreen view shows recent messages with expanded read-only tool output, full reviews expose the transcript/document, editor actions win cancel-key collisions, Escape is a fallback, and reviews require **Continue**. Cancelling a review discards the flow; disposal cannot serve as acceptance of a save review. Chat history, automatic compaction/retries, and parent usage accounting are not added.

## Verification evidence

- `npm run check`: passed builds, Biome, package boundaries, and every workspace typecheck.
- `npm test`: passed 14,497 tests in 769 files; two existing platform/filesystem-specific tests were skipped (`test/macos-install.test.ts` and the native case-insensitive filesystem case in `pi-sync`). No changed test is skipped on this Linux host.
- The focused fullscreen/native-message, UI, command, and generated-Jiti suites passed 55 tests. Native-renderer parity covers Markdown, backgrounds, later-question spacing, tool success/error, streaming/finalization, theme changes, and sanitized fallback tool metadata. Existing child, draft, skill, and profile regressions also passed in the full gate.
- `npm run package:pack -- starship`: passed. The actual tarball contains 152 files, including all five new source modules, the generated runtime, and the skill/references; test fixtures are excluded. SHA-1: `a27d86ad15be8efa9876c9a3e88f178241af3723`.
- Installed that tarball in a separate temporary npm root with production dependencies and no automatic Pi peer installation, then loaded it through the real Pi CLI/Jiti runtime.
- `uv run python packages/pi-starship/test/settings-chat-smoke.py`: passed discard and save scenarios with both regular and fullscreen parent TUIs for the local package directory. Running the same harness against the separately installed tarball also passed all four scenarios, for eight real-CLI scenarios in total. Each scenario executes `read`, `write`, and `edit` over two turns, reads an installed skill reference, verifies unchanged active bytes before save, checks History/save or discard, confirms zero main-thread messages, and checks draft cleanup. No reload or external model provider is used.
- `npm run changeset:status -- --output <temporary-json-path>`: exited successfully and selected only pi-starship for a minor release. It also printed existing Kit-floor notices for unrelated packages; those manifests were not changed.

The fenced-code-aware required-heading audit passed for all 37 publishable package READMEs. Existing Profiles navigation remains intact, including the final menu position; targeted profile integration, preview cleanup, and generated-runtime tests passed after correcting the initial menu-order regression.

For the initial implementation before the fullscreen follow-up, separate-process `DefaultResourceLoader.reload()` samples, in milliseconds, were 401.21, 36.28, and 35.82 for the base and 42.03, 39.13, and 37.10 for the implementation. The first base sample includes a cold Jiti cache. These host-dependent samples do not establish a speed improvement or a performance threshold; the deterministic eager-graph check is the lazy-loading gate.

## Fullscreen follow-up audit

Short, dim editor-border labels replace the separate identity, status, and hint rows. Native hidden-line indicators take priority over labels; tests compare both border hooks with native Editor output at zero, narrow, and normal widths. Errors retain sanitized muted details above the preview. The fullscreen preview has a labeled upper rule and ends at the terminal bottom, matching the saved footer's position; nothing follows it. The review/action menu retains an explicit lower rule. Both use the same preview helper and callback-provided theme roles. Footer content, colors, glyphs, and responsive width are unchanged. Full preview rows are retained, including configurations with more than four lines. Error details yield first; when the complete preview cannot fit beside the editor, the preview is hidden rather than clipped. Tests cover six terminal heights, multiline colored/CJK output, boundary placement, cursor retention, zero dimensions, theme changes, and native editing/paste.

The fullscreen workspace uses a 100%-width, 100%-height, zero-margin overlay through `ctx.ui.custom()`. Kit retains cancellation, owner checks, and disposal; the extension never hides, reorders, or takes ownership of unrelated overlays. Native tool rendering receives terminal-safe copies of tool names, IDs, arguments, paths, results, and details, without mutating the agent transcript. Incomplete streaming tool arguments are not rendered as tool cards. Tool images are disabled, so this view owns no image-conversion tasks or extra timers.

| Touched MUST rules | Verification |
| --- | --- |
| TUI-only entry, width/height bounds, focused editor row, native editing/paste, callback chrome roles | Tests for overlay options, full-height layout, fixed preview position, zero/narrow sizes, focus, keybinding tables, paste, and theme changes |
| Release owned UI/resources and block stale work after cancellation/disposal/replacement/shutdown | Existing lifecycle tests, disposed-render guard tests, and save/discard PTY smokes in both parent modes |
| Sanitize terminal input before display layout and preserve model-visible history | Native-component parity and malicious tool-name/path/result tests; raw transcript equality assertions |
| Preserve generated lazy boundaries and exact emitted relative imports | Builder eager-graph/import tests, Jiti-loader test, and independently installed tarball smokes |

The final full-suite run passed. An earlier run had one intermittent failure in the unchanged `pi-codex-compact/test/context-management-runtime.test.ts` repeat-compaction case (`3 !== 4` requests). Its 13 focused tests and subsequent complete suite runs passed without modifying that package. No gate was waived.

## External handoff and release limits

Live-provider confirmation is optional and remains unverified. The responsible role is an authorized provider account owner; prerequisites are working Pi authentication and explicit permission to spend provider quota. Run a short configuration conversation and verify real-provider tool interoperability. Local deterministic provider tests do not establish that result. Stop after one clear external or entitlement failure rather than retrying automatically. Do not describe live-provider compatibility as verified until this check is performed.

The automated terminal smoke targets Linux PTYs. Other operating systems, physical terminal/IME behavior, and subjective visual usability are not established by that smoke; platform maintainers can run the same workflow on their target terminal. These external checks do not block completion of the coding plan, but their behavior must remain identified as unverified.

No package publication, version tag, visibility change, or release workflow dispatch is authorized. The deliverable is a reviewed pull request, not a release.
