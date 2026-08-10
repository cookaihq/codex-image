#!/usr/bin/env node
/**
 * codex-image — generate, reference and edit images through a Codex-compatible
 * provider, or by delegating to a locally installed, account-authenticated
 * Codex CLI.
 *
 * Runtime requirements: Node.js 18+ standard library only.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Stable error codes. Callers may branch on these strings; messages may change.
 */
export const STABLE_ERROR_CODES = Object.freeze([
  "invalid_arguments",
  "config_missing_base_url",
  "config_missing_api_key",
  "config_missing_model",
  "config_invalid_codex_config",
  "config_invalid_codex_auth",
  "config_invalid_base_url",
  "config_read_error",
  "home_config_permission_required",
  "codex_cli_not_found",
  "codex_cli_version_unsupported",
  "codex_not_authenticated",
  "codex_not_account_login",
  "codex_auth_error",
  "codex_delegate_failed",
  "codex_delegate_unsupported_input",
  "invalid_mode",
  "image_read_error",
  "auth_error",
  "network_error",
  "provider_error",
  "image_not_returned",
  "invalid_image_result",
  "output_exists",
  "output_format_mismatch",
  "output_write_error",
  "not_implemented",
]);

const MODES = Object.freeze(["generate", "reference", "edit"]);
const ROUTES = Object.freeze(["http", "codex-cli"]);

const CONFIG_VARIABLES = Object.freeze({
  baseUrl: "CODEX_IMAGE_BASE_URL",
  apiKey: "CODEX_IMAGE_API_KEY",
  model: "CODEX_IMAGE_MODEL",
  outputDir: "CODEX_IMAGE_OUTPUT_DIR",
});

const RECOGNISED_ENV_KEYS = new Set(Object.values(CONFIG_VARIABLES));

const HTTP_MAX_ATTEMPTS = 4;
const DELEGATE_MAX_CALLS = 1;
const REQUEST_TIMEOUT_MS = 300_000;
const FAST_FAILURE_MS = 45_000;
const MINIMUM_CODEX_VERSION = "0.146.0";
const CODEX_PROBE_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const IMAGE_FORMATS = Object.freeze({
  png: { mime: "image/png", extensions: [".png"] },
  jpeg: { mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  webp: { mime: "image/webp", extensions: [".webp"] },
});

// ---------------------------------------------------------------------------
// Argument surface
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  "help",
  "preflight",
  "json",
  "use-local-key",
  "use-codex-config",
]);

const VALUE_FLAGS = new Set([
  "prompt",
  "image",
  "mode",
  "size",
  "label",
  "output",
  "output-dir",
  "via",
]);

const REPEATABLE_FLAGS = new Set(["image"]);

const ALIASES = new Map([["h", "help"]]);

/**
 * Flags that would carry a credential. Rejected with a dedicated message so the
 * caller learns the supported channel instead of retrying with another spelling.
 */
const CREDENTIAL_FLAG_SHAPES = new Set([
  "apikey",
  "apitoken",
  "apisecret",
  "accesstoken",
  "authtoken",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "key",
  "openaiapikey",
  "password",
  "secret",
  "token",
]);

export class CliError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

function normalizeFlagShape(name) {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function assertKnownFlag(name) {
  if (CREDENTIAL_FLAG_SHAPES.has(normalizeFlagShape(name))) {
    throw new CliError(
      "invalid_arguments",
      `--${name} is not accepted: credentials must never be passed on the command line. ` +
        "Provide CODEX_IMAGE_API_KEY through the environment or a .env file instead.",
    );
  }
  if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
    throw new CliError("invalid_arguments", `Unknown option --${name}.`);
  }
}

export function parseArgv(argv) {
  const flags = new Map();
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      throw new CliError("invalid_arguments", "Positional arguments are not supported.");
    }
    if (!token.startsWith("-")) {
      throw new CliError(
        "invalid_arguments",
        `Unexpected positional argument "${token}". Every input is passed through a named option.`,
      );
    }

    const withoutDashes = token.replace(/^--?/, "");
    const equalsAt = withoutDashes.indexOf("=");
    const rawName = equalsAt === -1 ? withoutDashes : withoutDashes.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? null : withoutDashes.slice(equalsAt + 1);
    const name = ALIASES.get(rawName) ?? rawName;

    assertKnownFlag(name);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) {
        throw new CliError("invalid_arguments", `--${name} does not take a value.`);
      }
      if (seen.has(name)) {
        throw new CliError("invalid_arguments", `--${name} was given more than once.`);
      }
      seen.add(name);
      flags.set(name, true);
      continue;
    }

    let value = inlineValue;
    if (value === null) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError("invalid_arguments", `--${name} requires a value.`);
      }
      index += 1;
    }

    if (REPEATABLE_FLAGS.has(name)) {
      const existing = flags.get(name) ?? [];
      existing.push(value);
      flags.set(name, existing);
      continue;
    }
    if (seen.has(name)) {
      throw new CliError("invalid_arguments", `--${name} was given more than once.`);
    }
    seen.add(name);
    flags.set(name, value);
  }

  return flags;
}

function resolveMode(flags) {
  const images = flags.get("image") ?? [];
  const declaredMode = flags.get("mode") ?? null;

  if (declaredMode !== null && !MODES.includes(declaredMode)) {
    throw new CliError(
      "invalid_arguments",
      `--mode must be one of ${MODES.join(", ")}; received "${declaredMode}".`,
    );
  }

  if (images.length === 0) {
    if (declaredMode !== null && declaredMode !== "generate") {
      throw new CliError("invalid_mode", `Mode "${declaredMode}" requires at least one --image.`);
    }
    return "generate";
  }

  if (declaredMode === null) {
    throw new CliError(
      "invalid_mode",
      "--mode reference|edit must be stated explicitly when --image is used. " +
        "The mode is never inferred from the prompt.",
    );
  }
  if (declaredMode === "generate") {
    throw new CliError("invalid_mode", 'Mode "generate" does not accept --image.');
  }
  return declaredMode;
}

function requirePrompt(flags) {
  const prompt = flags.get("prompt");
  if (prompt === undefined || prompt.trim() === "") {
    throw new CliError("invalid_arguments", "--prompt is required and must not be empty.");
  }
  return prompt;
}

/**
 * Resolves the argv into one executable command. Throws CliError for every
 * misuse so the caller never reaches configuration, disk or network work.
 */
