import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalText as safe } from "@narumitw/pi-tui-kit/terminal-text";
import type { Route } from "./command.ts";
import { prepareOperation, scanInventory } from "./filesystem.ts";
import { discoverRepository, downloadBundles, parseRepository } from "./github.ts";
import { applyRegistration, customLocation, loadLocations, previewRegistration } from "./locations.ts";
import type {
  Environment,
  Guard,
  Inventory,
  Location,
  OperationRequest,
  OperationResult,
  PreparedBatch,
  RegistrationPlan,
  RegistrationScope,
  RepositorySnapshot,
} from "./types.ts";

export const HELP = [
  "/skills opens this manager. /skills add [owner/repo], remove, and move are interactive shortcuts.",
  "Public GitHub repositories only. Each add uses one fixed commit below skills/.",
  "Review unfamiliar SKILL.md files and supporting programs before installation. Installation does not run them.",
  "Complete directories are copied. References outside each selected bundle are not copied or rewritten.",
  "Project means the current Pi working directory. Shared locations can also be read by compatible agents.",
  "Existing destinations are skipped; duplicate names can still conflict under Pi's native discovery rules.",
  "Browse lists scanned local locations, not every loaded Pi resource. Linked, standalone, ancestor, and package-cache resources are read-only.",
  "Custom paths can be registered in native project/user skills settings, or copied without registration.",
  "Before confirmation, cancellation changes no installed skills or settings. Confirmed batches can finish partially.",
  "Do not run concurrent mutations from separate Pi processes. External filesystem edits are not locked.",
  "Reload is explicit. Removing a skill does not remove instructions already in conversation history.",
];

export const defaultServices = {
  loadLocations,
  scanInventory,
  discoverRepository,
  downloadBundles,
  prepareOperation,
  customLocation,
  previewRegistration,
  applyRegistration,
};
export type Services = typeof defaultServices;

type Screen =
  | "main"
  | "source"
  | "fetch"
  | "select"
  | "preview"
  | "destination"
  | "custom"
  | "registration"
  | "ready"
  | "review"
  | "browse"
  | "help"
  | "inventory-path"
  | "inventory-ready";
type Action =
  | "begin"
  | "source"
  | "discover"
  | "toggle"
  | "continue"
  | "target"
  | "custom"
  | "registration"
  | "prepare"
  | "confirm"
  | "inventory-path"
  | "scan";

interface State {
  mode: OperationRequest["kind"];
  source: string;
  repository?: RepositorySnapshot;
  selected: Set<string>;
  locations: Location[];
  inventory: Inventory;
  warnings: string[];
  target?: Location;
  registration?: RegistrationPlan;
  registrationScope: RegistrationScope;
  batch?: PreparedBatch;
  confirmed: boolean;
  extra?: Location;
  afterScan: "browse" | "select";
}

function actionGuard(owner: Guard, signal: AbortSignal): Guard {
  return {
    signal: AbortSignal.any([owner.signal, signal]),
    check() {
      owner.check();
      signal.throwIfAborted();
    },
    isProjectTrusted: owner.isProjectTrusted,
  };
}

function selectedLocals(state: State) {
  return state.inventory.skills.filter((skill) => state.selected.has(skill.id) && !skill.readOnlyReason);
}

function selectionItems(state: State, rpc: boolean) {
  if (state.mode === "add") {
    return (state.repository?.skills ?? []).map((skill) => ({
      id: skill.id,
      label: rpc ? `${safe(skill.name)} · ${safe(skill.directory)}` : skill.name,
      description: `${skill.directory} — ${skill.description}`,
      searchText: `${skill.directory} ${skill.description}`,
      selected: state.selected.has(skill.id),
      disabled: Boolean(skill.disabledReason),
      disabledReason: skill.disabledReason,
    }));
  }
  return state.inventory.skills.map((skill) => ({
    id: skill.id,
    label: `${safe(skill.name)} · ${safe(skill.location.label)}${rpc ? ` · ${safe(skill.path)}` : ""}`,
    description: `${skill.path}${skill.warnings.length ? ` — ${skill.warnings.join("; ")}` : ""}`,
    searchText: `${skill.path} ${skill.description}`,
    selected: state.selected.has(skill.id),
    disabled: Boolean(skill.readOnlyReason),
    disabledReason: skill.readOnlyReason,
  }));
}

