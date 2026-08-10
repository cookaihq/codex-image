import { strict as assert } from "node:assert";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  IMAGE_FIXTURES,
  cleanupWorkspaces,
  completedWithImage,
  completedWithText,
  imageItemEvent,
  makeWorkspace,
  runCli,
  soleJson,
  sse,
  startMockProvider,
  startSse,
  writeImage,
} from "./helpers.mjs";

const KEY = "sk-execution-test-key";
const MODEL = "gpt-test-top-level";

const PNG_BASE64 = IMAGE_FIXTURES.png.toString("base64");
const JPEG_BASE64 = IMAGE_FIXTURES.jpeg.toString("base64");
const WEBP_BASE64 = IMAGE_FIXTURES.webp.toString("base64");

const servers = [];

async function provider(handler) {
  const server = await startMockProvider(handler);
  servers.push(server);
  return server;
}

/** Answers the first request with one image and holds no state of its own. */
function respondWithImage(base64 = PNG_BASE64, extra = {}) {
  return ({ response }) => {
    startSse(response, { "x-request-id": "req_mock_1" });
    response.write(sse({ type: "response.created", response: { id: "resp_1", model: "server-model" } }));
    response.write(sse(imageItemEvent(base64, extra)));
    response.end();
  };
}

async function execute(workspace, server, args = ["--prompt", "a cup"], extraEnv = {}) {
  const result = await runCli([...args, "--json"], {
    workspace,
    env: {
      CODEX_IMAGE_BASE_URL: server.url,
      CODEX_IMAGE_API_KEY: KEY,
      CODEX_IMAGE_MODEL: MODEL,
      ...extraEnv,
    },
  });
  return { result, payload: soleJson(result) };
}

async function runOnce(handler, args = ["--prompt", "a cup"], options = {}) {
  const workspace = options.workspace ?? (await makeWorkspace());
  const server = await provider(handler);
  const { result, payload } = await execute(workspace, server, args, options.env);
  return { workspace, server, result, payload };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await cleanupWorkspaces();
});

describe("request construction", () => {
  it("sends a text-only Responses request for generate", async () => {
    const { server, payload, result } = await runOnce(respondWithImage());
    assert.equal(payload.ok, true, result.stderr);
    const [request] = server.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.body.model, MODEL);
    assert.equal(request.body.input, "a cup");
    assert.deepEqual(request.body.tools, [{ type: "image_generation", action: "generate" }]);
    assert.equal(request.body.tool_choice, "auto");
    assert.equal(request.body.stream, true);
  });

  it("adds the requested size only when one was asked for", async () => {
    const { server } = await runOnce(respondWithImage(), ["--prompt", "a cup", "--size", "1024x1024"]);
    assert.deepEqual(server.requests[0].body.tools, [
      { type: "image_generation", action: "generate", size: "1024x1024" },
    ]);
  });

  it("sends reference images as a multimodal message and keeps generate", async () => {
    const workspace = await makeWorkspace();
    await writeImage(workspace, "one.png", "png");
    await writeImage(workspace, "two.webp", "webp");
    const { server } = await runOnce(
      respondWithImage(),
      ["--prompt", "reuse the palette", "--mode", "reference", "--image", "one.png", "--image", "two.webp"],
      { workspace },
    );
    const { body } = server.requests[0];
    assert.equal(body.tools[0].action, "generate");
    assert.equal(body.input[0].role, "user");
    assert.deepEqual(
      body.input[0].content.map((part) => part.type),
      ["input_text", "input_image", "input_image"],
    );
    assert.equal(body.input[0].content[0].text, "reuse the palette");
    assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
    assert.match(body.input[0].content[2].image_url, /^data:image\/webp;base64,/);
  });

  it("uses the edit action and passes a remote URL untouched", async () => {
    const { server } = await runOnce(respondWithImage(), [
      "--prompt",
      "only change the background",
      "--mode",
      "edit",
      "--image",
      "https://cdn.example/a.png",
    ]);
    const { body } = server.requests[0];
    assert.equal(body.tools[0].action, "edit");
    assert.equal(body.input[0].content[1].image_url, "https://cdn.example/a.png");
  });
});