export function resolveCommand(argv) {
  const flags = parseArgv(argv);
  const json = flags.get("json") === true;

  if (flags.get("help") === true) {
    return { command: "help", json, flags };
  }

  if (flags.has("output") && flags.has("output-dir")) {
    throw new CliError(
      "invalid_arguments",
      "--output and --output-dir are mutually exclusive; the precedence between them is never guessed.",
    );
  }

  const via = flags.get("via") ?? null;
  if (via !== null && !ROUTES.includes(via)) {
    throw new CliError(
      "invalid_arguments",
      `--via must be one of ${ROUTES.join(", ")}; received "${via}".`,
    );
  }

  const mode = resolveMode(flags);
  const prompt = requirePrompt(flags);

  return {
    command: flags.get("preflight") === true ? "preflight" : "execute",
    json,
    flags,
    request: {
      mode,
      prompt,
      images: flags.get("image") ?? [],
      size: flags.get("size") ?? null,
      label: flags.get("label") ?? null,
      output: flags.get("output") ?? null,
      outputDir: flags.get("output-dir") ?? null,
      via,
      useLocalKey: flags.get("use-local-key") === true,
      useCodexConfig: flags.get("use-codex-config") === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Hashing and canonicalisation
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Configuration layers
// ---------------------------------------------------------------------------

/**
 * Minimal, non-shell .env parsing: KEY=value with optional matching quotes,
 * blank lines and whole-line comments. No expansion, substitution or
 * continuation; the last occurrence of a key wins.
 */
export function parseEnvFile(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt <= 0) {
      continue;
    }
    const key = line.slice(0, equalsAt).trim();
    if (!RECOGNISED_ENV_KEYS.has(key)) {
      continue;
    }
    let value = line.slice(equalsAt + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    values.set(key, value);
  }
  return values;
}

async function readEnvFileIfPresent(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return new Map();
    }
    throw new CliError("config_read_error", `Configuration file ${path} exists but could not be read.`);
  }
  return parseEnvFile(text);
}

function readQuotedString(text, start) {
  const quote = text[start];
  if (quote === '"') {
    let index = start + 1;
    let out = "";
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        const next = text[index + 1];
        const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
        if (next in simple) {
          out += simple[next];
          index += 2;
          continue;
        }
        if (next === "u" || next === "U") {
          const width = next === "u" ? 4 : 8;
          const hex = text.slice(index + 2, index + 2 + width);
          if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
            return null;
          }
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          index += 2 + width;
          continue;
        }
        return null;
      }
      if (char === '"') {
        return { value: out, end: index + 1 };
      }
      out += char;
      index += 1;
    }
    return null;
  }
  if (quote === "'") {
    const end = text.indexOf("'", start + 1);
    if (end === -1) {
      return null;
    }
    return { value: text.slice(start + 1, end), end: end + 1 };
  }
  return null;
}

function readKeyPath(text, start) {
  const segments = [];
  let index = start;
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    const char = text[index];
    if (char === '"' || char === "'") {
      const parsed = readQuotedString(text, index);
      if (parsed === null) {
        return null;
      }
      segments.push(parsed.value);
      index = parsed.end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
      if (match === null) {
        return null;
      }
      segments.push(match[0]);
      index += match[0].length;
    }
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      continue;
    }
    return { segments, end: index };
  }
}

/**
 * Reads only the three fields the Codex fallback needs. Anything ambiguous or
 * structurally unsupported for a required field is rejected rather than guessed.
 */
export function parseCodexConfigToml(text) {
  const lines = text.split(/\r?\n/);
  const found = { modelProvider: undefined, model: undefined, baseUrl: undefined };
  const assigned = new Set();
  let tablePath = [];
  let skipUntil = null;
  let arrayDepth = 0;
  const unsupportedProviders = new Set();
  let allProvidersInline = false;

  const invalid = (reason) =>
    new CliError(
      "config_invalid_codex_config",
      `The Codex configuration could not be read reliably (${reason}). ` +
        "Provide CODEX_IMAGE_BASE_URL and CODEX_IMAGE_MODEL explicitly instead.",
    );

  for (const rawLine of lines) {
    if (skipUntil !== null) {
      if (rawLine.includes(skipUntil)) {
        skipUntil = null;
      }
      continue;
    }
    if (arrayDepth > 0) {
      for (const char of rawLine) {
        if (char === "[") arrayDepth += 1;
        else if (char === "]") arrayDepth -= 1;
      }
      continue;
    }

    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[")) {
      if (line.startsWith("[[")) {
        tablePath = null;
        continue;
      }
      const parsed = readKeyPath(line, 1);
      if (parsed === null || line[parsed.end] !== "]") {
        tablePath = null;
        continue;
      }
      tablePath = parsed.segments;
      continue;
    }

    const keyPath = readKeyPath(line, 0);
    if (keyPath === null) {
      continue;
    }
    let cursor = keyPath.end;
    if (line[cursor] !== "=") {
      continue;
    }
    cursor += 1;
    while (cursor < line.length && /\s/.test(line[cursor])) {
      cursor += 1;
    }
    const valueText = line.slice(cursor);

    const atTopLevel = Array.isArray(tablePath) && tablePath.length === 0;
    const providerName = found.modelProvider;
    const inProviderTable =
      Array.isArray(tablePath) &&
      tablePath.length === 2 &&
      tablePath[0] === "model_providers" &&
      providerName !== undefined &&
      tablePath[1] === providerName;

    let target = null;
    if (keyPath.segments.length === 1) {
      const [key] = keyPath.segments;
      if (atTopLevel && key === "model_provider") target = "modelProvider";
      else if (atTopLevel && key === "model") target = "model";
      else if (inProviderTable && key === "base_url") target = "baseUrl";
    }

    // A provider's base URL may only be read from its own table. Other shapes are
    // recorded and rejected at the end, once the selected provider is known.
    const inProvidersTable =
      Array.isArray(tablePath) && tablePath.length === 1 && tablePath[0] === "model_providers";
    const segments = keyPath.segments;
    if (atTopLevel && segments.length === 3 && segments[0] === "model_providers" && segments[2] === "base_url") {
      unsupportedProviders.add(segments[1]);
    } else if (inProvidersTable && segments.length === 2 && segments[1] === "base_url") {
      unsupportedProviders.add(segments[0]);
    } else if (inProvidersTable && segments.length === 1 && valueText.startsWith("{")) {
      unsupportedProviders.add(segments[0]);
    } else if (
      atTopLevel &&
      segments.length === 2 &&
      segments[0] === "model_providers" &&
      valueText.startsWith("{")
    ) {
      unsupportedProviders.add(segments[1]);
    } else if (atTopLevel && segments.length === 1 && segments[0] === "model_providers" && valueText.startsWith("{")) {
      allProvidersInline = true;
    }

    if (target === null) {
      if (valueText.startsWith('"""') || valueText.startsWith("'''")) {
        skipUntil = valueText.slice(0, 3);
      } else if (valueText.startsWith("[")) {
        let depth = 0;
        for (const char of valueText) {
          if (char === "[") depth += 1;
          else if (char === "]") depth -= 1;
        }
        arrayDepth = Math.max(depth, 0);
      }
      continue;
    }

    if (assigned.has(target)) {
      throw invalid(`"${keyPath.segments.join(".")}" is defined more than once`);
    }
    if (valueText.startsWith('"""') || valueText.startsWith("'''")) {
      throw invalid(`"${keyPath.segments.join(".")}" uses a multi-line string`);
    }
    const parsedValue = readQuotedString(valueText, 0);
    if (parsedValue === null) {
      throw invalid(`"${keyPath.segments.join(".")}" is not a plain string`);
    }
    const rest = valueText.slice(parsedValue.end).trim();
    if (rest !== "" && !rest.startsWith("#")) {
      throw invalid(`"${keyPath.segments.join(".")}" has trailing content after the string`);
    }

    found[target] = parsedValue.value;
    assigned.add(target);

    if (found.modelProvider !== undefined && found.model !== undefined && found.baseUrl !== undefined) {
      break;
    }
  }

  if (
    found.baseUrl === undefined &&
    found.modelProvider !== undefined &&
    (allProvidersInline || unsupportedProviders.has(found.modelProvider))
  ) {
    throw invalid(
      `the base URL for provider "${found.modelProvider}" is declared in an unsupported structure`,
    );
  }

  return found;
}

