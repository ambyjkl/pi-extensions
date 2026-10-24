import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { publishFixture, unrelated } from "./coordinated-publish-fixture.js";

const { sanitizeRegistryDiagnostic } = (await import(
  pathToFileURL(path.join(process.cwd(), "scripts/publish-coordinated-packages.mjs")).href
)) as { sanitizeRegistryDiagnostic: (value: unknown) => string };
const fixtures: ReturnType<typeof publishFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) value.cleanup();
});
function fixture(options?: Parameters<typeof publishFixture>[0]) {
  const value = publishFixture(options);
  fixtures.push(value);
  return value;
}
const failure = (code = "E404") => ({
  code: 1,
  stdout: JSON.stringify({ error: { code, summary: "registry response" } }),
  stderr: "npm error: registry response",
});

for (const input of [
  "https://user:private-value@example.test/file?signature=private-value#private-value",
  "https://example.test/private-value/file",
  "https://example.test/file?private-value=signed",
  "https://user:first'private-value@example.test/file",
  'https://example.test/first"private-value/file',
  JSON.stringify({ password: 'first"private-value' }),
  JSON.stringify({ token: 'first\\"private-value,;}' }),
  JSON.stringify({ url: "https://example.test/file", password: "first private-value" }),
  "password='first\\'private-value'",
  "Authorization: Bearer private-value",
  "Proxy-Authorization: Basic private-value",
  "//registry.npmjs.org/:_authToken=private-value",
  '{"password":"private-value", "token":"private-value"}',
  "secret='private-value'",
  'token = "first private-value',
  'token = "first\nprivate-value"',
  JSON.stringify({ error: { summary: '{"password":"private-value"}' } }),
  "https:\\/\\/user:private-value@example.test/file",
  '\\u0070assword="private-value"',
  JSON.stringify({ error: { summary: '{"password"\n: "private-value"}' } }),
  JSON.stringify({ error: { summary: '{"password"\t: "private-value"}' } }),
  String.raw`\u005cu0070assword="private-value"`,
  String.raw`\u005cu0068ttps://user:private-value@example.test/file`,
  "_auth=private-value",
  "npm_privatevalue github_pat_privatevalue ghp_privatevalue",
]) {
  test(`diagnostics redact credentials: ${input.split(/[ :=]/u)[0]}`, () => {
    const output = sanitizeRegistryDiagnostic(input);
    assert.doesNotMatch(output, /private[-_]?value/iu);
    assert.match(output, /REDACTED/u);
  });
}

test("deeply nested escapes omit output instead of exposing credentials", () => {
  let encoded = String.raw`\u0070assword="private-value"`;
  for (let pass = 0; pass < 12; pass++) encoded = encoded.replaceAll("\\", String.raw`\u005c`);
  assert.equal(sanitizeRegistryDiagnostic(encoded), "[omitted: nested escaped output]");
});

test("diagnostics strip terminal controls and redact before truncation", () => {
  const output = sanitizeRegistryDiagnostic(
    `\x1b[31merror\x1b[0m\x00\x07\n${"x".repeat(1_950)} token=${"s".repeat(3_000)}\nend`,
  );
  for (const control of ["\x1b", "\x00", "\x07", "ssss"]) assert.equal(output.includes(control), false);
  assert.match(output, /error\n/u);
  assert.match(output, /REDACTED/u);
  const truncated = sanitizeRegistryDiagnostic("x".repeat(10_000));
  assert.ok(truncated.length < 2_100);
  assert.match(truncated, /truncated/u);
});

