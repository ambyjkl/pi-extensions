import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import rcompare from "semver/functions/rcompare.js";
import satisfies from "semver/functions/satisfies.js";
import minVersion from "semver/ranges/min-version.js";
import validRange from "semver/ranges/valid.js";

const kitName = "@narumitw/pi-tui-kit";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// Kill the process group too: npm and Changesets can own further child processes.
export function runCommand(command, args, { cwd, env = process.env, signal, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure;
    const stop = (reason) => {
      failure = reason;
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure = error;
      }
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error("Release subprocess timed out.")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (data, stream) => {
      if (stdout.length + stderr.length + data.length > 4 * 1024 * 1024)
        stop(new Error("Release subprocess output exceeded its limit."));
      else if (stream === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.on("data", (data) => collect(data, "stdout"));
    child.stderr.on("data", (data) => collect(data, "stderr"));
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    if (signal?.aborted) abort();
  });
}

function hash(file) {
  return `sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readPackages(cwd) {
  return new Map(
    readdirSync(path.join(cwd, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(cwd, "packages", entry.name);
        const manifest = readJson(path.join(dir, "package.json"));
        return [manifest.name, { dir, manifest }];
      }),
  );
}

function stagePlan(packDir, staging, packages) {
  const document = readJson(path.join(packDir, "publish-plan.json"));
  if (document.version !== 1 || !Array.isArray(document.plan)) throw new Error("Invalid packed publish plan.");
  const names = new Set();
  for (const chunk of document.plan) {
    if (!Array.isArray(chunk)) throw new Error("Invalid packed publish chunk.");
    for (const release of chunk) {
      const pkg = packages.get(release?.name);
      if (
        !pkg ||
        pkg.manifest.version !== release.version ||
        names.has(release.name) ||
        !["publish", "tag-only"].includes(release.kind)
      ) {
        throw new Error("Packed release does not match the workspace.");
      }
      names.add(release.name);
      if (release.kind === "tag-only") {
        if (!pkg.manifest.private) throw new Error("Unexpected public tag-only entry in packed plan.");
        continue;
      }
      const relative = release.tarball?.path;
      if (
        typeof relative !== "string" ||
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/u).includes("..") ||
        typeof release.access !== "string" ||
        typeof release.tag !== "string"
      ) {
        throw new Error("Invalid packed tarball path or publish options.");
      }
      const source = path.resolve(packDir, relative);
      if (!realpathSync(source).startsWith(`${realpathSync(packDir)}${path.sep}`))
        throw new Error("Packed tarball escapes the artifact directory.");
      if (!lstatSync(source).isFile() || hash(source) !== release.tarball.integrity)
        throw new Error("Packed tarball integrity mismatch.");
      const target = path.resolve(staging, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
  return document.plan;
}

function registryFlags(manifest) {
  // Match Changesets' npm registry selection, including scoped publishConfig.
  const config = manifest.publishConfig ?? {};
  const scope = manifest.name.startsWith("@") ? manifest.name.split("/")[0] : null;
  return [
    scope && config[`${scope}:registry`] && `--${scope}:registry=${config[`${scope}:registry`]}`,
    config.registry && `--registry=${config.registry}`,
  ].filter(Boolean);
}

function npmError(result) {
  try {
    const code = JSON.parse(result.stdout)?.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// Sanitize the complete value before truncation. Never log command arguments or config.
export function sanitizeRegistryDiagnostic(value) {
  // Normalize escaped JSON delimiters, including nested JSON error summaries.
  // This is display-only; the original response remains authoritative.
  let normalized = String(value);
  for (let pass = 0; pass < 8; pass++) {
    const decoded = normalized
      // The optional suffix makes unmatched runs succeed too. Each run is
      // consumed once instead of retrying a required suffix at every backslash.
      .replace(/\\+(?:[uU]([a-fA-F0-9]{4})|([nrtbf"'/:=]))?/gu, (run, hex, delimiter) => {
        if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
        if (delimiter !== undefined) return "nrtbf".includes(delimiter) ? " " : delimiter;
        return run;
      });
    if (decoded === normalized) break;
    normalized = decoded;
  }
  // Bound normalization work and fail closed on deeper escape nesting.
  if (/\\(?:u[a-f0-9]{4}|["'/:=nrtbf])/iu.test(normalized)) return "[omitted: nested escaped output]";
  const safe = stripVTControlCharacters(normalized)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted terminal controls from diagnostic output.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
    // The legacy Actions parser accepts its prefix anywhere in a line.
    .replaceAll("##[", "## [")
    // Conservatively omit the rest of a field after credentials: npm can return
    // incomplete, escaped, or multiline values without a reliable closing delimiter.
    .replace(
      /((?:(?:proxy-)?authorization|_authToken|_auth|_password|password|token|secret|api[_-]?key)["']?\s*[:=]\s*)[\s\S]*/giu,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[\s\S]*/giu, "[REDACTED URL]")
    .replace(/\b(?:npm_[a-z0-9]+|gh[pousr]_[a-z0-9]+|github_pat_[a-z0-9_]+)\b/giu, "[REDACTED]");
  return safe.length > 2_000 ? `${safe.slice(0, 2_000)} [truncated]` : safe;
}

function registryDiagnostic(context, result, disposition, error) {
  const lines = [
    `Registry check: ${context.spec}; stage: ${context.stage}; attempt: ${context.attempt}; ${disposition}`,
    `Exit code: ${result?.code ?? "unavailable"}; npm error: ${result ? (npmError(result) ?? "unavailable") : "unavailable"}`,
  ];
  if (error !== undefined) lines.push(`Reason: ${error instanceof Error ? error.message : String(error)}`);
  if (result?.stdout) lines.push(`stdout: ${result.stdout}`);
  if (result?.stderr) lines.push(`stderr: ${result.stderr}`);
  // Prefix every line to block modern Actions commands. The sanitizer removes
  // legacy prefixes because the runner accepts them anywhere in a line.
  return lines
    .map((line) => sanitizeRegistryDiagnostic(line))
    .join("\n")
    .split(/\r?\n/u)
    .map((line) => `[registry] ${line}`)
    .join("\n");
}

async function registryRequest(context, run, args, options) {
  try {
    return await run(npm, args, options);
  } catch (error) {
    throw new Error(registryDiagnostic(context, undefined, "stop", error));
  }
}

function registryResponse(context, result, read) {
  try {
    return read();
  } catch (error) {
    throw new Error(registryDiagnostic(context, result, "stop", error));
  }
}

async function published(pkg, run, signal) {
  const spec = `${pkg.manifest.name}@${pkg.manifest.version}`;
  const context = { spec, stage: "query version", attempt: "1/1" };
  const result = await registryRequest(
    context,
    run,
    ["view", spec, "version", "--json", ...registryFlags(pkg.manifest)],
    {
      cwd: pkg.dir,
      signal,
      timeout: 15_000,
    },
  );
  if (result.code === 0 && registryResponse(context, result, () => JSON.parse(result.stdout)) === pkg.manifest.version)
    return true;
  if (result.code !== 0 && npmError(result) === "E404") {
    console.error(registryDiagnostic(context, result, "version absent; continue with publication"));
    return false;
  }
  throw new Error(`Could not establish registry state for ${spec}.\n${registryDiagnostic(context, result, "stop")}`);
}

async function available(pkg, expectedIntegrity, downloadDir, { run, signal, wait }) {
  const spec = `${pkg.manifest.name}@${pkg.manifest.version}`;
  let lastDiagnostic;
  for (let attempt = 0; attempt < 6; attempt++) {
    const context = { spec, stage: "download tarball", attempt: `${attempt + 1}/6` };
    registryResponse(context, undefined, () => signal?.throwIfAborted());
    // A cached tarball is not evidence of current registry visibility.
    const cache = mkdtempSync(path.join(downloadDir, "cache-"));
    let target = spec;
    let result;
    if (pkg.manifest.name !== kitName) {
      if (!expectedIntegrity) throw new Error("A release artifact hash is required for registry tarball retrieval.");
      context.stage = "query tarball URL";
      const metadata = await registryRequest(
        context,
        run,
        ["view", spec, "dist.tarball", "--json", "--cache", cache, ...registryFlags(pkg.manifest)],
        { cwd: pkg.dir, signal, timeout: 10_000 },
      );
      if (metadata.code !== 0) result = metadata;
      else {
        target = registryResponse(context, metadata, () => {
          const value = JSON.parse(metadata.stdout);
          if (typeof value !== "string") throw new Error("Invalid registry tarball URL.");
          const url = new URL(value);
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
            throw new Error("Invalid registry tarball URL.");
          return value;
        });
      }
    }
    // Published consumer versions are also young. Retrieve only the exact planned
    // tarball URL and verify its hash, without changing dependency age selection.
    if (!result) context.stage = "download tarball";
    result ??= await registryRequest(
      context,
      run,
      [
        "pack",
        target,
        "--ignore-scripts",
        "--json",
        "--cache",
        cache,
        "--pack-destination",
        downloadDir,
        ...registryFlags(pkg.manifest),
      ],
      { cwd: pkg.dir, signal, timeout: 10_000 },
    );
    if (result.code === 0) {
      registryResponse(context, result, () => {
        const [packed] = JSON.parse(result.stdout);
        if (
          packed?.id !== spec ||
          typeof packed.filename !== "string" ||
          path.basename(packed.filename) !== packed.filename
        )
          throw new Error(`Unexpected registry artifact for ${spec}.`);
        const tarball = path.join(downloadDir, packed.filename);
        if (!lstatSync(tarball).isFile() || (expectedIntegrity && hash(tarball) !== expectedIntegrity))
          throw new Error(`Registry artifact differs from packed release: ${spec}.`);
      });
      return;
    }
    const stop = ["E401", "E403", "ENEEDAUTH"].includes(npmError(result)) || attempt === 5;
    lastDiagnostic = registryDiagnostic(context, result, stop ? "stop" : "retry in 2000 ms");
    console.error(lastDiagnostic);
    if (stop) break;
    try {
      await wait(2_000, undefined, { signal });
    } catch (error) {
      throw new Error(registryDiagnostic({ ...context, stage: "retry wait" }, undefined, "stop", error));
    }
  }
  throw new Error(`Registry artifact is unavailable: ${spec}. Dependents were not published.\n${lastDiagnostic}`);
}

export async function publishCoordinatedPackages({
  cwd = process.cwd(),
  packDir,
  output = process.env.CHANGESETS_OUTPUT,
  run = runCommand,
  signal,
  wait = delay,
}) {
  if (!packDir || !output) throw new Error("A pack directory and CHANGESETS_OUTPUT are required.");
  mkdirSync(path.dirname(output), { recursive: true });
  // The Action must be able to read a report even if validation fails before publication.
  appendFileSync(output, "");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-coordinated-release-"));
  try {
    const packages = readPackages(cwd);
    const staging = path.join(temporary, "pack");
    mkdirSync(staging);
    const downloadDir = path.join(temporary, "registry");
    mkdirSync(downloadDir);
    const plan = stagePlan(path.resolve(cwd, packDir), staging, packages);
    // Check the artifact's own identity and dependency policy, not only the checkout.
    for (const release of plan.flat()) {
      if (release.kind !== "publish") continue;
      const result = await run("tar", ["-xOf", path.join(staging, release.tarball.path), "package/package.json"], {
        cwd,
        signal,
        timeout: 15_000,
      });
      if (result.code !== 0) throw new Error("Cannot inspect packed manifest.");
      const manifest = JSON.parse(result.stdout);
      const expected = packages.get(release.name).manifest;
      if (
        manifest.name !== expected.name ||
        manifest.version !== expected.version ||
        ["dependencies", "optionalDependencies", "peerDependencies"].some(
          (key) =>
            JSON.stringify(Object.entries(manifest[key] ?? {}).sort()) !==
            JSON.stringify(Object.entries(expected[key] ?? {}).sort()),
        )
      ) {
        throw new Error("Packed manifest does not match the workspace release.");
      }
    }
    const kit = packages.get(kitName);
    if (
      kit &&
      Object.keys({
        ...kit.manifest.dependencies,
        ...kit.manifest.optionalDependencies,
        ...kit.manifest.peerDependencies,
      }).some((name) => packages.has(name))
    )
      throw new Error("Kit must not depend on another workspace in a Kit-first release.");
    const kitRelease = plan.flat().find((release) => release.name === kitName);
    const groups = [];
    if (kitRelease) groups.push([kitRelease]);
    groups.push(
      ...plan.map((chunk) => chunk.filter((release) => release.name !== kitName)).filter((chunk) => chunk.length),
    );
    const readyKitVersions = new Set();
    for (const group of groups) {
      signal?.throwIfAborted();
      for (const release of group) {
        if (release.kind !== "publish" || release.name === kitName) continue;
        const manifest = packages.get(release.name).manifest;
        const ranges = [
          manifest.dependencies?.[kitName],
          manifest.optionalDependencies?.[kitName],
          manifest.peerDependencies?.[kitName],
        ].filter((value) => value !== undefined);
        if (!ranges.length) continue;
        if (!kit || ranges.some((range) => typeof range !== "string" || !validRange(range)))
          throw new Error("Cannot establish the required Kit version.");
        const version = ranges.every((range) => satisfies(kit.manifest.version, range))
          ? kit.manifest.version
          : ranges
              .map((range) => minVersion(range)?.version)
              .filter(Boolean)
              .sort(rcompare)
              .find((candidate) => ranges.every((range) => satisfies(candidate, range)));
        if (!version) throw new Error("Conflicting Kit runtime dependency ranges.");
        if (!readyKitVersions.has(version)) {
          await available(
            { ...kit, manifest: { ...kit.manifest, version } },
            version === kitRelease?.version ? kitRelease.tarball?.integrity : undefined,
            downloadDir,
            { run, signal, wait },
          );
          readyKitVersions.add(version);
        }
      }
      const ready = [];
      for (const release of group) {
        if (release.kind === "publish" && (await published(packages.get(release.name), run, signal))) {
          // Recover a partial run without overwriting a registry version or tagging different contents.
          await available(packages.get(release.name), release.tarball.integrity, downloadDir, { run, signal, wait });
          ready.push({ kind: "tag-only", name: release.name, version: release.version });
        } else ready.push(release);
      }
      writeFileSync(path.join(staging, "publish-plan.json"), JSON.stringify({ version: 1, plan: [ready] }));
      const result = await run(
        process.execPath,
        [path.join(cwd, "node_modules/@changesets/cli/bin.js"), "publish", "--from-pack-dir", staging],
        { cwd, env: { ...process.env, CHANGESETS_OUTPUT: output }, signal },
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.code !== 0) return result.code;
      // Native npm publish can lose an already-published race and return no tag event.
      // Reconcile against registry bytes, then let native tag-only handling repair missing tags.
      const reconciled = [];
      for (const release of ready) {
        if (release.kind !== "publish") continue;
        await available(packages.get(release.name), release.tarball.integrity, downloadDir, { run, signal, wait });
        if (release.name === kitName) readyKitVersions.add(release.version);
        reconciled.push({ kind: "tag-only", name: release.name, version: release.version });
      }
      if (reconciled.length) {
        writeFileSync(path.join(staging, "publish-plan.json"), JSON.stringify({ version: 1, plan: [reconciled] }));
        const tags = await run(
          process.execPath,
          [path.join(cwd, "node_modules/@changesets/cli/bin.js"), "publish", "--from-pack-dir", staging],
          { cwd, env: { ...process.env, CHANGESETS_OUTPUT: output }, signal },
        );
        process.stdout.write(tags.stdout);
        process.stderr.write(tags.stderr);
        if (tags.code !== 0) return tags.code;
      }
    }
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Release cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--from-pack-dir")
      throw new Error("Usage: node scripts/publish-coordinated-packages.mjs --from-pack-dir <directory>");
    process.exitCode = await publishCoordinatedPackages({ packDir: args[1], signal: controller.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
