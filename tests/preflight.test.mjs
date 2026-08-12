import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  cleanupWorkspaces,
  installStubCodex,
  makeWorkspace,
  runCli,
  soleJson,
  writeCodexHome,
  writeFileIn,
  writeImage,
  writeSkillHomeEnv,
} from "./helpers.mjs";

const BASE = "https://gateway.example/v1";
const KEY = "sk-preflight-test-key";
const MODEL = "gpt-test-top-level";

const fullEnv = (overrides = {}) => ({
  CODEX_IMAGE_BASE_URL: BASE,
  CODEX_IMAGE_API_KEY: KEY,
  CODEX_IMAGE_MODEL: MODEL,
  ...overrides,
});

async function preflight(args, options = {}) {
  const result = await runCli([...args, "--preflight", "--json"], options);
  return { result, payload: soleJson(result) };
}

async function expectOk(args, options = {}) {
  const { result, payload } = await preflight(args, options);
  assert.equal(payload.ok, true, `expected success, got: ${result.stdout}${result.stderr}`);
  assert.equal(result.exitCode, 0);
  return payload;
}

async function expectCode(args, code, options = {}) {
  const { result, payload } = await preflight(args, options);
  assert.equal(payload.ok, false, `expected failure, got: ${result.stdout}`);
  assert.equal(payload.error.code, code, `message was: ${payload.error?.message}`);
  assert.equal(result.exitCode, 2);
  return payload;
}

after(cleanupWorkspaces);

describe("configuration layering", () => {
  it("reads every field from the process environment", async () => {
    const payload = await expectOk(["--prompt", "a cup"], { env: fullEnv() });
    assert.equal(payload.base_url_source, "environment");
    assert.equal(payload.api_key_source, "environment");
    assert.equal(payload.model_source, "environment");
    assert.equal(payload.requested_model, MODEL);
    assert.equal(payload.mixed_config_sources, false);
  });

  it("prefers .env.local over .env", async () => {
    const workspace = await makeWorkspace();
    await writeFileIn(workspace, ".env", `CODEX_IMAGE_MODEL=from-env\nCODEX_IMAGE_BASE_URL=${BASE}\n`);
    await writeFileIn(workspace, ".env.local", "CODEX_IMAGE_MODEL=from-env-local\n");
    const payload = await expectOk(["--prompt", "a cup"], {
      workspace,
      env: { CODEX_IMAGE_API_KEY: KEY },
    });
    assert.equal(payload.requested_model, "from-env-local");
    assert.equal(payload.model_source, "project_env_local");
    assert.equal(payload.base_url_source, "project_env");
  });

  it("prefers the process environment over a project file", async () => {
    const workspace = await makeWorkspace();
    await writeFileIn(workspace, ".env.local", "CODEX_IMAGE_MODEL=from-file\n");
    const payload = await expectOk(["--prompt", "a cup"], { workspace, env: fullEnv() });
    assert.equal(payload.requested_model, MODEL);
    assert.equal(payload.model_source, "environment");
  });

  it("resolves each field independently and flags a mixed pairing", async () => {
    const workspace = await makeWorkspace();
    await writeFileIn(workspace, ".env.local", `CODEX_IMAGE_BASE_URL=${BASE}\n`);
    await writeFileIn(workspace, ".env", `CODEX_IMAGE_MODEL=${MODEL}\n`);
    const payload = await expectOk(["--prompt", "a cup"], {
      workspace,
      env: { CODEX_IMAGE_API_KEY: KEY },
    });
    assert.equal(payload.base_url_source, "project_env_local");
    assert.equal(payload.api_key_source, "environment");
    assert.equal(payload.model_source, "project_env");
    assert.equal(payload.mixed_config_sources, true);
  });

  it("parses quotes, padding, comments and repeated keys without shell semantics", async () => {
    const workspace = await makeWorkspace();
    await writeFileIn(
      workspace,
      ".env",
      [
        "# a comment",
        "",
        `  CODEX_IMAGE_BASE_URL = "${BASE}"  `,
        "CODEX_IMAGE_MODEL='first'",
        "CODEX_IMAGE_MODEL=second",
        "UNRELATED_VARIABLE=ignored",
        "CODEX_IMAGE_API_KEY=$HOME/not-expanded",
      ].join("\n"),
    );
    const payload = await expectOk(["--prompt", "a cup"], { workspace });
    assert.equal(payload.requested_model, "second", "the last occurrence of a key wins");
    assert.equal(payload.endpoint, `${BASE}/responses`);
    const digest = createHash("sha256").update("$HOME/not-expanded").digest("hex");
    assert.equal(
      payload.api_key_fingerprint,
      `sha256:${digest.slice(0, 12)}`,
      "values are taken literally, never expanded",
    );
  });

  it("does not read a .env from a parent directory", async () => {
    const workspace = await makeWorkspace();
    await writeFileIn(workspace, ".env", `CODEX_IMAGE_MODEL=${MODEL}\n`);
    const nested = join(workspace.cwd, "nested");
    await mkdir(nested, { recursive: true });
    await expectCode(["--prompt", "a cup"], "config_missing_model", {
      workspace,
      cwd: nested,
      env: { CODEX_IMAGE_BASE_URL: BASE, CODEX_IMAGE_API_KEY: KEY },
    });
  });

  it("reads ~/.config/codex-image/.env automatically", async () => {
    const workspace = await makeWorkspace();
    await writeSkillHomeEnv(workspace, `CODEX_IMAGE_MODEL=${MODEL}\n`);
    const payload = await expectOk(["--prompt", "a cup"], {
      workspace,
      env: { CODEX_IMAGE_BASE_URL: BASE, CODEX_IMAGE_API_KEY: KEY },
    });
    assert.equal(payload.model_source, "home_env");
    assert.equal(payload.requested_model, MODEL);
  });

  it("prefers a project file over the home layer", async () => {
    const workspace = await makeWorkspace();
    await writeSkillHomeEnv(workspace, "CODEX_IMAGE_MODEL=from-home\n");
    await writeFileIn(workspace, ".env", "CODEX_IMAGE_MODEL=from-project\n");
    const payload = await expectOk(["--prompt", "a cup"], {
      workspace,
      env: { CODEX_IMAGE_BASE_URL: BASE, CODEX_IMAGE_API_KEY: KEY },
    });
    assert.equal(payload.model_source, "project_env");
    assert.equal(payload.requested_model, "from-project");
  });
});

