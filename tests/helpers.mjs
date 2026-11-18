import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SCRIPT = fileURLToPath(new URL("../scripts/generate-image.mjs", import.meta.url));

const workspaces = [];

/**
 * A workspace isolates a run from the developer's own machine: its own working
 * directory, its own HOME, and a PATH containing only what a test installs.
 */
export async function makeWorkspace() {
  // Resolved through symlinks so expected paths match what the script sees as its cwd.
  const parent = await realpath(process.env.CODEX_IMAGE_TEST_TMP ?? tmpdir());
  const root = await realpath(await mkdtemp(join(parent, "codex-image-")));
  const workspace = {
    root,
    cwd: join(root, "project"),
    home: join(root, "home"),
    bin: join(root, "bin"),
    codexLog: join(root, "codex-invocations.log"),
  };
  await mkdir(workspace.cwd, { recursive: true });
  await mkdir(workspace.home, { recursive: true });
  await mkdir(workspace.bin, { recursive: true });
  workspaces.push(root);
  return workspace;
}

export async function cleanupWorkspaces() {
  await Promise.all(workspaces.map((root) => rm(root, { recursive: true, force: true })));
  workspaces.length = 0;
}

export function envFor(workspace, overrides = {}) {
  return {
    PATH: workspace.bin,
    HOME: workspace.home,
    ...(process.platform === "win32" ? { USERPROFILE: workspace.home, SystemRoot: process.env.SystemRoot } : {}),
    CODEX_HOME: join(workspace.home, ".codex"),
    ...overrides,
  };
}

export async function runCli(args, { workspace, env = {}, cwd } = {}) {
  const ws = workspace ?? (await makeWorkspace());
  const options = {
    cwd: cwd ?? ws.cwd,
    env: envFor(ws, env),
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], options);
    return { exitCode: 0, stdout, stderr, workspace: ws };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      workspace: ws,
    };
  }
}

/** Parses the single JSON document a --json run is allowed to print. */
export function soleJson(result) {
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`expected exactly one JSON result, got ${lines.length}:\n${result.stdout}
${result.stderr}`);
  }
  return JSON.parse(lines[0]);
}

// Native Windows exercises the same official npm shim layout as a real installation.
export async function installStubCodex(workspace, options = {}) {
  const { version = "0.146.0", login = "account", exec: execMode = "success" } = options;
  const fixturePath = join(workspace.root, "delegate-fixture.png");
  await writeFile(fixturePath, IMAGE_FIXTURES.png);
  const execute = async (args, options) => {
    const { appendFile, copyFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await appendFile(options.log, args.join(" ") + "\n");
    if (args[0] === "--version") return console.log("codex-cli " + options.version);
    if (args[0] === "login") {
      if (options.login === "account") console.log("Logged in using ChatGPT account (tester@example.com)");
      if (options.login === "api_key") console.log("Logged in using an API key - sk-abcd***wxyz");
      if (options.login === "logged_out") { console.log("Not logged in"); process.exitCode = 1; }
      return;
    }
    if (args[0] !== "exec") return;
    const dir = args[args.indexOf("-C") + 1];
    const message = args[args.indexOf("--output-last-message") + 1];
    const image = join(dir, "generated.png");
    if (options.execMode === "auth_failure") { console.error("Not logged in"); process.exitCode = 1; return; }
    if (options.execMode === "crash") { console.error("the session crashed"); process.exitCode = 3; return; }
    if (options.execMode === "hang") { await new Promise(resolve => setTimeout(resolve, 30000)); return; }
    if (options.execMode === "not_an_image") await writeFile(image, "this is not an image");
    else if (options.execMode !== "missing_file") await copyFile(options.fixture, image);
    if (options.execMode === "no_structured_result") return;
    await writeFile(message, JSON.stringify({
      image_path: options.execMode === "relative_path" ? "generated.png" : options.execMode === "missing_file" ? join(dir, "absent.png") : image,
      ...(options.execMode === "success_with_model" ? { image_model: "gpt-image-stub" } : {}),
    }));
  };
  const script = "(" + execute.toString() + ")(process.argv.slice(2), " +
    JSON.stringify({ version, login, execMode, fixture: fixturePath, log: workspace.codexLog }) + ").catch(error => { console.error(error); process.exitCode = 1; });\n";
  if (process.platform === "win32") {
    const command = join(workspace.bin, "codex.cmd");
    const directory = join(workspace.bin, "node_modules", "@openai", "codex", "bin");
    await mkdir(directory, { recursive: true });
    await writeFile(command, "@echo off\r\nexit /B 99\r\n");
    await writeFile(join(directory, "codex.js"), script);
    return command;
  }
  const command = join(workspace.bin, "codex");
  await writeFile(command, "#!" + process.execPath + "\n" + script, { mode: 0o755 });
  return command;
}

/** The full argv of each delegated call, so a test can inspect what was passed. */
export async function codexExecCalls(workspace) {
  const lines = await codexInvocations(workspace);
  return lines.filter((line) => line.startsWith("exec "));
}

export async function codexInvocations(workspace) {
  try {
    const text = await readFile(workspace.codexLog, "utf8");
    return text.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

export async function writeFileIn(workspace, relativePath, contents) {
  const path = join(workspace.cwd, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  return path;
}

export async function writeCodexHome(workspace, { configToml = null, authJson = null } = {}) {
  const home = join(workspace.home, ".codex");
  await mkdir(home, { recursive: true });
  if (configToml !== null) {
    await writeFile(join(home, "config.toml"), configToml);
  }
  if (authJson !== null) {
    await writeFile(
      join(home, "auth.json"),
      typeof authJson === "string" ? authJson : JSON.stringify(authJson),
    );
  }
  return home;
}

export async function writeSkillHomeEnv(workspace, contents) {
  const directory = join(workspace.home, ".config", "codex-image");
  await mkdir(directory, { recursive: true });
  const path = join(directory, ".env");
  await writeFile(path, contents);
  return path;
}

/** Smallest real images, so magic-byte and dimension checks see genuine files. */
export const IMAGE_FIXTURES = Object.freeze({
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
  jpeg: Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64",
  ),
  webp: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
});

/**
 * A local provider stand-in. Every request is recorded so a test can assert how
 * many POSTs a single authorisation produced.
 */
export async function startMockProvider(handler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = null;
      }
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(record);
      try {
        await handler({ request, response, body, attempt: requests.length, record });
      } catch {
        if (!response.writableEnded) {
          response.destroy();
        }
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function startSse(response, headers = {}) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    ...headers,
  });
}

export function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function imageItemEvent(base64, extra = {}) {
  return {
    type: "response.output_item.done",
    item: { type: "image_generation_call", result: base64, ...extra },
  };
}

export function completedWithImage(base64, extra = {}) {
  return {
    type: "response.completed",
    response: {
      id: "resp_completed",
      output: [{ type: "image_generation_call", result: base64, ...extra }],
    },
  };
}

export function completedWithText(text = "I cannot create that image.") {
  return {
    type: "response.completed",
    response: {
      id: "resp_text",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    },
  };
}

export async function writeImage(workspace, name, format = "png") {
  const path = join(workspace.cwd, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, IMAGE_FIXTURES[format]);
  return path;
}
