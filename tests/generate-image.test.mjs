import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

import { STABLE_ERROR_CODES } from "../scripts/generate-image.mjs";
import {
  SCRIPT,
  cleanupWorkspaces,
  envFor,
  makeWorkspace,
  runCli,
  soleJson,
} from "./helpers.mjs";

const execFileAsync = promisify(execFile);

/** A complete configuration, so option-surface tests fail only on the option under test. */
const COMPLETE_CONFIG = {
  CODEX_IMAGE_BASE_URL: "https://gateway.example/v1",
  CODEX_IMAGE_API_KEY: "sk-surface-test-key",
  CODEX_IMAGE_MODEL: "gpt-test",
};

async function expectFailure(args, code, options = {}) {
  const result = await runCli([...args, "--json"], { env: COMPLETE_CONFIG, ...options });
  assert.equal(result.stderr, "", "diagnostics must not be written in --json mode");
  const payload = soleJson(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.network_started, false);
  assert.equal(payload.attempts, 0);
  assert.equal(payload.error.code, code, `message was: ${payload.error.message}`);
  assert.ok(payload.error.message.length > 0, "a failure must explain itself");
  assert.ok(STABLE_ERROR_CODES.includes(payload.error.code), "error code must be stable");
  assert.equal(result.exitCode, 2, "a failure before any HTTP POST exits with 2");
  return payload;
}

async function expectPreflightAccepted(args, options = {}) {
  const result = await runCli([...args, "--preflight", "--json"], {
    env: COMPLETE_CONFIG,
    ...options,
  });
  const payload = soleJson(result);
  assert.equal(payload.ok, true, `expected acceptance, got: ${result.stdout}`);
  assert.equal(result.exitCode, 0);
  return payload;
}

after(cleanupWorkspaces);