describe("Codex configuration fallback", () => {
  const configToml = [
    "# Codex configuration",
    'model_provider = "gateway"',
    "model = 'gpt-5.6-sol'   # trailing comment",
    "",
    "[model_providers.other]",
    'base_url = "https://wrong.example/v1"',
    "",
    "[model_providers.gateway]",
    'name = "Gateway"',
    'base_url = "https://gateway.example/v1"',
    "",
  ].join("\n");

  it("reads provider, model and base URL from the Codex configuration automatically", async () => {
    const workspace = await makeWorkspace();
    await writeCodexHome(workspace, { configToml, authJson: { OPENAI_API_KEY: KEY } });

    const payload = await expectOk(["--prompt", "a cup"], { workspace });
    assert.equal(payload.endpoint, "https://gateway.example/v1/responses");
    assert.equal(payload.base_url_source, "codex_config");
    assert.equal(payload.api_key_source, "codex_auth");
    assert.equal(payload.model_source, "codex_config");
    assert.equal(payload.requested_model, "gpt-5.6-sol");
  });

  it("accepts quoted table segments and escaped strings", async () => {
    const workspace = await makeWorkspace();
    await writeCodexHome(workspace, {
      configToml: [
        'model_provider = "my.gateway"',
        'model = "gpt\\u0035"',
        '[model_providers."my.gateway"]',
        `base_url = "${BASE}"`,
      ].join("\n"),
      authJson: { OPENAI_API_KEY: KEY },
    });
    const payload = await expectOk(["--prompt", "a cup"], { workspace });
    assert.equal(payload.requested_model, "gpt5");
    assert.equal(payload.endpoint, `${BASE}/responses`);
  });

  it("is not confused by a multi-line string before the fields it needs", async () => {
    const workspace = await makeWorkspace();
    await writeCodexHome(workspace, {
      configToml: [
        'notes = """',
        'model_provider = "decoy"',
        '[model_providers.decoy]',
        '"""',
        'model_provider = "gateway"',
        `model = "${MODEL}"`,
        "[model_providers.gateway]",
        `base_url = "${BASE}"`,
      ].join("\n"),
      authJson: { OPENAI_API_KEY: KEY },
    });
    const payload = await expectOk(["--prompt", "a cup"], { workspace });
    assert.equal(payload.requested_model, MODEL);
    assert.equal(payload.endpoint, `${BASE}/responses`);
  });

  const invalidConfigs = {
    "a duplicated required key": ['model = "one"', 'model = "two"', 'model_provider = "g"'].join("\n"),
    "a multi-line required value": ['model_provider = "g"', 'model = """', "gpt", '"""'].join("\n"),
    "a dotted required key": [
      `model_providers.g.base_url = "${BASE}"`,
      'model_provider = "g"',
      `model = "${MODEL}"`,
    ].join("\n"),
    "a non-string required value": ['model_provider = "g"', "model = 42"].join("\n"),
    "an inline provider table": [
      'model_provider = "g"',
      `model = "${MODEL}"`,
      "[model_providers]",
      `g = { base_url = "${BASE}" }`,
    ].join("\n"),
  };

  for (const [description, configText] of Object.entries(invalidConfigs)) {
    it(`refuses ${description}`, async () => {
      const workspace = await makeWorkspace();
      await writeCodexHome(workspace, { configToml: configText, authJson: { OPENAI_API_KEY: KEY } });
      const payload = await expectCode(
        ["--prompt", "a cup"],
        "config_invalid_codex_config",
        { workspace },
      );
      assert.match(payload.error.message, /CODEX_IMAGE_BASE_URL/);
    });
  }

  it("refuses an auth file that is not JSON", async () => {
    const workspace = await makeWorkspace();
    await writeCodexHome(workspace, { configToml, authJson: "OPENAI_API_KEY=not-json" });
    await expectCode(["--prompt", "a cup"], "config_invalid_codex_auth", {
      workspace,
    });
  });

  it("never opens the Codex layer when earlier layers are complete", async () => {
    const workspace = await makeWorkspace();
    await writeCodexHome(workspace, { configToml: "model = 42\n", authJson: "not-json" });
    const payload = await expectOk(["--prompt", "a cup"], { workspace, env: fullEnv() });
    assert.equal(payload.base_url_source, "environment");
  });

  it("reports a missing API key instead of converting another credential field", async () => {
    const workspace = await makeWorkspace();
    await writeCodexHome(workspace, {
      configToml,
      authJson: { tokens: { access_token: "should-never-be-used" } },
    });
    const payload = await expectCode(
      ["--prompt", "a cup"],
      "config_missing_api_key",
      { workspace },
    );
    assert.match(payload.error.message, /CODEX_IMAGE_API_KEY/);
    assert.ok(!JSON.stringify(payload).includes("should-never-be-used"));
    assert.equal(
      payload.guidance.delegate.code,
      "codex_cli_not_found",
      "the delegate state travels with the failure so the caller can report the machine",
    );
  });
});