for (const stage of ["query version", "query tarball URL", "download tarball"]) {
  test(`${stage} failures include operation, output, and disposition`, async () => {
    const value = fixture();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => logs.push(String(message)));
    let failures = 0;
    const caches: string[] = [];
    await assert.rejects(
      value.runDirect({
        intercept(args) {
          const matches =
            stage === "query version"
              ? args[2] === "version"
              : stage === "query tarball URL"
                ? args[2] === "dist.tarball"
                : args[0] === "pack";
          if (!matches) return;
          failures++;
          if (args.includes("--cache")) caches.push(args[args.indexOf("--cache") + 1] ?? "");
          return failure(stage === "query version" ? "E500" : "E404");
        },
      }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`stage: ${stage}`, "u"));
        assert.match(error.message, /Exit code: 1; npm error: E(?:404|500)/u);
        assert.match(error.message, /stdout: .*registry response/u);
        assert.match(error.message, /stderr: npm error: registry response/u);
        assert.match(error.message, /stop/u);
        return true;
      },
    );
    assert.equal(failures, stage === "query version" ? 1 : 6);
    for (const cache of caches) assert.equal(existsSync(cache), false);
    if (stage !== "query version") {
      assert.ok(logs.some((line) => line.includes("attempt: 1/6; retry in 2000 ms")));
      assert.ok(logs.some((line) => line.includes("attempt: 6/6; stop")));
    }
    assert.ok(!value.state().published.includes("@fixture/consumer"));
    if (stage === "query tarball URL") assert.ok(value.state().published.includes(unrelated));
  });
}