function codexHome(env) {
  const override = env.CODEX_HOME;
  if (override && override.trim() !== "") {
    return override;
  }
  return join(homedir(), ".codex");
}

function skillHomeConfigPath() {
  return join(homedir(), ".config", "codex-image", ".env");
}

async function readCodexConfigLayer(env) {
  const home = codexHome(env);
  const result = { baseUrl: undefined, model: undefined, apiKey: undefined };

  let configText = null;
  try {
    configText = await readFile(join(home, "config.toml"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      throw new CliError("config_read_error", "The Codex configuration file exists but could not be read.");
    }
  }
  if (configText !== null) {
    const parsed = parseCodexConfigToml(configText);
    result.baseUrl = parsed.baseUrl;
    result.model = parsed.model;
  }

  let authText = null;
  try {
    authText = await readFile(join(home, "auth.json"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      throw new CliError("config_read_error", "The Codex auth file exists but could not be read.");
    }
  }
  if (authText !== null) {
    let auth;
    try {
      auth = JSON.parse(authText);
    } catch {
      throw new CliError(
        "config_invalid_codex_auth",
        "The Codex auth file could not be parsed as JSON. Provide CODEX_IMAGE_API_KEY explicitly instead.",
      );
    }
    const key = auth?.OPENAI_API_KEY;
    if (typeof key === "string" && key.trim() !== "") {
      result.apiKey = key;
    }
  }

  return result;
}

const SOURCE_NAMES = Object.freeze({
  environment: "environment",
  projectEnvLocal: "project_env_local",
  projectEnv: "project_env",
  homeEnv: "home_env",
  codexConfig: "codex_config",
  codexAuth: "codex_auth",
  argument: "argument",
  defaultValue: "default",
});

/**
 * Per-field first-found-wins resolution. Only layers the caller authorised for
 * this invocation are consulted.
 */
export async function resolveConfiguration({ cwd, env, useLocalKey, useCodexConfig }) {
  const layers = [];

  const fromEnvironment = new Map();
  for (const name of RECOGNISED_ENV_KEYS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") {
      fromEnvironment.set(name, value);
    }
  }
  layers.push({ source: SOURCE_NAMES.environment, values: fromEnvironment });
  layers.push({
    source: SOURCE_NAMES.projectEnvLocal,
    values: await readEnvFileIfPresent(join(cwd, ".env.local")),
  });
  layers.push({
    source: SOURCE_NAMES.projectEnv,
    values: await readEnvFileIfPresent(join(cwd, ".env")),
  });

  if (useLocalKey) {
    layers.push({
      source: SOURCE_NAMES.homeEnv,
      values: await readEnvFileIfPresent(skillHomeConfigPath()),
    });
  }

  let codexLayer = null;
  if (useCodexConfig) {
    codexLayer = await readCodexConfigLayer(env);
  }

  const pick = (field) => {
    const name = CONFIG_VARIABLES[field];
    for (const layer of layers) {
      const value = layer.values.get(name);
      if (typeof value === "string" && value.trim() !== "") {
        return { value: value.trim(), source: layer.source };
      }
    }
    if (codexLayer !== null && field !== "outputDir") {
      const value = codexLayer[field];
      if (typeof value === "string" && value.trim() !== "") {
        return {
          value: value.trim(),
          source: field === "apiKey" ? SOURCE_NAMES.codexAuth : SOURCE_NAMES.codexConfig,
        };
      }
    }
    return { value: null, source: null };
  };

  return {
    baseUrl: pick("baseUrl"),
    apiKey: pick("apiKey"),
    model: pick("model"),
    outputDir: pick("outputDir"),
    homeAuthorised: { useLocalKey, useCodexConfig },
  };
}

export function normalizeEndpoint(baseUrl, apiKeySource) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CliError("config_invalid_base_url", "The base URL is not an absolute URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CliError("config_invalid_base_url", "The base URL must not embed credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CliError(
      "config_invalid_base_url",
      "The base URL must not carry a query string or fragment.",
    );
  }
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(`[${url.hostname}]`)) {
      throw new CliError("config_invalid_base_url", "Plain HTTP is only allowed for loopback testing.");
    }
    if (apiKeySource !== SOURCE_NAMES.environment) {
      throw new CliError(
        "config_invalid_base_url",
        "A loopback HTTP base URL may only be combined with an API key supplied through the process environment.",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new CliError("config_invalid_base_url", "The base URL must use HTTPS.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}/responses`;
}

// ---------------------------------------------------------------------------
// Codex CLI delegation prerequisites
// ---------------------------------------------------------------------------

function compareVersions(left, right) {
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

async function findExecutable(name, env) {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    if (directory === "") {
      continue;
    }
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Detects whether the local Codex CLI can act as the delegate. Login shape is
 * read through the CLI's own status command; its raw output may contain
 * fragments of a key and is therefore never propagated.
 */
export async function detectDelegatePrerequisites(env) {
  const executable = await findExecutable("codex", env);
  if (executable === null) {
    return { available: false, code: "codex_cli_not_found", version: null, login: null };
  }

  let version = null;
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      timeout: CODEX_PROBE_TIMEOUT_MS,
      env,
    });
    const match = /(\d+\.\d+\.\d+)/.exec(stdout);
    version = match?.[1] ?? null;
  } catch {
    version = null;
  }
  if (version === null || compareVersions(version, MINIMUM_CODEX_VERSION) < 0) {
    return {
      available: false,
      code: "codex_cli_version_unsupported",
      version,
      login: null,
    };
  }

  let loginShape = "unknown";
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["login", "status"], {
      timeout: CODEX_PROBE_TIMEOUT_MS,
      env,
    });
    loginShape = classifyLoginOutput(`${stdout}${stderr}`, 0);
  } catch (error) {
    if (typeof error.code === "number" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      loginShape = classifyLoginOutput(`${error.stdout ?? ""}${error.stderr ?? ""}`, 1);
    } else {
      loginShape = "unknown";
    }
  }

  if (loginShape === "logged_out") {
    return { available: false, code: "codex_not_authenticated", version, login: loginShape };
  }
  if (loginShape === "api_key") {
    return { available: false, code: "codex_not_account_login", version, login: loginShape };
  }
  if (loginShape === "unknown") {
    return { available: false, code: "codex_not_authenticated", version, login: loginShape };
  }
  return { available: true, code: null, version, login: loginShape, executable };
}

/** Exit status decides logged-in vs logged-out; the text distinguishes the shape. */
export function classifyLoginOutput(text, exitCode) {
  const normalised = text.toLowerCase();
  if (exitCode !== 0 || normalised.includes("not logged in")) {
    return "logged_out";
  }
  if (normalised.includes("api key")) {
    return "api_key";
  }
  if (normalised.trim() === "") {
    return "unknown";
  }
  return "account";
}

function delegateErrorMessage(code, detection) {
  switch (code) {
    case "codex_cli_not_found":
      return "No codex executable was found on PATH, so the delegation route is unavailable.";
    case "codex_cli_version_unsupported":
      return `The local Codex CLI reports version ${detection.version ?? "unknown"}; delegation needs ${MINIMUM_CODEX_VERSION} or newer.`;
    case "codex_not_authenticated":
      return "The local Codex CLI is not logged in, so the delegation route is unavailable.";
    case "codex_not_account_login":
      return (
        "The local Codex CLI is logged in with an API key rather than a ChatGPT account. " +
        "Delegation only serves account logins; use the HTTP route instead " +
        "(--use-codex-config, or set CODEX_IMAGE_BASE_URL and CODEX_IMAGE_API_KEY)."
      );
    default:
      return "The delegation route is unavailable.";
  }
}