function browseItems(state: State, rpc: boolean, selectedOnly = false) {
  if (selectedOnly && state.mode === "add") {
    return (state.repository?.skills ?? [])
      .filter((skill) => state.selected.has(skill.id))
      .map((skill) => ({
        id: skill.id,
        label: rpc ? `${safe(skill.name)} · ${safe(skill.directory)}` : skill.name,
        description: skill.directory,
        statusText: skill.warnings.join("; "),
        detailDocument: { content: skill.content, format: { kind: "text" as const } },
      }));
  }
  return state.inventory.skills
    .filter((skill) => !selectedOnly || state.selected.has(skill.id))
    .map((skill) => ({
      id: skill.id,
      label: `${safe(skill.name)} · ${safe(skill.location.label)}${rpc ? ` · ${safe(skill.path)}` : ""}`,
      description: skill.path,
      statusText: skill.readOnlyReason ?? (skill.warnings.join("; ") || "Detected on disk"),
      detailDocument: {
        content: `${safe(skill.path)}\n${skill.warnings.map(safe).join("\n")}\n\n${skill.content}`,
        format: { kind: "text" as const },
      },
    }));
}

export function createSkillsMenu(
  state: State,
  start: Screen,
  env: Environment,
  owner: Guard,
  services: Services,
  mode: ExtensionCommandContext["mode"] = "tui",
) {
  const rpc = mode === "rpc";
  return defineMenu<State, Screen, Action>({
    start,
    screens: {
      main: () => ({
        kind: "actions",
        title: "Skills",
        lines: [`Workspace: ${safe(env.cwd)}`, ...state.warnings],
        hint: "close",
        items: [
          { id: "browse", label: "Browse installed skills", to: "browse" },
          { id: "add", label: "Add from GitHub", action: "begin" },
          { id: "remove", label: "Remove skills", action: "begin" },
          { id: "move", label: "Move skills", action: "begin" },
          { id: "scan", label: "Scan custom directory", to: "inventory-path" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
      }),
      source: () => ({
        kind: "input",
        title: "GitHub repository",
        placeholder: "owner/repo",
        initialValue: state.source,
        action: "source",
      }),
      fetch: () => ({
        kind: "actions",
        title: "Add from GitHub",
        lines: [`Repository: ${safe(state.source)}`, "Public source only. No repository programs will be executed."],
        items: [{ id: "discover", label: "Find skills", action: "discover", busyLabel: "Finding skills…" }],
      }),
      select: () => ({
        kind: "multiSelect",
        title: `${state.mode === "add" ? "Add" : state.mode === "remove" ? "Remove" : "Move"} skills`,
        lines:
          state.mode === "add"
            ? [
                `${safe(state.repository?.repository ?? "")} @ ${safe(state.repository?.commit ?? "")}`,
                "Select bundles; no files change until final confirmation.",
              ]
            : [
                "Select exact local paths. Checked names at different locations are separate skills.",
                ...state.inventory.warnings,
              ],
        items: selectionItems(state, rpc),
        action: "toggle",
        enableSearch: true,
        viewportSize: 10,
        actions: [
          {
            id: "continue",
            label: "Continue",
            action: "continue",
            busyLabel: state.mode === "remove" ? "Preparing removal…" : undefined,
          },
          { id: "preview", label: "Preview selected skills", to: "preview" },
          ...(state.mode === "add"
            ? []
            : [{ id: "scan", label: "Scan custom directory", to: "inventory-path" as const }]),
        ],
      }),
      preview: () => ({
        kind: "browse",
        title: "Selected skill contents",
        items: browseItems(state, rpc, true),
        enableDetailSearch: true,
      }),
      destination: () => ({
        kind: "choice",
        title: "Install destination",
        action: "target",
        initialItemId: "project-pi",
        lines: ["Project: this working directory. User: affects other projects. Shared: visible to compatible agents."],
        items: [
          ...state.locations.map((location) => ({
            id: location.id,
            label: rpc ? `${safe(location.label)} · ${safe(location.path)}` : location.label,
            description: location.path,
            disabled: Boolean(location.readOnlyReason),
            disabledReason: location.readOnlyReason,
          })),
          { id: "custom", label: "Custom directory", description: "Enter a skill-container path" },
        ],
      }),
      custom: () => ({
        kind: "input",
        title: "Custom skill directory",
        placeholder: "/path/to/skills",
        action: "custom",
      }),
      registration: () => ({
        kind: "choice",
        title: "Custom directory loading",
        action: "registration",
        initialItemId: "project",
        lines: [safe(state.target?.path ?? "")],
        items: [
          {
            id: "project",
            label: "Register for project",
            description: "Add a native project skills path",
            disabled: !env.isProjectTrusted(),
            disabledReason: "Project is not trusted",
          },
          {
            id: "user",
            label: "Register for user",
            description: "Add a native user skills path; affects other projects",
          },
          { id: "none", label: "Copy only", description: "Does not make this directory discoverable to Pi" },
        ],
      }),
      ready: () => ({
        kind: "actions",
        title: "Prepare changes",
        lines: [
          safe(state.target?.path ?? ""),
          `Custom registration: ${state.registrationScope}`,
          "Bundles keep supporting files; external references are not bundled.",
        ],
        items: [
          { id: "prepare", label: "Prepare review", action: "prepare", busyLabel: "Preparing selected bundles…" },
        ],
      }),
      review: () => ({
        kind: "review",
        title: "Confirm skill changes",
        viewportSize: "adaptive",
        enableSearch: true,
        content: [
          ...(state.repository && state.mode === "add"
            ? [`Source: ${safe(state.repository.repository)} @ ${safe(state.repository.commit)}`]
            : []),
          ...(state.batch?.summary.map(safe) ?? []),
          ...(state.registration
            ? [
                `Register ${safe(state.registration.storedPath)} in ${safe(state.registration.settingsPath)} (skills array).`,
              ]
            : []),
          ...(state.registrationScope === "none" && state.target?.id.startsWith("custom:")
            ? ["Copy only: this directory may not be discoverable."]
            : []),
          ...duplicateWarnings(state),
          "No overwrite or merge. Removal is permanent. A cancelled confirmed batch may be partially complete.",
        ].join("\n"),
        confirm: { id: "confirm", label: "Apply changes", action: "confirm" },
      }),
      browse: () => ({
        kind: "browse",
        title: "Installed local skills",
        lines: ["Detected on disk, not a complete list of active Pi resources.", ...state.inventory.warnings],
        items: browseItems(state, rpc),
        enableDetailSearch: true,
      }),
      help: () => ({ kind: "detail", title: "Skills help", lines: HELP }),
      "inventory-path": () => ({
        kind: "input",
        title: "Scan custom skill directory",
        placeholder: "/path/to/skills",
        action: "inventory-path",
      }),
      "inventory-ready": () => ({
        kind: "actions",
        title: "Scan local directory",
        lines: [safe(state.extra?.path ?? "")],
        items: [{ id: "scan", label: "Scan directory", action: "scan", busyLabel: "Scanning local skills…" }],
      }),
    },
    actions: {
      begin: ({ itemId }) => {
        if (itemId !== "add" && itemId !== "remove" && itemId !== "move") throw new Error("Unknown operation");
        owner.check();
        state.mode = itemId;
        state.selected.clear();
        state.batch = undefined;
        state.target = undefined;
        state.registration = undefined;
        state.registrationScope = "none";
        state.afterScan = "select";
        return { kind: "to", screen: itemId === "add" ? "source" : "select" };
      },
      source: ({ value }) => {
        owner.check();
        state.source = parseRepository(value ?? "");
        return { kind: "to", screen: "fetch" };
      },
      discover: async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        const repository = await services.discoverRepository(state.source, guard.signal);
        guard.check();
        state.repository = repository;
        state.selected.clear();
        return { kind: "to", screen: "select" };
      },
      toggle: ({ itemId, selected }) => {
        owner.check();
        if (selected) state.selected.add(itemId);
        else state.selected.delete(itemId);
        state.batch = undefined;
        return { kind: "stay" };
      },
      continue: async ({ signal }) => {
        owner.check();
        if (state.selected.size === 0) throw new Error("Select at least one skill");
        if (state.mode !== "remove") return { kind: "to", screen: "destination" };
        const guard = actionGuard(owner, signal);
        const batch = await services.prepareOperation({ kind: "remove", skills: selectedLocals(state) }, guard);
        guard.check();
        state.batch = batch;
        return { kind: "to", screen: "review" };
      },
      target: ({ itemId }) => {
        owner.check();
        state.registration = undefined;
        state.registrationScope = "none";
        if (itemId === "custom") return { kind: "to", screen: "custom" };
        const target = state.locations.find((location) => location.id === itemId);
        if (!target || target.readOnlyReason) throw new Error("Destination is unavailable");
        state.target = target;
        return { kind: "to", screen: "ready" };
      },
      custom: ({ value }) => {
        owner.check();
        const target = services.customLocation(value ?? "", env);
        if (target.readOnlyReason) throw new Error(target.readOnlyReason);
        state.target = target;
        return { kind: "to", screen: "registration" };
      },
      registration: ({ itemId }) => {
        owner.check();
        if (itemId !== "project" && itemId !== "user" && itemId !== "none")
          throw new Error("Unknown registration scope");
        state.registrationScope = itemId;
        return { kind: "to", screen: "ready" };
      },
      prepare: async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        guard.check();
        const target = state.target;
        if (!target) throw new Error("Choose a destination");
        const registration = await services.previewRegistration(target.path, state.registrationScope, env, guard);
        guard.check();
        let request: OperationRequest;
        if (state.mode === "add") {
          if (!state.repository) throw new Error("Find repository skills first");
          const bundles = await services.downloadBundles(state.repository, [...state.selected], guard.signal);
          guard.check();
          request = { kind: "add", target, bundles };
        } else request = { kind: "move", target, skills: selectedLocals(state) };
        const batch = await services.prepareOperation(request, guard);
        guard.check();
        state.registration = registration;
        state.batch = batch;
        return { kind: "to", screen: "review" };
      },
      confirm: () => {
        owner.check();
        if (!state.batch) throw new Error("Prepare changes first");
        state.confirmed = true;
        return { kind: "close" };
      },
      "inventory-path": ({ value }) => {
        owner.check();
        state.extra = services.customLocation(value ?? "", env);
        return { kind: "to", screen: "inventory-ready" };
      },
      scan: async ({ signal }) => {
        const guard = actionGuard(owner, signal);
        if (!state.extra) throw new Error("Enter a directory");
        const locations = [...state.locations.filter((location) => location.path !== state.extra?.path), state.extra];
        const inventory = await services.scanInventory(locations, guard);
        guard.check();
        state.locations = locations;
        state.inventory = inventory;
        return { kind: "to", screen: state.afterScan };
      },
    },
  });
}

