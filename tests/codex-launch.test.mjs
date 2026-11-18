import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, it } from "node:test";

import { currentCodexExecutable, resolveCodexLaunch, runCodex } from "../scripts/codex-launch.mjs";
import { cleanupWorkspaces, codexInvocations, envFor, installStubCodex, makeWorkspace, runCli, soleJson } from "./helpers.mjs";

after(cleanupWorkspaces);

it("uses the explicit launcher for version, login and exec even with a different Codex on PATH", async () => {
  const workspace = await makeWorkspace();
  const explicit = { ...workspace, bin: join(workspace.root, "Explicit Codex"), codexLog: join(workspace.root, "explicit.log") };
  await mkdir(explicit.bin);
  await installStubCodex(workspace, { login: "logged_out" });
  const override = await installStubCodex(explicit, { version: "0.170.0" });
  const env = { CODEX_IMAGE_CODEX_EXECUTABLE: override };
  const args = ["--prompt", 'a cup with "quotes" & a saucer', "--via", "codex-cli", "--json"];
  const preflight = soleJson(await runCli([...args, "--preflight"], { workspace, env }));
  assert.equal(preflight.codex_executable_source, "environment");
  assert.equal(preflight.codex_version, "0.170.0");
  const result = soleJson(await runCli(args, { workspace, env }));
  assert.equal(result.ok, true);
  assert.equal(result.config_sources.codex_version, "0.170.0");
  assert.deepEqual(await codexInvocations(workspace), []);
  const calls = await codexInvocations(explicit);
  assert.deepEqual(calls.slice(0, 4), ["--version", "login status", "--version", "login status"]);
  assert.match(calls[4], /^exec /);
  assert.match(calls.join("\n"), /a cup with "quotes" & a saucer/);
});

it("uses a verified current installation or a command from PATH, and fails closed on an invalid override", async () => {
  const workspace = await makeWorkspace();
  const extra = { ...workspace, bin: join(workspace.root, "Current Codex"), codexLog: join(workspace.root, "current.log") };
  await mkdir(extra.bin);
  await installStubCodex(workspace, { version: "0.146.0" });
  const current = await installStubCodex(extra, { version: "0.170.0" });
  const env = envFor(workspace);
  const runVersion = async (findCurrent) => {
    const launch = await resolveCodexLaunch({ env, cwd: workspace.cwd, findCurrent });
    const version = await runCodex(launch, ["--version"], { env });
    return [launch.source, version.stdout.trim()];
  };
  assert.deepEqual(await runVersion(async () => current), ["current_codex_session", "codex-cli 0.170.0"]);
  assert.deepEqual(await runVersion(async () => null), ["PATH", "codex-cli 0.146.0"]);
  const withWrongExplicit = await resolveCodexLaunch({ env, cwd: workspace.cwd, findCurrent: async () => current,
    explicit: { value: "not a launcher", source: "environment" } });
  assert.equal(withWrongExplicit, null);
});

it("rejects inherited Codex markers from a different Agent or an opaque wrapper", async () => {
  const workspace = await makeWorkspace();
  const file = join(workspace.bin, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(file, "", { mode: 0o755 });
  const chain = [{ path: file, name: basename(file) }];
  assert.equal(await currentCodexExecutable({ CODEX_THREAD_ID: "test" }, () => chain), file);
  assert.equal(await currentCodexExecutable({ CODEX_THREAD_ID: "test", CLAUDECODE: "1" }, () => chain), null);
  assert.equal(await currentCodexExecutable({ CODEX_THREAD_ID: "test" }, () => [
    { path: join(workspace.bin, "node"), name: "node", command: "/somewhere/claude-code/cli.js" }, ...chain,
  ]), null);
  assert.equal(await currentCodexExecutable({}, () => chain), null);
});
