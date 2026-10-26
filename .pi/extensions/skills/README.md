# pi-skills

Manage local skill bundles from `/skills`. This project-local extension uses Pi TUI Kit for menus, selection, previews, tasks, and TUI/RPC adaptation. Pi still owns skill discovery, project trust, filtering, and name-collision precedence.

## Setup

From the repository root:

```sh
npm install
npm --workspace @narumitw/pi-tui-kit run build
```

Pi discovers `.pi/extensions/skills/index.ts` after project trust is granted. In an existing session, run `/reload`. To load only this extension explicitly in an interactive terminal:

```sh
pi --no-extensions -e ./.pi/extensions/skills/index.ts
```

This is not a separately published package. It needs the repository's installed dependencies and built Kit workspace. It does not depend on another extension.

## Commands

1. `/skills` opens Browse installed skills, Add from GitHub, Remove skills, Move skills, Scan custom directory, Help, and Close.
2. `/skills add` asks for a public GitHub repository.
3. `/skills add narumiruna/skills` discovers repository skills directly.
4. `/skills remove` selects exact local paths for permanent removal.
5. `/skills move` selects local skills and their destination.

An add source accepts `owner/repo` or an exact `https://github.com/owner/repo` URL. Ref suffixes, `.git` URLs, extra URL segments, credentials, unknown routes, and trailing arguments are rejected. Remove and move do not accept a name argument because names can occur at several paths.

These commands require Pi TUI or an RPC client with extension dialogs. Print and JSON modes reject them before network or mutation work. RPC uses Kit's dialog fallback, including full identifying paths in selection labels; it does not display custom terminal components.

## Add

The default branch is resolved to one commit. Discovery searches recursively below `skills/`, including category directories such as `skills/default/` and `skills/optional/`. A directory with `SKILL.md` ends discovery for that subtree. No `skills/` directory, a truncated tree, or an incomplete response is an error.

Search and multi-select the desired skills, then choose a destination. Selection starts empty. Filtering does not change checked IDs. Preview selected skills opens read-only source views. Returning retains selected IDs; Kit owns cursor and search behavior. The repository-input flow has a Find skills action, and destination selection has a Prepare review action, so lengthy work uses Kit's cancellable task presentation.

The final review shows the repository, commit, exact paths, skipped items, native validation warnings, name conflicts in scanned locations, and any native settings change. Only Apply changes publishes bundles.

Each installation is an independent directory snapshot with the original basename, bytes, executable bits, supporting files, and applicable license notices. Repository/ancestor notices are retained under a collision-free `.pi-skills-notices` directory inside the installed bundle. Files referenced outside a selected skill directory are not copied or rewritten. There is no automatic update or provenance registry.

Pi's public loader validates metadata and complete bundles, including native ignore files. Malformed declared skill files and missing descriptions cannot be installed. Native warning-only metadata remains warning-only; a name/directory mismatch alone does not block installation.

## Locations and native settings

The default choices are:

1. Project (Pi): `<cwd>/<CONFIG_DIR_NAME>/skills`, normally `./.pi/skills`; initial selection.
2. User (Pi): `<getAgentDir()>/skills`, normally `~/.pi/agent/skills`.
3. Project (Shared): `<cwd>/.agents/skills`.
4. User (Shared): `~/.agents/skills`.
5. Custom directory: a manually entered skill-container directory.

Project means Pi's current working directory, not the repository root. Shared locations can also be discovered by compatible agents. They are not Pi-only storage. The extension never silently installs into an ancestor's skill location. Missing destinations are created only after confirmation.

A custom path has three loading choices:

1. Register for project: append a concrete path to the project Pi `skills` array.
2. Register for user: append an absolute path to the user Pi `skills` array; this affects other projects.
3. Copy only: leave settings unchanged; Pi might not discover the result.

Custom registration is part of the final review. Project-relative paths are relative to the project `.pi` directory and use a `./` prefix to preserve literal path identity. Native scope-specific arrays, filters, and unrelated fields are preserved. Malformed or invalid existing settings block registration. Registration checks its preview snapshot again, awaits native persistence, and reports retained write errors without displaying document content. Cancellation can arrive after a native write completed; an unconfirmed registration result does not imply that the write was rolled back. Inspect native settings before retrying.

Only native Pi resource settings are written; there is no extension settings file or separate loader. Disabling the extension leaves installed skills and custom registrations intact. Removing the last child does not remove its container registration.

## Browse, remove, and move