function duplicateWarnings(state: State) {
  if (state.mode !== "add") return [];
  const selected = state.repository?.skills.filter((skill) => state.selected.has(skill.id)) ?? [];
  return selected.flatMap((candidate) => {
    const existing = state.inventory.skills.filter((skill) => skill.name === candidate.name);
    return existing.map(
      (skill) =>
        `Name conflict: ${safe(candidate.name)} also exists at ${safe(skill.path)}. Pi decides discovery precedence.`,
    );
  });
}

export async function showSkillsMenu(
  ctx: ExtensionCommandContext,
  route: Route,
  env: Environment,
  owner: Guard,
  services: Services = defaultServices,
): Promise<boolean> {
  const onError = (_ctx: unknown, error: unknown) => {
    owner.check();
    ctx.ui.notify(safe(error instanceof Error ? error.message : String(error)), "error");
  };
  const initial = await runTask(ctx, {
    label: route.repository ? "Finding repository skills…" : "Scanning local skills…",
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    onError,
    task: async ({ signal }) => {
      const guard = actionGuard(owner, signal);
      const locations = await services.loadLocations(env, guard);
      guard.check();
      const inventory = await services.scanInventory(locations.locations, guard);
      guard.check();
      const repository = route.repository
        ? await services.discoverRepository(route.repository, guard.signal)
        : undefined;
      guard.check();
      return { locations, inventory, repository };
    },
  });
  owner.check();
  if (initial.kind !== "completed") return false;
  const state: State = {
    mode: route.kind === "remove" || route.kind === "move" ? route.kind : "add",
    source: route.repository ?? "",
    repository: initial.value.repository,
    selected: new Set(),
    locations: initial.value.locations.locations,
    inventory: initial.value.inventory,
    warnings: initial.value.locations.warnings.map(safe),
    registrationScope: "none",
    confirmed: false,
    afterScan: route.kind === "main" ? "browse" : "select",
  };
  const start: Screen =
    route.kind === "main" ? "main" : route.kind === "add" && !route.repository ? "source" : "select";
  await runMenu(ctx, createSkillsMenu(state, start, env, owner, services, ctx.mode), {
    getState: () => state,
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    onError,
  });
  owner.check();
  if (!state.confirmed || !state.batch) return false;
  const batch = state.batch;
  let results: OperationResult[] = [];
  const applying = await runTask(ctx, {
    label: "Applying skill changes…",
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    onError,
    task: async ({ signal }) => {
      const guard = actionGuard(owner, signal);
      results = await batch.apply(
        guard,
        state.registration
          ? () => services.applyRegistration(state.registration as RegistrationPlan, env, guard)
          : undefined,
      );
      // Keep plain partial results even when the task was cancelled during a safe step.
      return results;
    },
  });
  owner.check();
  if (results.length === 0 && applying.kind !== "completed") return false;
  return showResults(ctx, results, owner);
}

