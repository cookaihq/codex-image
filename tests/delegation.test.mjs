import { strict as assert } from "node:assert";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  cleanupWorkspaces,
  codexExecCalls,
  codexInvocations,
  installStubCodex,
  makeWorkspace,
  runCli,
  soleJson,
  writeImage,
} from "./helpers.mjs";

const KEY = "sk-delegation-test-key";

async function execute(workspace, args = ["--prompt", "a cup"], env = {}) {
  const result = await runCli([...args, "--via", "codex-cli", "--json"], { workspace, env });
  return { result, payload: soleJson(result) };
}

async function delegate(options = {}, args = ["--prompt", "a cup"]) {
  const workspace = await makeWorkspace();
  await installStubCodex(workspace, options);
  const { result, payload } = await execute(workspace, args);
  return { workspace, result, payload };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

after(cleanupWorkspaces);

describe("delegated generation", () => {
  it("produces an image through the local Codex CLI", async () => {
    const { payload, result, workspace } = await delegate();
    assert.equal(payload.ok, true, `${result.stdout}${result.stderr}`);
    assert.equal(result.exitCode, 0);
    assert.equal(payload.route, "codex-cli");
    assert.equal(payload.attempts, 1);
    assert.equal(payload.image.format, "png");
    assert.equal(payload.image.width, 1);
    assert.equal(payload.path, join(workspace.cwd, "codex-image", "output", payload.path.split("/").pop()));
    assert.deepEqual(payload.config_sources, {
      route: "codex-cli",
      codex_version: "0.146.0",
      output_dir: "default",
    });
    assert.equal(payload.requested_model, null, "a delegated run has no top-level model of its own");
    assert.equal(
      await exists(join(workspace.cwd, ".codex-image")),
      false,
      "a delegated run must not create a state directory",
    );
  });

  it("reports the delegate's own model when it returns one", async () => {
    const { payload } = await delegate({ exec: "success_with_model" });
    assert.equal(payload.image_model, "gpt-image-stub");
  });

  it("leaves provider metadata null when the delegate reports none", async () => {
    const { payload } = await delegate();
    assert.equal(payload.image_model, null);
    assert.equal(payload.response_model, null);
    assert.equal(payload.revised_prompt, null);
    assert.equal(payload.tool_settings, null);
    assert.equal(payload.request_id, null);
  });

  it("accepts a path reported relative to the delegate's working directory", async () => {
    const { payload } = await delegate({ exec: "relative_path" });
    assert.equal(payload.ok, true);
  });

  it("removes its scratch directory after a successful run", async () => {
    const { payload, workspace } = await delegate();
    assert.equal(payload.ok, true);
    const entries = await readdir(join(workspace.cwd, "codex-image", "output"));
    assert.equal(entries.length, 1, `unexpected leftovers: ${entries.join(", ")}`);
    assert.ok(entries[0].endsWith(".png"));
  });
});

describe("the delegated call contract", () => {
  it("runs exec once, ephemerally, sandboxed to its own directory", async () => {
    const { workspace } = await delegate();
    const calls = await codexExecCalls(workspace);
    assert.equal(calls.length, 1, "one authorisation allows exactly one delegated call");
    const [call] = calls;
    assert.match(call, /--ephemeral/);
    assert.match(call, /--skip-git-repo-check/);
    assert.match(call, /-s workspace-write/);
    assert.match(call, /-C \S*\.codex-image-delegate-/);
    assert.match(call, /--output-schema \S+/);
    assert.match(call, /--output-last-message \S+/);
  });

  it("attaches local images in order and never a remote URL", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace);
    await writeImage(workspace, "one.png", "png");
    await writeImage(workspace, "two.png", "png");
    await execute(workspace, [
      "--prompt",
      "reuse the palette",
      "--mode",
      "reference",
      "--image",
      "one.png",
      "--image",
      "two.png",
    ]);

    const [call] = await codexExecCalls(workspace);
    const order = [...call.matchAll(/-i (\S+)/g)].map((match) => match[1]);
    assert.deepEqual(order, [join(workspace.cwd, "one.png"), join(workspace.cwd, "two.png")]);
  });

  it("passes no credentials in the arguments or the child environment", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace);
    const { payload } = await execute(workspace, ["--prompt", "a cup"], {
      CODEX_IMAGE_API_KEY: KEY,
      CODEX_IMAGE_BASE_URL: "https://gateway.example/v1",
      CODEX_IMAGE_MODEL: "gpt-test",
    });
    assert.equal(payload.ok, true);

    const invocations = (await codexInvocations(workspace)).join("\n");
    assert.ok(!invocations.includes(KEY), "the API key must never reach the delegate's arguments");
    assert.ok(!invocations.includes("gateway.example"), "the base URL must not reach the delegate");

    // The environment the child saw is proven by the schema file the script wrote for it:
    // nothing else is forwarded, so a leak would have to appear in the arguments above.
    const [call] = await codexExecCalls(workspace);
    assert.ok(!call.includes("sk-"));
  });

  it("refuses a remote image before starting the delegate", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace);
    const { result, payload } = await execute(workspace, [
      "--prompt",
      "edit it",
      "--mode",
      "edit",
      "--image",
      "https://cdn.example/a.png",
    ]);
    assert.equal(payload.error.code, "codex_delegate_unsupported_input");
    assert.equal(result.exitCode, 2, "nothing was sent, so this is a local failure");
    assert.deepEqual(await codexExecCalls(workspace), []);
  });
});

describe("delegated failures", () => {
  const cases = {
    no_structured_result: "codex_delegate_failed",
    missing_file: "codex_delegate_failed",
    crash: "codex_delegate_failed",
    auth_failure: "codex_auth_error",
    not_an_image: "invalid_image_result",
  };

  for (const [mode, code] of Object.entries(cases)) {
    it(`reports ${code} for a delegate that ${mode.replace(/_/g, " ")}`, async () => {
      const { payload, result, workspace } = await delegate({ exec: mode });
      assert.equal(payload.error.code, code, `message was: ${payload.error.message}`);
      assert.equal(result.exitCode, 1, "the delegate was started, so this is not a local failure");
      assert.equal(payload.network_started, true);
      assert.equal(payload.attempts, 1);

      const calls = await codexExecCalls(workspace);
      assert.equal(calls.length, 1, "a failed delegation is never retried automatically");
    });
  }

  it("keeps a non-image artefact on disk for diagnosis", async () => {
    const { payload } = await delegate({ exec: "not_an_image" });
    const match = /left at (\S+) for diagnosis/.exec(payload.error.message);
    assert.notEqual(match, null, `message did not name the artefact: ${payload.error.message}`);
    assert.equal(await exists(match[1]), true);
  });
});