describe("base URL validation", () => {
  const rejected = {
    "embedded credentials": "https://user:pass@gateway.example/v1",
    "a query string": "https://gateway.example/v1?tenant=a",
    "a fragment": "https://gateway.example/v1#section",
    "plain HTTP to a public host": "http://gateway.example/v1",
    "a non-HTTP scheme": "ftp://gateway.example/v1",
  };

  for (const [description, baseUrl] of Object.entries(rejected)) {
    it(`rejects ${description}`, async () => {
      await expectCode(["--prompt", "a cup"], "config_invalid_base_url", {
        env: fullEnv({ CODEX_IMAGE_BASE_URL: baseUrl }),
      });
    });
  }

  it("allows loopback HTTP only with a key from the process environment", async () => {
    const workspace = await makeWorkspace();
    const payload = await expectOk(["--prompt", "a cup"], {
      workspace,
      env: fullEnv({ CODEX_IMAGE_BASE_URL: "http://127.0.0.1:1" }),
    });
    assert.equal(payload.endpoint, "http://127.0.0.1:1/responses");

    const other = await makeWorkspace();
    await writeFileIn(other, ".env", `CODEX_IMAGE_API_KEY=${KEY}\n`);
    await expectCode(["--prompt", "a cup"], "config_invalid_base_url", {
      workspace: other,
      env: { CODEX_IMAGE_BASE_URL: "http://127.0.0.1:1", CODEX_IMAGE_MODEL: MODEL },
    });
  });

  it("appends /responses without duplicating a version segment", async () => {
    for (const [baseUrl, endpoint] of [
      ["https://gateway.example/v1", "https://gateway.example/v1/responses"],
      ["https://gateway.example/v1/", "https://gateway.example/v1/responses"],
      ["https://gateway.example", "https://gateway.example/responses"],
      ["https://gateway.example/", "https://gateway.example/responses"],
    ]) {
      const payload = await expectOk(["--prompt", "a cup"], {
        env: fullEnv({ CODEX_IMAGE_BASE_URL: baseUrl }),
      });
      assert.equal(payload.endpoint, endpoint);
    }
  });
});

