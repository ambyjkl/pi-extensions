import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRpcHarness, type RpcHarnessStep } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServices, showSkillsMenu } from "../menu.ts";
import type { Environment, Guard, RepositorySnapshot, SkillBundle } from "../types.ts";

let root: string;
let env: Environment;
let guard: Guard;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-integration-"));
  env = {
    cwd: join(root, "workspace"),
    agentDir: join(root, "agent"),
    homeDir: join(root, "home"),
    isProjectTrusted: () => true,
  };
  await mkdir(env.cwd);
  guard = { signal: new AbortController().signal, check() {}, isProjectTrusted: () => true };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const content = "---\nname: sample\ndescription: An integration skill\n---\nInstructions\n";
const snapshot: RepositorySnapshot = {
  repository: "a/b",
  commit: "a".repeat(40),
  entries: [],
  skills: [
    {
      id: "selected",
      directory: "skills/group/sample",
      directoryName: "sample",
      name: "sample",
      description: "An integration skill",
      content,
      warnings: [],
    },
    {
      id: "not-selected",
      directory: "skills/group/unselected",
      directoryName: "unselected",
      name: "unselected",
      description: "Not selected",
      content,
      warnings: [],
    },
  ],
};
const bundle: SkillBundle = {
  id: "selected",
  directoryName: "sample",
  name: "sample",
  warnings: [],
  files: [
    { path: "SKILL.md", content: Buffer.from(content), executable: false },
    { path: "references/example.txt", content: Buffer.from("  exact\tbytes\r\n"), executable: false },
    { path: "scripts/helper.sh", content: Buffer.from("#!/bin/sh\nprintf safe\\n\n"), executable: true },
  ],
};
function choice(response: string): RpcHarnessStep {
  return { kind: "select", response };
}

describe("confirmed UI to real filesystem integration", () => {
  it.each(["project-pi", "user-pi", "project-shared", "user-shared", "custom-project", "custom-user", "custom-copy"])(
    "installs only checked complete bundles into %s",
    async (target) => {
      const defaults: Record<string, [string, string]> = {
        "project-pi": ["Project (Pi)", join(env.cwd, ".pi", "skills")],
        "user-pi": ["User (Pi)", join(env.agentDir, "skills")],
        "project-shared": ["Project (Shared)", join(env.cwd, ".agents", "skills")],
        "user-shared": ["User (Shared)", join(env.homeDir, ".agents", "skills")],
      };
      const custom = target.startsWith("custom-");
      const destination = custom ? join(env.cwd, "custom-skills") : defaults[target][1];
      const steps = [choice("[ ] sample · skills/group/sample"), choice("Continue")];
      if (custom)
        steps.push(
          choice("Custom directory"),
          { kind: "input", response: destination },
          choice(
            target === "custom-project"
              ? "Register for project"
              : target === "custom-user"
                ? "Register for user"
                : "Copy only",
          ),
        );
      else steps.push(choice(`${defaults[target][0]} · ${destination}`));
      steps.push(choice("Prepare review"), choice("Apply changes"), choice("Close without reload"));
      const rpc = createRpcHarness(steps);
      const notify = vi.fn();
      const ctx = {
        cwd: env.cwd,
        mode: "rpc",
        hasUI: true,
        ui: { ...rpc.ui, notify },
      } as unknown as ExtensionCommandContext;
      const services = {
        ...defaultServices,
        discoverRepository: vi.fn(async () => snapshot),
        downloadBundles: vi.fn(async () => [bundle]),
      };
      expect(await showSkillsMenu(ctx, { kind: "add", repository: "a/b" }, env, guard, services)).toBe(false);
      rpc.assertConsumed();
      expect(notify).not.toHaveBeenCalled();
      expect(services.downloadBundles).toHaveBeenCalledWith(snapshot, ["selected"], expect.any(AbortSignal));
      expect(await readdir(destination)).toEqual(["sample"]);
      for (const file of bundle.files)
        expect(await readFile(join(destination, "sample", file.path))).toEqual(Buffer.from(file.content));
      if (process.platform !== "win32")
        expect((await stat(join(destination, "sample/scripts/helper.sh"))).mode & 0o111).not.toBe(0);
      const settings =
        target === "custom-project"
          ? join(env.cwd, ".pi/settings.json")
          : target === "custom-user"
            ? join(env.agentDir, "settings.json")
            : undefined;
      if (settings)
        expect(JSON.parse(await readFile(settings, "utf8")).skills).toContain(
          target === "custom-project" ? "./../custom-skills" : destination,
        );
      else {
        await expect(readFile(join(env.cwd, ".pi/settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(env.agentDir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await readdir(env.cwd)).some((name) => name.startsWith(".pi-skills-stage-"))).toBe(false);
    },
  );
});