// ---------------------------------------------------------------------------
// Image inputs
// ---------------------------------------------------------------------------

function detectImageFormat(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

async function loadImageInputs(rawImages, cwd) {
  const inputs = [];
  for (const [index, raw] of rawImages.entries()) {
    if (/^https?:\/\//i.test(raw)) {
      inputs.push({
        position: index + 1,
        kind: "remote",
        reference: raw,
        format: null,
        bytes: null,
        digest: null,
        dataUrl: null,
      });
      continue;
    }

    const absolute = isAbsolute(raw) ? raw : resolvePath(cwd, raw);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new CliError("image_read_error", `Input image ${index + 1} does not exist: ${raw}`);
    }
    if (!info.isFile()) {
      throw new CliError("image_read_error", `Input image ${index + 1} is not a regular file: ${raw}`);
    }
    let buffer;
    try {
      buffer = await readFile(absolute);
    } catch {
      throw new CliError("image_read_error", `Input image ${index + 1} could not be read: ${raw}`);
    }
    const format = detectImageFormat(buffer);
    if (format === null) {
      throw new CliError(
        "image_read_error",
        `Input image ${index + 1} is not a PNG, JPEG or WebP file: ${raw}`,
      );
    }
    inputs.push({
      position: index + 1,
      kind: "local",
      reference: absolute,
      format,
      bytes: buffer.byteLength,
      digest: `sha256:${sha256Hex(buffer)}`,
      dataUrl: `data:${IMAGE_FORMATS[format].mime};base64,${buffer.toString("base64")}`,
    });
  }
  return inputs;
}

function summariseImages(inputs) {
  return inputs.map((input) => ({
    position: input.position,
    kind: input.kind,
    reference: input.reference,
    format: input.format,
    bytes: input.bytes,
    digest: input.digest,
  }));
}

// ---------------------------------------------------------------------------
// Output plan
// ---------------------------------------------------------------------------