describe("streaming responses", () => {
  it("accepts an image from response.completed", async () => {
    const { payload } = await runOnce(({ response }) => {
      startSse(response);
      response.write(sse(completedWithImage(PNG_BASE64)));
      response.end();
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.image.format, "png");
  });

  it("parses events split across arbitrary chunk boundaries", async () => {
    const { payload } = await runOnce(async ({ response }) => {
      startSse(response);
      const text = sse({ type: "response.created", response: { id: "r", model: "m" } }) + sse(imageItemEvent(PNG_BASE64));
      for (const character of text) {
        response.write(character);
        await new Promise((resolve) => setImmediate(resolve));
      }
      response.end();
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.image.width, 1);
  });

  it("records the metadata the provider actually returned", async () => {
    const { payload } = await runOnce(({ response }) => {
      startSse(response, { "x-request-id": "req_from_header" });
      response.write(sse({ type: "response.created", response: { id: "resp_9", model: "top-model" } }));
      response.write(
        sse(
          imageItemEvent(PNG_BASE64, {
            model: "gpt-image-test",
            revised_prompt: "a white ceramic cup",
            settings: { size: "auto" },
          }),
        ),
      );
      response.end();
    });
    assert.equal(payload.response_model, "top-model");
    assert.equal(payload.image_model, "gpt-image-test");
    assert.equal(payload.revised_prompt, "a white ceramic cup");
    assert.deepEqual(payload.tool_settings, { size: "auto" });
    assert.equal(payload.request_id, "req_from_header");
  });

  it("reports absent metadata as null rather than inventing it", async () => {
    const { payload } = await runOnce(({ response }) => {
      startSse(response);
      response.write(sse(imageItemEvent(PNG_BASE64)));
      response.end();
    });
    assert.equal(payload.image_model, null);
    assert.equal(payload.revised_prompt, null);
    assert.equal(payload.tool_settings, null, "an empty object must not stand in for no settings");
  });

  it("stops reading once the image arrived, even if the stream stays open", async () => {
    const { payload, server } = await runOnce(({ response }) => {
      startSse(response);
      response.write(sse(imageItemEvent(PNG_BASE64)));
      // Deliberately never ended: the command must not wait for more metadata.
    });
    assert.equal(payload.ok, true);
    assert.equal(server.requests.length, 1);
  });
});

describe("retry policy", () => {
  it("retries a 500 and reports both attempts", async () => {
    const { payload, server } = await runOnce(({ response, attempt }) => {
      if (attempt === 1) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "server_error", message: "try again" } }));
        return;
      }
      respondWithImage()({ response });
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.attempts, 2);
    assert.equal(server.requests.length, 2);
  });

  it("honours a short Retry-After and refuses a long one", async () => {
    const short = await runOnce(({ response, attempt }) => {
      if (attempt === 1) {
        response.writeHead(429, { "retry-after": "1" });
        response.end("{}");
        return;
      }
      respondWithImage()({ response });
    });
    assert.equal(short.payload.ok, true);
    assert.equal(short.payload.attempts, 2);

    const long = await runOnce(({ response }) => {
      response.writeHead(429, { "retry-after": "120" });
      response.end("{}");
    });
    assert.equal(long.payload.ok, false);
    assert.equal(long.payload.error.code, "provider_error");
    assert.equal(long.server.requests.length, 1, "a long Retry-After stops the retry sequence");
  });

  const terminal = {
    "a 400": [400, "provider_error"],
    "a 401": [401, "auth_error"],
    "a 403": [403, "auth_error"],
    "a 404": [404, "provider_error"],
    "a 422": [422, "provider_error"],
  };

  for (const [description, [status, code]] of Object.entries(terminal)) {
    it(`never retries ${description}`, async () => {
      const { payload, server } = await runOnce(({ response }) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "denied", message: "no" } }));
      });
      assert.equal(payload.error.code, code);
      assert.equal(server.requests.length, 1);
      assert.equal(payload.network_started, true);
      assert.equal(payload.attempts, 1);
    });
  }

  it("never retries response.failed", async () => {
    const { payload, server } = await runOnce(({ response }) => {
      startSse(response);
      response.write(
        sse({ type: "response.failed", response: { error: { code: "content_policy", message: "blocked" } } }),
      );
      response.end();
    });
    assert.equal(payload.error.code, "provider_error");
    assert.match(payload.error.message, /content_policy/);
    assert.equal(server.requests.length, 1);
  });

  it("never retries a completed response that chose not to make an image", async () => {
    const { payload, server } = await runOnce(({ response }) => {
      startSse(response);
      response.write(sse(completedWithText()));
      response.end();
    });
    assert.equal(payload.error.code, "image_not_returned");
    assert.equal(server.requests.length, 1);
  });

  it("retries an empty stream up to the disclosed maximum", async () => {
    const { payload, server } = await runOnce(({ response }) => {
      startSse(response);
      response.end();
    });
    assert.equal(payload.error.code, "image_not_returned");
    assert.equal(server.requests.length, 4, "a single authorisation allows at most four requests");
    assert.equal(payload.attempts, 4);
  });

  it("stops immediately once an image was received", async () => {
    const { payload, server } = await runOnce(({ response }) => {
      startSse(response);
      response.write(sse(imageItemEvent("not-valid-base64!!")));
      response.end();
    });
    assert.equal(payload.error.code, "invalid_image_result");
    assert.equal(server.requests.length, 1, "an image that arrived is never re-requested");
  });
});