describe("--help", () => {
  it("prints usage, exits 0 and touches nothing", async () => {
    const workspace = await makeWorkspace();
    const result = await runCli(["--help"], { workspace });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^codex-image —/);
    assert.match(result.stdout, /--preflight/);
    assert.match(result.stdout, /--via http\|codex-cli/);
    assert.deepEqual(await readdir(workspace.cwd), [], "--help must not create files");
  });

  it("is available as -h", async () => {
    const result = await runCli(["-h"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^codex-image —/);
  });

  it("wins over other options without executing them", async () => {
    const result = await runCli(["--help", "--preflight"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^codex-image —/);
  });
});

describe("option surface", () => {
  it("rejects an unknown option", async () => {
    await expectFailure(["--nonsense"], "invalid_arguments");
  });

  it("rejects a positional argument", async () => {
    await expectFailure(["a-prompt"], "invalid_arguments");
  });

  it("rejects an option given twice", async () => {
    await expectFailure(["--prompt", "a", "--prompt", "b", "--preflight"], "invalid_arguments");
  });

  it("rejects a value-taking option with no value", async () => {
    await expectFailure(["--prompt", "--preflight"], "invalid_arguments");
  });

  it("rejects a value on a boolean option", async () => {
    await expectFailure(["--preflight=yes"], "invalid_arguments");
  });
});

describe("credential options", () => {
  const shapes = [
    ["--api-key", "sk-secret-value"],
    ["--apikey", "sk-secret-value"],
    ["--api_key", "sk-secret-value"],
    ["--key", "sk-secret-value"],
    ["--token", "sk-secret-value"],
    ["--secret", "sk-secret-value"],
    ["--authorization", "Bearer sk-secret-value"],
    ["--access-token", "sk-secret-value"],
  ];

  for (const [flag, value] of shapes) {
    it(`rejects ${flag} and explains the supported channel`, async () => {
      const payload = await expectFailure([flag, value, "--preflight"], "invalid_arguments");
      assert.match(payload.error.message, /credentials must never be passed on the command line/);
      assert.match(payload.error.message, /CODEX_IMAGE_API_KEY/);
    });

    it(`rejects ${flag}=value without echoing the value`, async () => {
      const result = await runCli([`${flag}=${value}`, "--json"], { env: COMPLETE_CONFIG });
      assert.ok(
        !`${result.stdout}${result.stderr}`.includes(value),
        "a rejected credential value must never be echoed",
      );
    });
  }

  it("does not mistake --use-local-key for a credential option", async () => {
    await expectPreflightAccepted(["--prompt", "a cup", "--use-local-key"]);
  });

  it("does not mistake --use-codex-config for a credential option", async () => {
    await expectPreflightAccepted(["--prompt", "a cup", "--use-codex-config"]);
  });
});

describe("mode and image constraints", () => {
  it("defaults to generate when no image is given", async () => {
    const payload = await expectPreflightAccepted(["--prompt", "a cup"]);
    assert.equal(payload.mode, "generate");
  });

  it("accepts an explicit generate mode without images", async () => {
    const payload = await expectPreflightAccepted(["--prompt", "a cup", "--mode", "generate"]);
    assert.equal(payload.mode, "generate");
  });

  it("refuses images in generate mode", async () => {
    await expectFailure(
      ["--prompt", "a cup", "--mode", "generate", "--image", "a.png", "--preflight"],
      "invalid_mode",
    );
  });

  it("refuses to infer the mode from the prompt when an image is given", async () => {
    const payload = await expectFailure(
      ["--prompt", "change the background", "--image", "a.png", "--preflight"],
      "invalid_mode",
    );
    assert.match(payload.error.message, /never inferred from the prompt/);
  });

  it("refuses reference mode without an image", async () => {
    await expectFailure(["--prompt", "a cup", "--mode", "reference", "--preflight"], "invalid_mode");
  });

  it("refuses edit mode without an image", async () => {
    await expectFailure(["--prompt", "a cup", "--mode", "edit", "--preflight"], "invalid_mode");
  });

  it("rejects an unsupported mode", async () => {
    await expectFailure(
      ["--prompt", "a cup", "--mode", "inpaint", "--preflight"],
      "invalid_arguments",
    );
  });

  it("requires a non-empty prompt", async () => {
    await expectFailure(["--prompt", "   ", "--preflight"], "invalid_arguments");
  });
});

describe("output and route options", () => {
  it("rejects --output together with --output-dir", async () => {
    const payload = await expectFailure(
      ["--prompt", "a cup", "--output", "out.png", "--output-dir", "shots", "--preflight"],
      "invalid_arguments",
    );
    assert.match(payload.error.message, /mutually exclusive/);
  });

  it("rejects an unsupported --via route", async () => {
    await expectFailure(["--prompt", "a cup", "--via", "mcp", "--preflight"], "invalid_arguments");
  });

  it("accepts the documented http route", async () => {
    const payload = await expectPreflightAccepted(["--prompt", "a cup", "--via", "http"]);
    assert.equal(payload.route, "http");
  });
});

describe("command selection", () => {
  it("rejects a retired state-machine option", async () => {
    for (const flag of [
      ["--resume-request", `sha256:${"a".repeat(64)}`],
      ["--confirm-request", `sha256:${"a".repeat(64)}`],
      ["--confirm-state", "beef"],
      ["--cancel-request", `sha256:${"a".repeat(64)}`],
      ["--cleanup-state"],
    ]) {
      await expectFailure([...flag, "--preflight"], "invalid_arguments");
    }
  });

  it("reports a bare invocation as a usage error", async () => {
    await expectFailure([], "invalid_arguments");
  });
});

describe("output discipline", () => {
  it("writes a human-readable failure to stderr and nothing to stdout", async () => {
    const result = await runCli(["--nonsense"], { env: COMPLETE_CONFIG });
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^codex-image: invalid_arguments: /);
    assert.equal(result.exitCode, 2);
  });

  it("does not create state while rejecting arguments", async () => {
    const workspace = await makeWorkspace();
    const result = await runCli(["--prompt", "a cup", "--mode", "edit", "--json"], {
      workspace,
      env: COMPLETE_CONFIG,
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(await readdir(workspace.cwd), []);
  });
});

describe("module import", () => {
  it("does not run the CLI when imported", async () => {
    const workspace = await makeWorkspace();
    const source = `import(${JSON.stringify(SCRIPT)}).then((m) => process.stdout.write(typeof m.run));`;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", source],
      { cwd: workspace.cwd, env: envFor(workspace) },
    );
    assert.equal(stdout, "function", "importing the script must not print help or results");
    assert.equal(stderr, "");
  });
});