export function sanitizeLabel(raw) {
  if (raw === null || raw === undefined) {
    return "image";
  }
  const cleaned = [...String(raw)]
    .map((char) => {
      if (/[\p{Cc}\p{Cf}/\\:*?"<>|]/u.test(char)) {
        return "-";
      }
      if (/\s/u.test(char)) {
        return "-";
      }
      return char;
    })
    .join("")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const trimmed = [...cleaned].slice(0, 40).join("");
  return trimmed === "" ? "image" : trimmed;
}

function extensionFormat(extension) {
  for (const [format, meta] of Object.entries(IMAGE_FORMATS)) {
    if (meta.extensions.includes(extension)) {
      return format;
    }
  }
  return null;
}

/** Walks up to the nearest existing ancestor: a missing directory is created at write time. */
async function assertWritableTarget(directory) {
  let candidate = directory;
  for (;;) {
    let info = null;
    try {
      info = await stat(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw new CliError("output_write_error", `${candidate} could not be inspected (${error.code}).`);
      }
    }
    if (info !== null) {
      if (!info.isDirectory()) {
        throw new CliError("output_write_error", `${candidate} is not a directory.`);
      }
      try {
        await access(candidate, fsConstants.W_OK);
      } catch {
        throw new CliError("output_write_error", `${candidate} is not writable.`);
      }
      return;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new CliError("output_write_error", `No existing ancestor directory was found for ${directory}.`);
    }
    candidate = parent;
  }
}

async function resolveOutputPlan({ request, configuration, cwd }) {
  if (request.output !== null) {
    const path = isAbsolute(request.output) ? request.output : resolvePath(cwd, request.output);
    const extension = extname(path).toLowerCase();
    if (extensionFormat(extension) === null) {
      throw new CliError(
        "output_format_mismatch",
        `The output file extension "${extension || "(none)"}" is not one of .png, .jpg, .jpeg or .webp.`,
      );
    }
    try {
      await access(path, fsConstants.F_OK);
      throw new CliError("output_exists", `The output file already exists: ${path}`);
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
    }
    await assertWritableTarget(dirname(path));
    return { plan: { kind: "file", path }, source: SOURCE_NAMES.argument };
  }

  let directory;
  let source;
  if (request.outputDir !== null) {
    directory = isAbsolute(request.outputDir) ? request.outputDir : resolvePath(cwd, request.outputDir);
    source = SOURCE_NAMES.argument;
  } else if (configuration.outputDir.value !== null) {
    const configured = configuration.outputDir.value;
    directory = isAbsolute(configured) ? configured : resolvePath(cwd, configured);
    source = configuration.outputDir.source;
  } else {
    directory = join(cwd, "codex-image", "output");
    source = SOURCE_NAMES.defaultValue;
  }
  await assertWritableTarget(directory);
  return {
    plan: {
      kind: "directory",
      directory,
      label: sanitizeLabel(request.label),
      collision_policy: "suffix",
    },
    source,
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function missingFieldNames(configuration) {
  const missing = [];
  if (configuration.baseUrl.value === null) missing.push(CONFIG_VARIABLES.baseUrl);
  if (configuration.apiKey.value === null) missing.push(CONFIG_VARIABLES.apiKey);
  if (configuration.model.value === null) missing.push(CONFIG_VARIABLES.model);
  return missing;
}

function missingFieldError(configuration) {
  if (configuration.baseUrl.value === null) {
    return new CliError(
      "config_missing_base_url",
      `No base URL was resolved. Set ${CONFIG_VARIABLES.baseUrl} or authorise a home configuration layer.`,
    );
  }
  if (configuration.apiKey.value === null) {
    return new CliError(
      "config_missing_api_key",
      `No API key was resolved. Set ${CONFIG_VARIABLES.apiKey}; other credential fields are never guessed or converted.`,
    );
  }
  return new CliError(
    "config_missing_model",
    `No top-level model was resolved. Set ${CONFIG_VARIABLES.model} or authorise a home configuration layer.`,
  );
}

/**
 * Decides the route from the layers this invocation is allowed to read. It never
 * consults an unauthorised layer and never picks the delegation route silently
 * while a home layer could still supply a key.
 */
async function decideRoute({ request, configuration, env }) {
  const hasBaseUrl = configuration.baseUrl.value !== null;
  const hasApiKey = configuration.apiKey.value !== null;
  const bothHomeLayersConsidered =
    configuration.homeAuthorised.useLocalKey && configuration.homeAuthorised.useCodexConfig;

  if (request.via === "http") {
    if (!hasBaseUrl || !hasApiKey || configuration.model.value === null) {
      throw missingFieldError(configuration);
    }
    return { route: "http", reason: "forced by --via http", detection: null };
  }

  if (request.via === "codex-cli") {
    const detection = await detectDelegatePrerequisites(env);
    if (!detection.available) {
      throw new CliError(detection.code, delegateErrorMessage(detection.code, detection), {
        delegate: detection,
      });
    }
    return { route: "codex-cli", reason: "forced by --via codex-cli", detection };
  }

  if (hasBaseUrl && hasApiKey && configuration.model.value !== null) {
    return { route: "http", reason: "a complete base URL and API key were resolved", detection: null };
  }

  if (!bothHomeLayersConsidered) {
    const detection = await detectDelegatePrerequisites(env);
    const missing = missingFieldNames(configuration);
    throw new CliError(
      "home_config_permission_required",
      `The authorised configuration layers do not provide ${missing.join(", ")}. ` +
        "Re-run with --use-codex-config (read the current Codex configuration) or --use-local-key " +
        "(read ~/.config/codex-image/.env) to use the HTTP route, or with --via codex-cli to delegate " +
        "to the local Codex CLI.",
      {
        missing_fields: missing,
        home_options: [
          { flag: "--use-codex-config", reads: "the current Codex configuration" },
          { flag: "--use-local-key", reads: "~/.config/codex-image/.env" },
        ],
        delegate: {
          available: detection.available,
          code: detection.code,
          version: detection.version,
          login: detection.login,
        },
      },
    );
  }

  if (!hasApiKey) {
    const detection = await detectDelegatePrerequisites(env);
    if (detection.available) {
      return {
        route: "codex-cli",
        reason: "no API key was resolved and the local Codex CLI is an account login",
        detection,
      };
    }
    // Neither route is possible. The actionable root cause is the missing key; the
    // delegate state travels alongside it so the caller can still report the machine.
    const error = missingFieldError(configuration);
    error.details = { delegate: detection };
    throw error;
  }

  throw missingFieldError(configuration);
}

/**
 * Resolves configuration, route, inputs and output target. Both the offline
 * --preflight dry-run and a real execution go through here, so what the
 * dry-run reports is exactly what an execution would do.
 */
async function buildPlan({ request, cwd, env }) {
  const configuration = await resolveConfiguration({
    cwd,
    env,
    useLocalKey: request.useLocalKey,
    useCodexConfig: request.useCodexConfig,
  });

  const routing = await decideRoute({ request, configuration, env });
  const images = await loadImageInputs(request.images, cwd);

  if (routing.route === "codex-cli" && images.some((image) => image.kind === "remote")) {
    throw new CliError(
      "codex_delegate_unsupported_input",
      "The delegation route only accepts local image files; remote HTTP(S) image URLs are not supported.",
    );
  }

  const { plan: outputPlan, source: outputSource } = await resolveOutputPlan({
    request,
    configuration,
    cwd,
  });

  let endpoint = null;
  let keyDigest = null;
  if (routing.route === "http") {
    endpoint = normalizeEndpoint(configuration.baseUrl.value, configuration.apiKey.source);
    keyDigest = sha256Hex(configuration.apiKey.value);
  }

  return {
    configuration,
    routing,
    images,
    outputPlan,
    outputSource,
    endpoint,
    keyDigest,
  };
}

function buildSummary({ request, plan }) {
  const { configuration, routing, images, outputPlan, outputSource, endpoint, keyDigest } = plan;
  const summary = {
    ok: true,
    preflight: true,
    route: routing.route,
    route_reason: routing.reason,
    mode: request.mode,
    prompt: request.prompt,
    images: summariseImages(images),
    requested_size: request.size,
    output_plan:
      outputPlan.kind === "file"
        ? { kind: "file", path: outputPlan.path, source: outputSource }
        : { ...outputPlan, source: outputSource },
    max_attempts: routing.route === "http" ? HTTP_MAX_ATTEMPTS : DELEGATE_MAX_CALLS,
  };

  if (routing.route === "http") {
    summary.endpoint = endpoint;
    summary.base_url_source = configuration.baseUrl.source;
    summary.api_key_source = configuration.apiKey.source;
    summary.api_key_fingerprint = `sha256:${keyDigest.slice(0, 12)}`;
    summary.mixed_config_sources = configuration.baseUrl.source !== configuration.apiKey.source;
    summary.requested_model = configuration.model.value;
    summary.model_source = configuration.model.source;
  } else {
    summary.codex_version = routing.detection.version;
    summary.delegate_login = routing.detection.login;
    summary.requested_model = null;
    summary.model_source = null;
  }
  return summary;
}

async function runPreflight({ request, cwd, env }) {
  const plan = await buildPlan({ request, cwd, env });
  return buildSummary({ request, plan });
}

async function runExecute({ request, cwd, env, io }) {
  const plan = await buildPlan({ request, cwd, env });
  const outcome =
    plan.routing.route === "http"
      ? await executeHttpRequest({ request, plan, io })
      : await executeDelegatedRequest({ request, plan, env });
  return buildExecutionResult({ request, plan, outcome });
}

function buildExecutionResult({ request, plan, outcome }) {
  const { configuration } = plan;
  const { written, metadata, attempts } = outcome;
  const delegated = plan.routing.route === "codex-cli";
  return {
    ok: true,
    mode: request.mode,
    route: plan.routing.route,
    path: written.path,
    requested_model: delegated ? null : configuration.model.value,
    response_model: metadata.responseModel,
    image_model: metadata.imageModel,
    revised_prompt: metadata.revisedPrompt,
    requested_size: request.size,
    tool_settings: metadata.toolSettings,
    request_id: metadata.requestId,
    attempts,
    image: {
      format: written.format,
      mime: written.mime,
      width: written.width,
      height: written.height,
      bytes: written.bytes,
    },
    config_sources: delegated
      ? { route: "codex-cli", codex_version: outcome.codexVersion, output_dir: plan.outputSource }
      : {
          base_url: configuration.baseUrl.source,
          api_key: configuration.apiKey.source,
          model: configuration.model.source,
          output_dir: plan.outputSource,
        },
  };
}

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

function readPngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

function readWebpSize(buffer) {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8 " && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && buffer.length >= 30) {
    const width = buffer.readUIntLE(24, 3) + 1;
    const height = buffer.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  return null;
}

export function inspectImageBuffer(buffer) {
  const format = detectImageFormat(buffer);
  if (format === null) {
    return null;
  }
  const size =
    format === "png"
      ? readPngSize(buffer)
      : format === "jpeg"
        ? readJpegSize(buffer)
        : readWebpSize(buffer);
  if (size === null || !(size.width > 0) || !(size.height > 0)) {
    return null;
  }
  return { format, mime: IMAGE_FORMATS[format].mime, ...size, bytes: buffer.byteLength };
}

// ---------------------------------------------------------------------------
// Provider request and response
// ---------------------------------------------------------------------------

export function buildRequestBody({ mode, prompt, model, images, size }) {
  const action = mode === "edit" ? "edit" : "generate";
  const tool = { type: "image_generation", action };
  if (size !== null && size !== undefined) {
    tool.size = size;
  }
  const body = { model, tools: [tool], tool_choice: "auto", stream: true };

  if (images.length === 0) {
    body.input = prompt;
    return body;
  }
  body.input = [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...images.map((image) => ({
          type: "input_image",
          image_url: image.kind === "remote" ? image.reference : image.dataUrl,
        })),
      ],
    },
  ];
  return body;
}

function pickImageItem(candidate) {
  if (candidate?.type !== "image_generation_call") {
    return null;
  }
  const { result } = candidate;
  return typeof result === "string" && result !== "" ? candidate : null;
}

function collectMetadata(event, metadata) {
  const response = event?.response;
  if (response && typeof response === "object") {
    if (typeof response.model === "string") {
      metadata.responseModel = response.model;
    }
    if (typeof response.id === "string") {
      metadata.requestId = metadata.requestId ?? response.id;
    }
  }
}

function metadataFromImageItem(item, metadata) {
  for (const field of ["model", "image_model"]) {
    if (typeof item[field] === "string" && item[field] !== "") {
      metadata.imageModel = item[field];
      break;
    }
  }
  if (typeof item.revised_prompt === "string") {
    metadata.revisedPrompt = item.revised_prompt;
  }
  if (item.settings !== null && typeof item.settings === "object" && !Array.isArray(item.settings)) {
    metadata.toolSettings = item.settings;
    if (metadata.imageModel === null && typeof item.settings.model === "string") {
      metadata.imageModel = item.settings.model;
    }
  }
}

/**
 * Reads the stream incrementally and stops at the first complete image, so a
 * provider that keeps the stream open afterwards cannot stall the command.
 */
export async function readImageFromStream(body, metadata) {
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  let dataLines = [];
  let sawExplicitCompletion = false;
  let failure = null;

  const handleEvent = (payload) => {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return null;
    }
    collectMetadata(event, metadata);

    if (event?.type === "response.failed") {
      failure = event.response?.error ?? { message: "The provider ended the response as failed." };
      return null;
    }

    const direct = pickImageItem(event?.item);
    if (direct !== null) {
      metadataFromImageItem(direct, metadata);
      return direct.result;
    }

    const output = event?.response?.output;
    if (Array.isArray(output)) {
      for (const candidate of output) {
        const image = pickImageItem(candidate);
        if (image !== null) {
          metadataFromImageItem(image, metadata);
          return image.result;
        }
      }
      if (event?.type === "response.completed" && output.length > 0) {
        sawExplicitCompletion = true;
      }
    }
    return null;
  };

  const flushLine = (line) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") {
      if (dataLines.length === 0) {
        return null;
      }
      const payload = dataLines.join("\n");
      dataLines = [];
      return payload === "[DONE]" ? null : handleEvent(payload);
    }
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
    return null;
  };

  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newlineAt = buffered.indexOf("\n");
    while (newlineAt !== -1) {
      const line = buffered.slice(0, newlineAt);
      buffered = buffered.slice(newlineAt + 1);
      const image = flushLine(line);
      if (image !== null) {
        return { image, failure: null, sawExplicitCompletion };
      }
      if (failure !== null) {
        return { image: null, failure, sawExplicitCompletion };
      }
      newlineAt = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  for (const line of buffered.split("\n")) {
    const image = flushLine(line);
    if (image !== null) {
      return { image, failure: null, sawExplicitCompletion };
    }
  }
  const tail = flushLine("");
  if (tail !== null) {
    return { image: tail, failure: null, sawExplicitCompletion };
  }
  return { image: null, failure, sawExplicitCompletion };
}