Browse reports detected-on-disk skills from the four supported roots and concrete configured custom roots. Scan custom directory can inspect another container, including a previous Copy only destination. This is not a complete list of currently loaded Pi resources. Identical names remain separate path-keyed rows, and name conflicts are warnings rather than a replacement policy. Pi keeps its own discovery precedence.

Remove confirms an exact list of directories and deletes complete selected bundles, never their container or unrelated siblings. Locally malformed `SKILL.md` directories remain visible and removable. Removal is permanent; it does not erase skill instructions already present in the conversation.

Move confirms each source-to-destination mapping. Safe same-filesystem moves use rename. Cross-filesystem moves, and moves that need custom registration, stage and verify a complete copy before source removal. The source is retained if verification or required registration fails. A registration failure stops the remaining batch; there is no automatic settings retry. Source-deletion failure reports Copied; source retained, or explicitly reports incomplete recovery with the surviving paths when recovery itself fails.

Existing destinations are skipped. There is no overwrite, merge, force, or rename feature. Equal or overlapping source/destination trees are rejected. Stale files, replaced containers, path escapes, and unsupported copy entries are rejected.

Symlinked roots and linked skills, standalone Markdown skills, ancestor roots, and package caches are read-only. Linked aliases can be inspected, but their targets are never mutation targets. A bundle containing symlinks or hard-linked files cannot be moved; removal never follows a linked target. Native glob/filter entries and file resources are not treated as writable container roots.

## Safety and cancellation

Review unfamiliar skills and their supporting programs before installation. Skills can later direct an agent to run commands or access files. Installation and validation do not execute repository programs or install dependencies. GitHub access is public-only, carries no credentials, verifies downloaded bytes against the pinned Git tree, rejects redirects and unsafe file types/paths, and does not retry rate-limit or permission failures.

Fixed limits bound requests, response bodies, candidates, files, bytes, recursion, and parallel work. The limits are internal constants, not settings. GitHub operations have a deadline; local inventory and mutation snapshots are bounded. Validation data and publication staging are cleaned up on normal completion and failure. Staging stays outside discovered skill roots.

Before final confirmation, cancellation changes no installed skills or settings. After application starts, cancellation stops subsequent items after the current safe filesystem step. Completed items remain completed. A partially failed recursive deletion drains missing-entry recovery even after cancellation or session invalidation, using captured filesystem authorization rather than the old Pi context. Recovery rechecks path and root identity and never overwrites existing data. If recovery I/O also fails, the result identifies incomplete recovery and any verified destination; inspect those paths before retrying.

The extension owns one flow per session manager. It aborts and drains owned work on disposal, session replacement, reload, and shutdown. Overlapping tree operations and native file changes are serialized within this process. Separate Pi processes and arbitrary external filesystem edits are not locked; concurrent cross-process mutation is unsupported. Snapshot checks detect changes at defined boundaries, not every possible adversarial race.

Each completed batch reports installed, removed, moved, skipped, failed, and source-retained items separately. Reload now is offered after changes; Close without reload preserves the current resource snapshot. An explicit reload changes the skill catalog and can change the model-visible prompt prefix. Ordinary manager UI does not change prompts, messages, or active tools.

## Verification

Run the extension-local checks from the repository root after building Kit:

```sh
npm exec -- tsc -p .pi/extensions/skills/tsconfig.json
npm exec -- biome check .pi/extensions/skills --error-on-warnings
npm exec -- vitest run --config .pi/extensions/skills/vitest.config.ts
node .pi/extensions/skills/test/runtime-smoke.mjs
node .pi/extensions/skills/test/headless-smoke.mjs
npm run check
npm test
```

Root checks do not automatically discover this local test suite. Tests and smokes use temporary directories, injected failures, mocked GitHub transport, Kit public harnesses, and Pi's Jiti resource loader. The RPC smoke uses isolated agent/home directories, no credentials, and no model requests; it verifies explicit loading, trusted-project auto-discovery, lazy menu loading, actual removal, command-triggered reload, and ordinary message-prefix stability.

See [verification and terminal handoff](./verification.md) for completed evidence, intentional limits, and remaining physical-terminal checks.

## Files

`index.ts` forwards registration to `skills-extension.ts`. `command.ts` owns argument grammar. `menu.ts` owns Kit screens and operation drafts. `github.ts` owns remote snapshots and bounded downloads. `metadata.ts` delegates validation to Pi. `locations.ts` owns targets and native path registration. `filesystem.ts` owns inventory, snapshots, and safe per-skill operations. `types.ts` defines contracts; `invariant.ts` checks required operation data. Tests, isolated runtime smokes, and their local configuration stay inside this directory.