describe("image validation and output", () => {
  const formats = {
    png: [PNG_BASE64, ".png", "image/png"],
    jpeg: [JPEG_BASE64, ".jpg", "image/jpeg"],
    webp: [WEBP_BASE64, ".webp", "image/webp"],
  };

  for (const [format, [base64, extension, mime]] of Object.entries(formats)) {
    it(`validates and names a ${format} result from its bytes`, async () => {
      const { payload } = await runOnce(respondWithImage(base64));
      assert.equal(payload.image.format, format);
      assert.equal(payload.image.mime, mime);
      assert.equal(payload.image.width, 1);
      assert.equal(payload.image.height, 1);
      assert.ok(payload.path.endsWith(extension));
      assert.match(payload.path, /\d{8}-\d{6}-image\./);
      const written = await readFile(payload.path);
      assert.equal(written.length, payload.image.bytes);
    });
  }

  it("rejects a payload that is not an image and writes nothing", async () => {
    const { payload, workspace } = await runOnce(({ response }) => {
      startSse(response);
      response.write(sse(imageItemEvent(Buffer.from("<html>nope</html>").toString("base64"))));
      response.end();
    });
    assert.equal(payload.error.code, "invalid_image_result");
    assert.equal(await exists(join(workspace.cwd, "codex-image", "output")), false);
  });

  it("uses the label and suffixes a colliding name", async () => {
    const workspace = await makeWorkspace();
    const first = await runOnce(respondWithImage(), ["--prompt", "a cup", "--label", "red cup"], {
      workspace,
    });
    assert.match(first.payload.path, /-red-cup\.png$/);

    const second = await runOnce(respondWithImage(), ["--prompt", "a cup", "--label", "red cup"], {
      workspace,
    });
    assert.notEqual(second.payload.path, first.payload.path);
    const directory = join(workspace.cwd, "codex-image", "output");
    const entries = await readdir(directory);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => !entry.endsWith(".part")), "no temporary file may survive");
  });

  it("writes to an explicit output path and refuses a mismatched extension", async () => {
    const workspace = await makeWorkspace();
    const wanted = join(workspace.cwd, "shots", "cup.png");
    const good = await runOnce(respondWithImage(), ["--prompt", "a cup", "--output", wanted], {
      workspace,
    });
    assert.equal(good.payload.path, wanted);

    const mismatch = await runOnce(respondWithImage(JPEG_BASE64), [
      "--prompt",
      "a cup",
      "--output",
      join(workspace.cwd, "shots", "other.png"),
    ]);
    assert.equal(mismatch.payload.error.code, "output_format_mismatch");
  });

  it("leaves no partial file when the result is rejected", async () => {
    const workspace = await makeWorkspace();
    await runOnce(
      ({ response }) => {
        startSse(response);
        response.write(sse(imageItemEvent(Buffer.from("still not an image").toString("base64"))));
        response.end();
      },
      ["--prompt", "a cup", "--output-dir", "shots"],
      { workspace },
    );
    let entries = [];
    try {
      entries = await readdir(join(workspace.cwd, "shots"));
    } catch {
      entries = [];
    }
    assert.deepEqual(entries, []);
  });
});

describe("result contract", () => {
  it("returns the full success contract without leaving state behind", async () => {
    const { payload, result, workspace } = await runOnce(respondWithImage());
    assert.equal(result.exitCode, 0);
    assert.equal(payload.mode, "generate");
    assert.equal(payload.requested_model, MODEL);
    assert.equal(payload.requested_size, null);
    assert.equal(payload.attempts, 1);
    assert.deepEqual(payload.config_sources, {
      base_url: "environment",
      api_key: "environment",
      model: "environment",
      output_dir: "default",
    });
    assert.equal(
      await exists(join(workspace.cwd, ".codex-image")),
      false,
      "a run must not create a state directory",
    );
    assert.ok(!`${result.stdout}${result.stderr}`.includes(KEY));
  });

  it("distinguishes a failure after a POST from a local failure", async () => {
    const { payload, result, workspace } = await runOnce(({ response }) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "bad_request", message: "nope" } }));
    });
    assert.equal(result.exitCode, 1, "a failure after a POST is distinguishable from a local failure");
    assert.equal(payload.network_started, true);
    assert.equal(payload.attempts, 1);
    assert.equal(
      await exists(join(workspace.cwd, ".codex-image")),
      false,
      "a failed run must not create a state directory either",
    );
  });
});

describe("provider error reporting", () => {
  it("never echoes the request body or the whole response", async () => {
    const secret = "sk-execution-test-key";
    const { result } = await runOnce(({ response }) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "server_error", message: "boom", internals: "x".repeat(200_000) },
        }),
      );
    });
    const combined = `${result.stdout}${result.stderr}`;
    assert.ok(!combined.includes(secret));
    assert.ok(!combined.includes("x".repeat(1000)), "the response body is never passed through");
  });

  it("surfaces a sanitised provider code and message", async () => {
    const { payload } = await runOnce(({ response }) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "no_compatible_channel", message: "model unavailable" } }),
      );
    });
    assert.match(payload.error.message, /no_compatible_channel/);
    assert.match(payload.error.message, /model unavailable/);
  });
});