describe("routing", () => {
  it("selects http when a complete key configuration is available", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace, { login: "account" });
    const payload = await expectOk(["--prompt", "a cup"], { workspace, env: fullEnv() });
    assert.equal(payload.route, "http");
    assert.equal(payload.max_attempts, 4);
  });

  it("reports the delegate state when no codex is installed and nothing is configured", async () => {
    const payload = await expectCode(["--prompt", "a cup"], "config_missing_base_url");
    assert.equal(payload.guidance.delegate.available, false);
    assert.equal(payload.guidance.delegate.code, "codex_cli_not_found");
  });

  it("delegates automatically when no layer provides a key", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace, { login: "account" });
    const payload = await expectOk(["--prompt", "a cup"], { workspace });
    assert.equal(payload.route, "codex-cli");
    assert.equal(payload.codex_version, "0.146.0");
    assert.equal(payload.max_attempts, 1);
    assert.equal(payload.requested_model, null);
    assert.equal(payload.endpoint, undefined);
    assert.equal(payload.api_key_fingerprint, undefined);
  });

  const delegateFailures = {
    codex_cli_not_found: null,
    codex_cli_version_unsupported: { version: "0.140.0" },
    codex_not_authenticated: { login: "logged_out" },
    codex_not_account_login: { login: "api_key" },
  };

  for (const [code, stub] of Object.entries(delegateFailures)) {
    it(`reports ${code} on the forced delegation route`, async () => {
      const workspace = await makeWorkspace();
      if (stub !== null) {
        await installStubCodex(workspace, stub);
      }
      const payload = await expectCode(["--prompt", "a cup", "--via", "codex-cli"], code, {
        workspace,
        env: fullEnv(),
      });
      assert.equal(payload.ok, false);
      if (code === "codex_not_account_login") {
        assert.match(payload.error.message, /HTTP route/);
      }
    });
  }

  it("never falls back between forced routes", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace, { login: "account" });
    await expectCode(["--prompt", "a cup", "--via", "http"], "config_missing_base_url", {
      workspace,
    });
  });

  it("honours --via codex-cli even when the http route is fully configured", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace, { login: "account" });
    const payload = await expectOk(["--prompt", "a cup", "--via", "codex-cli"], {
      workspace,
      env: fullEnv(),
    });
    assert.equal(payload.route, "codex-cli");
  });
});

describe("image inputs", () => {
  it("keeps the order of repeated --image options", async () => {
    const workspace = await makeWorkspace();
    await writeImage(workspace, "first.png", "png");
    await writeImage(workspace, "second.jpg", "jpeg");
    await writeImage(workspace, "third.webp", "webp");
    const payload = await expectOk(
      [
        "--prompt",
        "reuse the palette of image 1",
        "--mode",
        "reference",
        "--image",
        "first.png",
        "--image",
        "second.jpg",
        "--image",
        "third.webp",
      ],
      { workspace, env: fullEnv() },
    );
    assert.deepEqual(
      payload.images.map((image) => [image.position, image.format]),
      [
        [1, "png"],
        [2, "jpeg"],
        [3, "webp"],
      ],
    );
    assert.ok(payload.images.every((image) => image.digest.startsWith("sha256:")));
  });

  it("identifies the format from the bytes, not the extension", async () => {
    const workspace = await makeWorkspace();
    await writeImage(workspace, "actually-a-png.jpg", "png");
    const payload = await expectOk(
      ["--prompt", "edit it", "--mode", "edit", "--image", "actually-a-png.jpg"],
      { workspace, env: fullEnv() },
    );
    assert.equal(payload.images[0].format, "png");
  });

  it("rejects a missing, unreadable or non-image input before anything else", async () => {
    const workspace = await makeWorkspace();
    await writeFileIn(workspace, "notes.txt", "not an image");
    await mkdir(join(workspace.cwd, "a-directory"), { recursive: true });

    for (const target of ["absent.png", "notes.txt", "a-directory"]) {
      await expectCode(
        ["--prompt", "edit it", "--mode", "edit", "--image", target],
        "image_read_error",
        { workspace, env: fullEnv() },
      );
    }
  });

  it("passes a remote URL through untouched", async () => {
    const payload = await expectOk(
      ["--prompt", "edit it", "--mode", "edit", "--image", "https://cdn.example/a.png"],
      { env: fullEnv() },
    );
    assert.equal(payload.images[0].kind, "remote");
    assert.equal(payload.images[0].reference, "https://cdn.example/a.png");
    assert.equal(payload.images[0].digest, null);
  });

  it("refuses a remote URL on the delegation route", async () => {
    const workspace = await makeWorkspace();
    await installStubCodex(workspace, { login: "account" });
    await expectCode(
      [
        "--prompt",
        "edit it",
        "--mode",
        "edit",
        "--image",
        "https://cdn.example/a.png",
        "--via",
        "codex-cli",
      ],
      "codex_delegate_unsupported_input",
      { workspace },
    );
  });

  it("never puts image bytes in the result", async () => {
    const workspace = await makeWorkspace();
    await writeImage(workspace, "input.png", "png");
    const payload = await expectOk(
      ["--prompt", "edit it", "--mode", "edit", "--image", "input.png"],
      { workspace, env: fullEnv() },
    );
    assert.ok(!JSON.stringify(payload).includes("data:image/"));
    assert.ok(!JSON.stringify(payload).includes("iVBORw0KGgo"));
  });
});

