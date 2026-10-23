# pi-starship settings side-thread verification

## Outcome

`/starship` → **Configure with agent…** opens a separate, in-memory configuration agent. It explicitly loads the bundled skill and exposes only `read`, `write`, and `edit`. Agent mutations affect a private draft. Valid changes redraw the footer preview without reload; only a reviewed and confirmed user save publishes active settings.

## Architecture and semantic audit

The implementation uses the public `Agent` from Pi agent-core, not a default SDK session. `modelRegistry.streamSimple()` retains the parent's request-time authentication, custom providers, header transforms, and supported virtual-model routing without discovering parent extensions or creating a second credential store. The model/thinking selection and ordered tools are captured at flow start. Consecutive normalized request tests preserve the existing system/tool/message prefix. Each new chat is a separate prefix epoch with fixed draft/resource paths and an independent routing session ID.

The owning extension retains all settings policy. Core file-tool operations enforce the draft boundary after native path resolution. Reads use an immutable active-file snapshot or approved package/draft content. Writes and edits accept only the private draft; symlinks, hard links, non-regular files, stale owners, and oversized drafts are rejected. An outer queue orders reads, mutations, and their diagnostics; core mutators retain their own file-path queue. Invalid draft bytes remain available for repair while the last valid preview stays active.

Preview calls only the existing redraw path; it does not restart module collectors or activate draft-enabled commands/network requests. Publication reuses the existing managed History and guarded atomic commit implementation. The save boundary checks disk bytes/identity, loaded revision, draft revision, and session ownership. Archive/write/apply failures, invalid-original repair, missing-file creation, repeat attempts, conflicts, and cancellation have focused tests.

Lifecycle review covers user cancellation, component disposal, native confirmation, partial initialization, session replacement, reload, and shutdown. The child is aborted and awaited before draft removal. UI subscriptions and abort listeners are removed. Tools remain disabled after a cleanup failure, and draft removal can be retried after permissions recover. Session generation and `sessionManager` ownership prevent stale preview or publication callbacks. Shutdown awaits the registered child cleanup.

The UI uses Pi's native `Editor` and Kit framing/review primitives. Native submission already expands paste markers; moving an unsubmitted draft uses `getExpandedText()`. Input-action collisions take precedence over review cancellation. Table-driven tests cover aliases, modifier order, printable input, legacy control collisions, Kitty/modifyOtherKeys packets, invalid bindings, native editing fallbacks, and Escape fallback. Ctrl+C remains hard discard. Display controls are removed before transcript/diagnostic layout; raw agent payloads are unchanged.

## Guides and decisions

Reviewed applicable MUST rules and touched-area checklists in `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. Skill changes follow `create-agent-skills`; child instructions follow the general `prompt-gpt` principles without assuming one provider or model.

The final diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope. No implementation question or required agent check remains open. There are no accepted exceptions to the required root gates.

The existing TOML settings format, single source forwarder, generated entrypoint, and command routes remain unchanged. The new child runtime stays behind a dynamic command import; generated-import and eager-graph tests cover that boundary. The only added Pi peer is agent-core, with its matching workspace development dependency and lockfile entry. A minor Changeset records the published behavior change.

Intentional UI differences are documented in the package README: the compact view shows recent messages, full reviews expose the transcript/document, editor actions win cancel-key collisions, Escape is a fallback, and reviews require **Continue**. Cancelling a review discards the flow; disposal cannot serve as acceptance of a save review. Chat history, automatic compaction/retries, and parent usage accounting are not added.

## Verification evidence

- `npm run check`: passed builds, Biome, package boundaries, and every workspace typecheck.
- `npm test`: passed 14,490 tests in 768 files; two existing platform/filesystem-specific tests were skipped (`test/macos-install.test.ts` and the native case-insensitive filesystem case in `pi-sync`). No changed test is skipped on this Linux host.
- Focused child, draft, UI, command, and skill suites: 67 tests passed; generated Jiti lazy-boundary and profile regression coverage also passed in the full gate.
- `npm run package:pack -- starship`: passed. The actual tarball contains 151 files, including all four new source modules, the generated runtime, and the skill/references; test fixtures are excluded. SHA-1: `175b70909345f4661d997680b0f60783e7279c1f`.
- Installed that tarball in a separate temporary npm root with production dependencies and no automatic Pi peer installation, then loaded it through the real Pi CLI/Jiti runtime.
- `uv run python packages/pi-starship/test/settings-chat-smoke.py`: passed both discard and save scenarios for the local package directory. Running the same harness against the separately installed tarball also passed both scenarios. Each scenario executes `read`, `write`, and `edit` over two turns, reads an installed skill reference, verifies unchanged active bytes before save, checks History/save or discard, confirms zero main-thread messages, and checks draft cleanup. No reload or external model provider is used.
- `npm run changeset:status -- --output <temporary-json-path>`: exited successfully and selected only pi-starship for a minor release. It also printed existing Kit-floor notices for unrelated packages; those manifests were not changed.

The fenced-code-aware required-heading audit passed for all 37 publishable package READMEs. Existing Profiles navigation remains intact, including the final menu position; targeted profile integration, preview cleanup, and generated-runtime tests passed after correcting the initial menu-order regression.

Separate-process `DefaultResourceLoader.reload()` samples, in milliseconds, were 401.21, 36.28, and 35.82 for the base and 42.03, 39.13, and 37.10 for the implementation. The first base sample includes a cold Jiti cache. These host-dependent samples do not establish a speed improvement or a performance threshold; the deterministic eager-graph check is the lazy-loading gate.

## External handoff and release limits

Live-provider confirmation is optional and remains unverified. The responsible role is an authorized provider account owner; prerequisites are working Pi authentication and explicit permission to spend provider quota. Run a short configuration conversation and verify real-provider tool interoperability. Local deterministic provider tests do not establish that result. Stop after one clear external or entitlement failure rather than retrying automatically. Do not describe live-provider compatibility as verified until this check is performed.

The automated terminal smoke targets Linux PTYs. Other operating systems, physical terminal/IME behavior, and subjective visual usability are not established by that smoke; platform maintainers can run the same workflow on their target terminal. These external checks do not block completion of the coding plan, but their behavior must remain identified as unverified.

No package publication, version tag, visibility change, or release workflow dispatch is authorized. The deliverable is a reviewed pull request, not a release.