function sanitizeProviderError(payload) {
  const error = payload?.error ?? payload;
  const pick = (value) => (typeof value === "string" && value.length <= 500 ? value : null);
  return {
    code: pick(error?.code) ?? pick(error?.type),
    message: pick(error?.message),
    requestId: pick(payload?.request_id) ?? pick(error?.request_id),
  };
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function parseRetryAfter(header) {
  if (typeof header !== "string" || header.trim() === "") {
    return null;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : null;
}

// ---------------------------------------------------------------------------
// Output writing
// ---------------------------------------------------------------------------

function timestampFor(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOutputPath(outputPlan, format) {
  if (outputPlan.kind === "file") {
    const extension = extname(outputPlan.path).toLowerCase();
    if (extensionFormat(extension) !== format) {
      throw new CliError(
        "output_format_mismatch",
        `The provider returned ${format}, which does not match the requested output extension "${extension}".`,
      );
    }
    if (await pathExists(outputPlan.path)) {
      throw new CliError("output_exists", `The output file already exists: ${outputPlan.path}`);
    }
    return outputPlan.path;
  }

  const extension = IMAGE_FORMATS[format].extensions[0];
  const stem = `${timestampFor(new Date())}-${outputPlan.label}`;
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const name = suffix === 1 ? `${stem}${extension}` : `${stem}-${suffix}${extension}`;
    const candidate = join(outputPlan.directory, name);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new CliError("output_write_error", "No free output filename was found.");
}

/** Validates the bytes first, then swaps a fully written temporary file into place. */
async function writeImageOutput(buffer, outputPlan) {
  const inspection = inspectImageBuffer(buffer);
  if (inspection === null) {
    throw new CliError(
      "invalid_image_result",
      "The provider returned data that is not a supported PNG, JPEG or WebP image.",
    );
  }

  const directory = outputPlan.kind === "file" ? dirname(outputPlan.path) : outputPlan.directory;
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new CliError("output_write_error", `The output directory could not be created (${error.code}).`);
  }

  const finalPath = await resolveOutputPath(outputPlan, inspection.format);
  const temporaryPath = join(directory, `.codex-image-${randomBytes(8).toString("hex")}.part`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
  } catch (error) {
    throw new CliError("output_write_error", `The image could not be written (${error.code ?? "unknown"}).`);
  } finally {
    await handle?.close();
  }

  try {
    if (await pathExists(finalPath)) {
      throw new CliError("output_exists", `The output file appeared while it was being written: ${finalPath}`);
    }
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("output_write_error", `The image could not be moved into place (${error.code}).`);
  }

  return { path: finalPath, ...inspection };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function attemptDelay(attempt) {
  return [1000, 2000, 4000][attempt - 1] ?? 4000;
}

async function performHttpAttempt({ endpoint, apiKey, body, metadata }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = Date.now() - startedAt >= REQUEST_TIMEOUT_MS || controller.signal.aborted;
      return {
        outcome: "failed",
        startedAt,
        error: new CliError(
          "network_error",
          timedOut
            ? "The request timed out before the provider responded."
            : "The connection to the provider failed before any response headers arrived.",
        ),
        retryable: !timedOut,
      };
    }

    metadata.requestId =
      metadata.requestId ??
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      null;
    if (typeof response.headers.get("openai-model") === "string") {
      metadata.responseModel = metadata.responseModel ?? response.headers.get("openai-model");
    }

    if (!response.ok) {
      let payload = null;
      try {
        const text = (await response.text()).slice(0, 64 * 1024);
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      const details = payload === null ? { code: null, message: null, requestId: null } : sanitizeProviderError(payload);
      metadata.requestId = metadata.requestId ?? details.requestId ?? null;
      const isAuth = response.status === 401 || response.status === 403;
      const description = [
        `The provider rejected the request with HTTP ${response.status}`,
        details.code === null ? null : `code ${details.code}`,
        details.message,
      ]
        .filter(Boolean)
        .join(" — ");
      return {
        outcome: "failed",
        startedAt,
        error: new CliError(isAuth ? "auth_error" : "provider_error", `${description}.`),
        retryable: RETRYABLE_STATUSES.has(response.status),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }

    if (response.body === null) {
      return {
        outcome: "failed",
        startedAt,
        error: new CliError("image_not_returned", "The provider returned an empty response stream."),
        retryable: true,
      };
    }

    let stream;
    try {
      stream = await readImageFromStream(response.body, metadata);
    } catch {
      return {
        outcome: "failed",
        startedAt,
        error: new CliError("network_error", "The response stream ended before an image arrived."),
        retryable: true,
      };
    }

    if (stream.image !== null) {
      return { outcome: "image", startedAt, image: stream.image };
    }
    if (stream.failure !== null) {
      const details = sanitizeProviderError({ error: stream.failure });
      metadata.requestId = metadata.requestId ?? details.requestId ?? null;
      return {
        outcome: "failed",
        startedAt,
        error: new CliError(
          "provider_error",
          `The provider ended the response as failed${details.code === null ? "" : ` (code ${details.code})`}${
            details.message === null ? "" : `: ${details.message}`
          }.`,
        ),
        retryable: false,
      };
    }
    return {
      outcome: "failed",
      startedAt,
      error: new CliError(
        "image_not_returned",
        stream.sawExplicitCompletion
          ? "The model completed the response without calling the image tool."
          : "The response stream ended without an image and without a completion result.",
      ),
      retryable: !stream.sawExplicitCompletion,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeHttpRequest({ request, plan, io }) {
  const { configuration, images, outputPlan, endpoint } = plan;
  const body = buildRequestBody({
    mode: request.mode,
    prompt: request.prompt,
    model: configuration.model.value,
    images,
    size: request.size,
  });
  const metadata = {
    responseModel: null,
    imageModel: null,
    revisedPrompt: null,
    toolSettings: null,
    requestId: null,
  };

  let attempts = 0;
  let lastError = null;

  /** Anything that fails once a POST has begun must be reported as such. */
  const annotate = (error) => {
    if (error instanceof CliError) {
      error.networkStarted = attempts > 0;
      error.attempts = attempts;
      error.requestId = metadata.requestId;
    }
    return error;
  };

  try {
  for (let attempt = 1; attempt <= HTTP_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;

    const result = await performHttpAttempt({
      endpoint,
      apiKey: configuration.apiKey.value,
      body,
      metadata,
    });

    if (result.outcome === "image") {
      let buffer;
      try {
        buffer = Buffer.from(result.image, "base64");
      } catch {
        buffer = Buffer.alloc(0);
      }
      if (buffer.byteLength === 0) {
        lastError = new CliError("invalid_image_result", "The provider returned an unusable image payload.");
        break;
      }
      const written = await writeImageOutput(buffer, outputPlan);
      return { written, metadata, attempts };
    }

    lastError = result.error;
    const elapsed = Date.now() - result.startedAt;
    const withinFastFailure = elapsed <= FAST_FAILURE_MS;
    let retryable = result.retryable === true && withinFastFailure && attempt < HTTP_MAX_ATTEMPTS;

    let wait = attemptDelay(attempt);
    if (retryable && result.retryAfterMs !== null && result.retryAfterMs !== undefined) {
      if (result.retryAfterMs > FAST_FAILURE_MS) {
        retryable = false;
      } else {
        wait = result.retryAfterMs;
      }
    }
    if (!retryable) {
      break;
    }
    io.stderr(`codex-image: attempt ${attempt} failed (${lastError.code}); retrying in ${wait}ms\n`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  } catch (error) {
    throw annotate(error);
  }

  throw annotate(lastError);
}

// ---------------------------------------------------------------------------
// Delegated execution
// ---------------------------------------------------------------------------

const DELEGATE_TIMEOUT_MS = 600_000;
const DELEGATE_FILE_STEM = "generated";

const DELEGATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    image_path: { type: "string" },
    image_model: { type: "string" },
    notes: { type: "string" },
  },
  required: ["image_path"],
  additionalProperties: false,
};

function delegatePrompt({ mode, prompt, workDirectory, imageCount }) {
  const roleNote =
    mode === "generate"
      ? ""
      : mode === "edit"
        ? `\n${imageCount} image(s) are attached in the order referenced by the request. Edit the target image as described and keep everything the request says must stay unchanged.\n`
        : `\n${imageCount} image(s) are attached in the order referenced by the request. Use them only as the references the request describes; do not copy their composition.\n`;

  return [
    "Produce exactly one image with your native image generation tool and save it to disk.",
    "",
    `Write the file into this directory: ${workDirectory}`,
    `Name it "${DELEGATE_FILE_STEM}" followed by the extension matching the format you produce (.png, .jpg or .webp).`,
    "Write no other file, and change nothing outside that directory.",
    "Do not ask clarifying questions; follow the request as literally as you can.",
    roleNote,
    "Image request:",
    prompt,
    "",
    "Your final message must be JSON matching the provided schema and must report the absolute path of the file you wrote.",
  ].join("\n");
}

function delegateEnvironment(env) {
  const allowed = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER"];
  const forwarded = {};
  for (const name of allowed) {
    if (typeof env[name] === "string") {
      forwarded[name] = env[name];
    }
  }
  return forwarded;
}

function looksLikeAuthFailure(text) {
  return /not logged in|unauthor|authentication|401|token (has )?expired|please (re)?login/i.test(text);
}

async function executeDelegatedRequest({ request, plan, env }) {
  const { images, outputPlan, routing } = plan;
  if (images.some((image) => image.kind === "remote")) {
    throw new CliError(
      "codex_delegate_unsupported_input",
      "The delegation route only accepts local image files; remote HTTP(S) image URLs are not supported.",
    );
  }

  const baseDirectory = outputPlan.kind === "file" ? dirname(outputPlan.path) : outputPlan.directory;
  const workDirectory = join(baseDirectory, `.codex-image-delegate-${randomBytes(6).toString("hex")}`);
  const schemaPath = join(workDirectory, "output-schema.json");
  const lastMessagePath = join(workDirectory, "final-message.json");

  try {
    await mkdir(workDirectory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(schemaPath, `${JSON.stringify(DELEGATE_OUTPUT_SCHEMA, null, 2)}\n`);
  } catch (error) {
    throw new CliError(
      "output_write_error",
      `The delegation working directory could not be prepared (${error.code ?? "unknown"}).`,
    );
  }

  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-C",
    workDirectory,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
  ];
  for (const image of images) {
    args.push("-i", image.reference);
  }
  args.push(
    delegatePrompt({
      mode: request.mode,
      prompt: request.prompt,
      workDirectory,
      imageCount: images.length,
    }),
  );

  let stdout = "";
  let stderr = "";
  let failed = null;
  try {
    const result = await execFileAsync("codex", args, {
      cwd: workDirectory,
      env: delegateEnvironment(env),
      timeout: DELEGATE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    failed = error;
  }

  const combined = `${stdout}\n${stderr}`;
  if (failed !== null) {
    if (looksLikeAuthFailure(combined)) {
      throw delegateFailure(
        "codex_auth_error",
        "The delegated Codex session reported an authentication failure.",
      );
    }
    throw delegateFailure(
      "codex_delegate_failed",
      failed.killed === true
        ? `The delegated Codex session did not finish within ${DELEGATE_TIMEOUT_MS / 1000} seconds.`
        : "The delegated Codex session failed.",
    );
  }
  if (looksLikeAuthFailure(combined)) {
    throw delegateFailure(
      "codex_auth_error",
      "The delegated Codex session reported an authentication failure.",
    );
  }

  let structured = null;
  try {
    structured = JSON.parse(await readFile(lastMessagePath, "utf8"));
  } catch {
    structured = null;
  }
  const reportedPath = typeof structured?.image_path === "string" ? structured.image_path : null;
  if (reportedPath === null) {
    throw delegateFailure(
      "codex_delegate_failed",
      "The delegated Codex session did not report the image file it produced.",
    );
  }

  const producedPath = isAbsolute(reportedPath) ? reportedPath : resolvePath(workDirectory, reportedPath);
  let produced;
  try {
    produced = await readFile(producedPath);
  } catch {
    throw delegateFailure(
      "codex_delegate_failed",
      `The file the delegated session reported does not exist: ${producedPath}`,
    );
  }

  const inspection = inspectImageBuffer(produced);
  if (inspection === null) {
    // Kept on disk on purpose: the artefact is the evidence for diagnosing the delegate.
    throw delegateFailure(
      "invalid_image_result",
      `The delegated session produced a file that is not a supported image; it was left at ${producedPath} for diagnosis.`,
    );
  }

  const written = await writeImageOutput(produced, outputPlan);
  await rm(workDirectory, { recursive: true, force: true }).catch(() => {});

  return {
    written,
    metadata: {
      responseModel: null,
      imageModel: typeof structured?.image_model === "string" ? structured.image_model : null,
      revisedPrompt: null,
      toolSettings: null,
      requestId: null,
    },
    attempts: 1,
    codexVersion: routing.detection.version,
  };
}

function delegateFailure(code, message) {
  const error = new CliError(code, message);
  error.networkStarted = true;
  error.attempts = 1;
  return error;
}

async function writeFileAtomic(path, contents) {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

export function failureResult(code, message, options = {}) {
  const { networkStarted = false, attempts = 0, requestId = null, details = null } = options;
  const error = { code, message };
  if (requestId !== null) {
    error.request_id = requestId;
  }
  const result = { ok: false, network_started: networkStarted, attempts, error };
  if (details !== null) {
    result.guidance = details;
  }
  return result;
}

export function exitCodeFor(result) {
  if (result.ok) {
    return 0;
  }
  return result.network_started ? 1 : 2;
}

function renderPreflightText(summary) {
  const lines = [
    `Preflight OK — route: ${summary.route} (${summary.route_reason})`,
    `  mode        : ${summary.mode}`,
  ];
  if (summary.route === "http") {
    lines.push(`  endpoint    : ${summary.endpoint}`);
    lines.push(`  base URL    : from ${summary.base_url_source}`);
    lines.push(`  API key     : from ${summary.api_key_source} (${summary.api_key_fingerprint})`);
    if (summary.mixed_config_sources) {
      lines.push("  note        : the base URL and the API key come from different configuration layers");
    }
    lines.push(`  model       : ${summary.requested_model} (from ${summary.model_source})`);
  } else {
    lines.push(`  codex       : version ${summary.codex_version}, ${summary.delegate_login} login`);
  }
  for (const image of summary.images) {
    lines.push(`  image ${image.position}     : ${image.kind} ${image.reference}`);
  }
  lines.push(`  size        : ${summary.requested_size ?? "not requested"}`);
  lines.push(
    summary.output_plan.kind === "file"
      ? `  output      : ${summary.output_plan.path}`
      : `  output      : ${summary.output_plan.directory} (label ${summary.output_plan.label})`,
  );
  lines.push(`  max requests: ${summary.max_attempts}`);
  return lines.join("\n");
}

function renderExecutionText(result) {
  const unreported = (value) => value ?? "not returned by the provider";
  return [
    `Image written to ${result.path}`,
    `  format      : ${result.image.format} ${result.image.width}x${result.image.height} (${result.image.bytes} bytes)`,
    `  requested   : model ${result.requested_model}, size ${result.requested_size ?? "not requested"}`,
    `  response    : model ${unreported(result.response_model)}, image model ${unreported(result.image_model)}`,
    `  request id  : ${unreported(result.request_id)}`,
    `  attempts    : ${result.attempts}`,
    `  revised     : ${unreported(result.revised_prompt)}`,
  ].join("\n");
}

const HELP_TEXT = `codex-image — generate, reference and edit images without a native image tool.

Run a request (validates everything, then sends it):
  generate-image.mjs --prompt <text> [--image <path-or-url>]... [--mode generate|reference|edit]
                     [--size <provider-size>] [--label <safe-label>]
                     [--output <file> | --output-dir <directory>]
                     [--use-local-key] [--use-codex-config] [--via http|codex-cli]
                     [--json]

Dry-run the same request offline (never reaches the network):
  generate-image.mjs --prompt <text> [same options] --preflight [--json]

Options:
  --prompt <text>          Final prompt. Required.
  --image <path-or-url>    Input image; repeat to pass several, order is preserved.
  --mode <mode>            generate (no images), reference or edit. Never inferred from the prompt.
  --size <provider-size>   Requested size. The provider may normalise it.
  --label <safe-label>     Filename label for generated output. Defaults to "image".
  --output <file>          Explicit output file. Fails if it already exists.
  --output-dir <directory> Output directory. Mutually exclusive with --output.
  --use-local-key          Allow this process to read ~/.config/codex-image/.env.
  --use-codex-config       Allow this process to read the current Codex configuration.
  --via <route>            Force http or codex-cli instead of routing automatically.
  --preflight              Validate and report the plan, but stay offline.
  --json                   Emit exactly one JSON result on stdout; diagnostics go to stderr.
  -h, --help               Show this help.

Configuration is read per field from, in order: process environment,
$PWD/.env.local, $PWD/.env, then ~/.config/codex-image/.env (needs --use-local-key)
and the current Codex configuration (needs --use-codex-config).
Recognised variables: CODEX_IMAGE_BASE_URL, CODEX_IMAGE_API_KEY, CODEX_IMAGE_MODEL,
CODEX_IMAGE_OUTPUT_DIR. An API key is never accepted as a command-line argument.
`;

const defaultIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function emitFailure(result, { json, io }) {
  if (json) {
    io.stdout(`${JSON.stringify(result)}\n`);
  } else {
    io.stderr(`codex-image: ${result.error.code}: ${result.error.message}\n`);
  }
  return exitCodeFor(result);
}

export async function run(argv, io = defaultIo, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;

  let resolved;
  try {
    resolved = resolveCommand(argv);
  } catch (error) {
    if (error instanceof CliError) {
      const wantsJson = argv.includes("--json");
      return emitFailure(
        failureResult(error.code, error.message, { details: error.details }),
        { json: wantsJson, io },
      );
    }
    throw error;
  }

  const { command, json } = resolved;

  if (command === "help") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  try {
    if (command === "preflight") {
      const summary = await runPreflight({ request: resolved.request, cwd, env });
      io.stdout(json ? `${JSON.stringify(summary)}\n` : `${renderPreflightText(summary)}\n`);
      return 0;
    }
    if (command === "execute") {
      const result = await runExecute({ request: resolved.request, cwd, env, io });
      io.stdout(json ? `${JSON.stringify(result)}\n` : `${renderExecutionText(result)}\n`);
      return 0;
    }
  } catch (error) {
    if (error instanceof CliError) {
      return emitFailure(
        failureResult(error.code, error.message, {
          details: error.details,
          networkStarted: error.networkStarted === true,
          attempts: error.attempts ?? 0,
          requestId: error.requestId ?? null,
        }),
        { json, io },
      );
    }
    throw error;
  }

  return emitFailure(
    failureResult("not_implemented", `Command "${command}" is not implemented yet in this build.`),
    { json, io },
  );
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await run(process.argv.slice(2));
}