async function showResults(ctx: ExtensionCommandContext, results: OperationResult[], owner: Guard) {
  let reload = false;
  const content = results
    .map((result) =>
      [result.status.toUpperCase(), result.source, result.destination, result.message]
        .filter((value): value is string => value !== undefined)
        .map(safe)
        .join("\n"),
    )
    .join("\n\n");
  const counts = [...new Set(results.map((result) => result.status))].map(
    (status) => `${status}: ${results.filter((result) => result.status === status).length}`,
  );
  const menu = defineMenu<undefined, "summary" | "results", "reload">({
    start: "summary",
    screens: {
      summary: () => ({
        kind: "actions",
        title: "Skill changes",
        lines: counts,
        hint: "close",
        items: [
          { id: "results", label: "View results", to: "results" },
          ...(results.some((result) => result.changed)
            ? [{ id: "reload", label: "Reload now", action: "reload" as const }]
            : []),
          { id: "later", label: "Close without reload", close: true },
        ],
      }),
      results: () => ({
        kind: "review",
        title: "Operation results",
        content,
        viewportSize: "adaptive",
        enableSearch: true,
      }),
    },
    actions: {
      reload: () => {
        owner.check();
        reload = true;
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal: owner.signal, isCurrent: () => !owner.signal.aborted });
  owner.check();
  return reload;
}