describe("output plan", () => {
  it("defaults to codex-image/output under the working directory", async () => {
    const workspace = await makeWorkspace();
    const payload = await expectOk(["--prompt", "a cup"], { workspace, env: fullEnv() });
    assert.equal(payload.output_plan.kind, "directory");
    assert.equal(payload.output_plan.directory, join(workspace.cwd, "codex-image", "output"));
    assert.equal(payload.output_plan.label, "image");
    assert.equal(payload.output_plan.collision_policy, "suffix");
    assert.equal(payload.output_plan.source, "default");
  });

  it("resolves a relative --output-dir against the working directory", async () => {
    const workspace = await makeWorkspace();
    const payload = await expectOk(["--prompt", "a cup", "--output-dir", "shots"], {
      workspace,
      env: fullEnv(),
    });
    assert.equal(payload.output_plan.directory, join(workspace.cwd, "shots"));
    assert.equal(payload.output_plan.source, "argument");
  });

  it("uses CODEX_IMAGE_OUTPUT_DIR when no option overrides it", async () => {
    const workspace = await makeWorkspace();
    const payload = await expectOk(["--prompt", "a cup"], {
      workspace,
      env: fullEnv({ CODEX_IMAGE_OUTPUT_DIR: "from-env" }),
    });
    assert.equal(payload.output_plan.directory, join(workspace.cwd, "from-env"));
    assert.equal(payload.output_plan.source, "environment");
  });

  it("refuses to overwrite an explicit output file", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.cwd, "taken.png"), "already here");
    await expectCode(["--prompt", "a cup", "--output", "taken.png"], "output_exists", {
      workspace,
      env: fullEnv(),
    });
  });

  it("refuses an output extension that cannot match a produced image", async () => {
    await expectCode(["--prompt", "a cup", "--output", "out.gif"], "output_format_mismatch", {
      env: fullEnv(),
    });
  });

  it("sanitises the filename label", async () => {
    const payload = await expectOk(
      ["--prompt", "a cup", "--label", "../../etc/passwd is a label"],
      { env: fullEnv() },
    );
    assert.ok(!payload.output_plan.label.includes("/"));
    assert.ok([...payload.output_plan.label].length <= 40);

    const empty = await expectOk(["--prompt", "a cup", "--label", "///"], { env: fullEnv() });
    assert.equal(empty.output_plan.label, "image");
  });
});

describe("dry-run behaviour", () => {
  it("writes no state and creates no files", async () => {
    const workspace = await makeWorkspace();
    await expectOk(["--prompt", "a cup"], { workspace, env: fullEnv() });
    await assert.rejects(
      stat(join(workspace.cwd, ".codex-image")),
      /ENOENT/,
      "a dry-run must not create a state directory",
    );
  });

  it("keeps the key out of the result", async () => {
    const workspace = await makeWorkspace();
    await writeImage(workspace, "input.png", "png");
    const payload = await expectOk(
      ["--prompt", "edit it", "--mode", "edit", "--image", "input.png"],
      { workspace, env: fullEnv() },
    );

    const digest = createHash("sha256").update(KEY).digest("hex");
    assert.equal(payload.api_key_fingerprint, `sha256:${digest.slice(0, 12)}`);

    const haystack = JSON.stringify(payload);
    assert.ok(!haystack.includes(KEY), "the API key must never be reported");
    assert.ok(!haystack.includes("data:image/"), "data URLs must never be reported");
  });
});

describe("offline guarantee", () => {
  it("completes a preflight against an unreachable endpoint", async () => {
    const payload = await expectOk(["--prompt", "a cup"], {
      env: fullEnv({ CODEX_IMAGE_BASE_URL: "http://127.0.0.1:1" }),
    });
    assert.equal(payload.endpoint, "http://127.0.0.1:1/responses");
    assert.equal(payload.ok, true);
  });
});
