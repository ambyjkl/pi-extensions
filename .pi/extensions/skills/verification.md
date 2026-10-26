# pi-skills verification and terminal handoff

The implementation follows the approved pi-skills plan. It remains a project-local extension with no workspace, manifest, root test registration, Changeset, model tools, loader hook, or publication change.

## Deterministic and runtime evidence

Completed on 2026-10-26:

- Installed repository dependencies with `npm install`; the lockfile and manifests stayed unchanged.
- Rebuilt the Kit workspace before consumer tests and checked its workspace resolution with `npm ls @narumitw/pi-tui-kit`.
- Local NodeNext no-emit TypeScript and warning-free Biome checks passed.
- Extension-local Vitest passed 294 tests across nine files, including command grammar, native validation branches, bounded GitHub transport, settings, tree operations, actual filesystem/UI integration, Kit TUI/RPC behavior, lifecycle races, and Pi's Jiti loader.
- Root `npm run check` passed builds, Biome, package boundaries, and workspace typechecks.
- Root `npm test` passed 14,974 tests, with two existing skipped tests and no unhandled errors; the local suite runs separately.
- `test/runtime-smoke.mjs` passed through the installed Pi CLI in RPC mode for both explicit loading and trusted-project auto-discovery. Each case exercised seven dialogs, actual removal, command-triggered reload, retained command registration, and unchanged message serialization across an ordinary Help/menu interaction. It used isolated home/agent/project directories and made no model requests.
- `test/headless-smoke.mjs` verified observable rejection in real print and JSON modes before skill mutation; JSON stdout remained valid protocol records. It used no credentials or model requests.
- A read-only live GitHub smoke found 29 candidates in `narumiruna/skills` at commit `079415193cdacb7947dc0dde9526bda7dd659f43`. It downloaded and hash-verified `skills/default/write-plans`, including its applicable notice, as two files totaling 5,809 bytes. No skill was installed into a real user or project location.

The test suite uses injected I/O failures for permission, cross-device rename, failed registration, partial recursive deletion, and failed recovery. It does not require a real permission denial, mount boundary, or live provider account. Each Vitest test keeps the configured 5,000 ms timeout. Subprocess operation deadlines in the RPC smoke begin only after its server-observable readiness handshake.

## Semantic audit

Applied [extension conventions](../../../docs/extension-conventions.md) and [settings conventions](../../../docs/extension-settings.md), not only the root gates:

- **Correctness and compatibility:** exact command grammar and completions, mode-specific results, native warning equivalence, full-bundle ignore rules, preserved duplicate local paths, and explicit catalog refresh.
- **Security:** pinned Git object hashes, credential-free fixed-host access, redirect refusal, bounded streamed bodies, path/type checks, terminal-display sanitization, exact mutation paths, read-only links/caches/ancestor roots, and secret-safe settings errors.
- **Lifecycle:** factory registration without owned background work, session-manager keys, owner/generation checks, disposal/abort/drain, startup/shutdown races, and no old-context use after reload.
- **Persistence and data loss:** scope-specific native arrays, unknown-field/filter preservation, malformed-file protection, snapshot staleness, complete queued read-modify-write operations, retained persistence errors, no overwrite, source verification, and explicit partial-batch/recovery results.
- **Regression and scope:** no changed existing command routes, no ordinary context/tool transformations, no cross-extension dependencies, no packaged extension changes, and no dependency or root workflow changes.

Independent review identified three failure classes. The final implementation addresses all occurrences and has representative regression tests:

1. Partial deletion followed by abort/session invalidation now drains missing-entry recovery as part of the current safe step. Tests cover cancellation during deletion and recovery for removal and copied moves, complete-root deletion, next-item cancellation, original modes, and actual recovery failure. Repair uses captured plain-data authorization and path/root/parent identity checks, not a stale Pi context.
2. Project-relative registrations now use a `./` prefix. Table-driven tests exercise literal `!`, `+`, `-`, `~`, and `~/` path branches through Pi's actual resource loader and confirm that the selected directory is discoverable.
3. RPC skill and destination labels now include identifying paths. Tests select one of two identical names in the same scope by its actual path rather than an arbitrary numeric suffix.

A final complete-diff audit includes the changes made after that independent review and the extension-local smoke scripts. It also covers native persistence completing before cancellation: regression tests verify the committed file and report registration as unconfirmed instead of falsely claiming rollback. A second independent read-only review found no remaining findings in the corrected source. Package packing is not applicable: no package metadata, published runtime, dependency floor, or publication behavior changed.

## Deliberate limits

Pi owns native settings publication through its public `SettingsManager`; this extension does not replace that implementation or claim extension-owned atomic settings storage. The native queue protects same-process file operations, not concurrent cross-process edits of the same array.

Cross-process mutation and arbitrary external filesystem edits are unsupported. Identity and content checks detect changes at defined boundaries, not all possible hostile races. A real device or mount can still fail during recovery; failures identify the remaining paths rather than claim that cleanup always succeeds.

The default targets and selected concrete roots are an inventory boundary, not a complete mirror of Pi's resource resolver. Ancestor and package resources can still affect native collision precedence. Symlinked roots/skills, standalone Markdown, package caches, and ancestor roots are read-only; hard-linked bundles cannot be moved.

Standard Kit screens own rendering, keybindings, frame layout, and RPC adaptation. Consumer tests cover non-default selector keys, filtering/checked IDs, preview return, native input editing/paste, narrow widths, constrained heights, resize, cancellation, and disposal. They do not establish the physical terminal input pipeline.

## External handoff

Responsible role: maintainer with an interactive terminal. Prerequisite: installed repository dependencies and built Kit output.

Run the documented interactive load command:

```sh
pi --no-extensions -e ./.pi/extensions/skills/index.ts
```

Verify checkbox selection/search, exact path review, non-default keys, IME positioning, bracketed paste, mouse interaction, fullscreen and regular mode, narrow resize, hard cancellation, trusted-project auto-discovery, and `/reload`. Expected result: standard Pi/Kit interaction, no unintended mutation, and refreshed skill discovery only after explicit reload.

These physical-terminal paths remain unverified because the agent must not launch an interactive TUI from Bash. The automated loader and RPC smokes are completed evidence, not a substitute for that terminal review. No package publication, visibility change, version tag, or release workflow is authorized by this handoff.