for (const code of ["E401", "E403", "ENEEDAUTH"]) {
  test(`${code} stops after one readiness attempt`, async () => {
    const value = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await assert.rejects(
      value.runDirect({
        intercept(args) {
          if (args[0] !== "pack") return;
          attempts++;
          return failure(code);
        },
      }),
      /attempt: 1\/6; stop/u,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(value.state().published, ["@narumitw/pi-tui-kit"]);
  });
}

test("transient failures retain diagnostics without extra readiness calls", async () => {
  const value = fixture();
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((message) => logs.push(String(message)));
  let attempts = 0;
  assert.equal(
    await value.runDirect({
      intercept(args) {
        if (args[0] === "pack" && ++attempts === 1) return failure();
        return;
      },
    }),
    0,
  );
  assert.equal(attempts, 4);
  assert.equal(value.state().downloads, 3);
  assert.equal(logs.filter((line) => line.includes("retry in")).length, 1);
  assert.equal(value.events().length, 3);
});

for (const operation of ["version", "dist.tarball", "pack"]) {
  test(`malformed ${operation} output stops with sanitized context`, async () => {
    const value = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await assert.rejects(
      value.runDirect({
        intercept(args) {
          if (args[2] !== operation && !(operation === "pack" && args[0] === "pack")) return;
          attempts++;
          return {
            code: 0,
            stdout: "not JSON token=private-value",
            stderr: "npm error\n::error::injected\nAuthorization: Bearer private-value",
          };
        },
      }),
      (error: Error) => {
        assert.match(error.message, /Registry check: @/u);
        assert.match(error.message, /stage: .*; attempt: .*; stop/u);
        assert.doesNotMatch(error.message, /private-value/u);
        assert.match(error.message, /\[registry\] ::error::injected/u);
        return true;
      },
    );
    assert.equal(attempts, 1);
  });
}

for (const response of [
  null,
  {},
  "not a URL",
  "ftp://example.test/file",
  "https://user:private-value@example.test/file",
]) {
  test(`invalid tarball metadata stops before download: ${JSON.stringify(response)}`, async () => {
    const value = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let downloads = 0;
    await assert.rejects(
      value.runDirect({
        intercept(args) {
          if (args[0] === "pack") downloads++;
          if (args[2] === "dist.tarball") return { code: 0, stdout: JSON.stringify(response), stderr: "" };
          return;
        },
      }),
      (error: Error) => {
        assert.match(error.message, /stage: query tarball URL; attempt: 1\/6; stop/u);
        assert.doesNotMatch(error.message, /private-value/u);
        return true;
      },
    );
    assert.equal(downloads, 1, "only Kit was downloaded before invalid consumer metadata");
  });
}

for (const response of [
  null,
  {},
  [],
  [{ id: "unexpected", filename: "file.tgz" }],
  [{ id: "@narumitw/pi-tui-kit@0.67.0", filename: "../escape.tgz" }],
  [{ id: "@narumitw/pi-tui-kit@0.67.0", filename: "missing.tgz" }],
]) {
  test(`invalid artifact response stops without retry: ${JSON.stringify(response)}`, async () => {
    const value = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await assert.rejects(
      value.runDirect({
        intercept(args) {
          if (args[0] !== "pack") return;
          attempts++;
          return { code: 0, stdout: JSON.stringify(response), stderr: "" };
        },
      }),
      /stage: download tarball; attempt: 1\/6; stop/u,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(value.state().published, ["@narumitw/pi-tui-kit"]);
  });
}

test("emitted failures redact escaped JSON secrets and quoted URL credentials", async () => {
  const value = fixture();
  await assert.rejects(
    value.runDirect({
      intercept(args) {
        if (args[2] !== "version") return;
        return {
          code: 1,
          stdout: JSON.stringify({ error: { code: "E500" }, password: 'first\\"private-value,;}' }),
          stderr:
            JSON.stringify({ error: { summary: '{"password"\n: "private-value"}' } }) +
            String.raw`\n\u005cu0068ttps://user:private-value@example.test/file`,
        };
      },
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /private-value/u);
      assert.match(error.message, /npm error: E500/u);
      assert.match(error.message, /REDACTED/u);
      return true;
    },
  );
});

test("successful registry responses remain silent", async () => {
  const value = fixture({ existing: ["@narumitw/pi-tui-kit", "@fixture/consumer", unrelated] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  assert.equal(await value.runDirect(), 0);
  assert.equal(log.mock.calls.length, 0);
});

test("a version mismatch stops with the returned version and no publication", async () => {
  const value = fixture();
  await assert.rejects(
    value.runDirect({
      intercept(args) {
        if (args[2] === "version") return { code: 0, stdout: '"0.0.0"', stderr: "" };
        return;
      },
    }),
    (error: Error) => {
      assert.match(error.message, /stage: query version; attempt: 1\/1; stop/u);
      assert.match(error.message, /stdout: "0.0.0"/u);
      return true;
    },
  );
  assert.deepEqual(value.state().published, []);
});

test("malformed npm error code does not replace the original failure", async () => {
  const value = fixture();
  await assert.rejects(
    value.runDirect({
      intercept(args) {
        if (args[2] === "version")
          return { code: 1, stdout: '{"error":{"code":{"toString":null}}}', stderr: "original failure" };
        return;
      },
    }),
    (error: Error) => {
      assert.match(error.message, /npm error: unavailable/u);
      assert.match(error.message, /original failure/u);
      return true;
    },
  );
});

for (const reason of ["timed out", "cancelled", "spawn ENOENT", "output exceeded its limit"]) {
  test(`subprocess ${reason} stops without retry and sanitizes exception`, async () => {
    const value = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await assert.rejects(
      value.runDirect({
        intercept(args) {
          if (args[0] !== "pack") return;
          attempts++;
          throw new Error(`${reason}: token=private-value`);
        },
      }),
      (error: Error) => {
        assert.match(error.message, /stage: download tarball; attempt: 1\/6; stop/u);
        assert.ok(error.message.includes(reason));
        assert.doesNotMatch(error.message, /private-value/u);
        return true;
      },
    );
    assert.equal(attempts, 1);
    assert.deepEqual(value.state().published, ["@narumitw/pi-tui-kit"]);
  });
}

test("cancellation during retry wait stops with package context", async () => {
  const value = fixture();
  vi.spyOn(console, "error").mockImplementation(() => {});
  let attempts = 0;
  await assert.rejects(
    value.runDirect({
      intercept(args) {
        if (args[0] === "pack") {
          attempts++;
          return failure();
        }
        return;
      },
      wait: async () => {
        throw new Error("cancelled token=private-value");
      },
    }),
    (error: Error) => {
      assert.match(error.message, /stage: retry wait; attempt: 1\/6; stop/u);
      assert.doesNotMatch(error.message, /private-value/u);
      return true;
    },
  );
  assert.equal(attempts, 1);
});
