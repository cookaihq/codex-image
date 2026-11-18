import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readlink, stat } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);
const MAX_ANCESTORS = 12;
const windows = process.platform === "win32";

function envValue(env, name) {
  if (!windows) return env[name];
  return env[Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())];
}

async function executableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function* pathCandidates(name, env, cwd) {
  const suffixes = windows ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const entry of (envValue(env, "PATH") ?? "").split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = resolve(cwd, directory, name + suffix);
      if (await executableFile(candidate)) yield candidate;
    }
  }
}

const WINDOWS_ANCESTORS = String.raw`
$ErrorActionPreference = 'Stop'
$cursor = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
for ($depth = -1; $depth -lt 12 -and $null -ne $cursor; $depth++) {
  if ($depth -ge 0) {
    $line = @{ path = $cursor.ExecutablePath; name = $cursor.Name; command = $cursor.CommandLine } | ConvertTo-Json -Compress
    [Console]::WriteLine($line)
  }
  if ($cursor.ParentProcessId -le 0) { break }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cursor.ParentProcessId)"
  if ($null -eq $parent -or $parent.CreationDate -gt $cursor.CreationDate) { break }
  $cursor = $parent
}
`;

async function* ancestors(env) {
  if (windows) {
    const systemRoot = envValue(env, "SystemRoot");
    if (!systemRoot || !isAbsolute(systemRoot)) return;
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await execFileAsync(powershell,
      ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + WINDOWS_ANCESTORS],
      { timeout: 4000, windowsHide: true, maxBuffer: 256 * 1024 });
    // The helper's parent is this Node process. The remaining rows are its ancestors.
    for (const line of stdout.trim().split(/\r?\n/).slice(1)) yield JSON.parse(line);
  } else if (process.platform === "linux") {
    let pid = process.ppid;
    for (let depth = 0; pid > 1 && depth < MAX_ANCESTORS; depth += 1) {
      const directory = "/proc/" + pid;
      const [file, status, command] = await Promise.all([
        readlink(directory + "/exe"), readFile(directory + "/status", "utf8"),
        readFile(directory + "/cmdline", "utf8"),
      ]);
      yield { path: file, name: basename(file), command };
      pid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    }
  } else if (process.platform === "darwin") {
    // macOS ps's comm column is the executable pathname. Relative/opaque names
    // do not establish identity and the resolver will fall back to PATH.
    let pid = process.ppid;
    for (let depth = 0; pid > 1 && depth < MAX_ANCESTORS; depth += 1) {
      const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "comm="], { timeout: 500 });
      const row = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
      if (!row) return;
      const file = row[2];
      yield { path: file, name: basename(file), command: "" };
      pid = Number(row[1]);
    }
  }
}

export async function currentCodexExecutable(env, getAncestors = ancestors) {
  if (!env.CODEX_THREAD_ID || env.CLAUDECODE === "1" || env.WORKBUDDY_SESSION_ID) return null;
  try {
    for await (const ancestor of getAncestors(env)) {
      const name = (ancestor.name ?? "").toLowerCase();
      const file = ancestor.path;
      if (!file || !isAbsolute(file)) break;
      if (name === (windows ? "codex.exe" : "codex")) {
        return basename(file).toLowerCase() === name && await executableFile(file) ? file : null;
      }
      // Only cross ordinary tool runners. An unrelated or opaque process may
      // be another Agent that inherited the environment of a parent Codex.
      if (!/^(node|pwsh|powershell|cmd|conhost|bash|sh|zsh|dash|fish|env|uv|uvx|python[0-9.]*)($|\.exe$)/.test(name)) break;
      if (/(?:^|[\s"'\x00/\\])(?:claude(?:-code)?|workbuddy|opencode|gemini|copilot)(?:[\s"'\x00/\\.]|$)/i.test(ancestor.command ?? "")) break;
    }
  } catch {
    // No reliable evidence (sandbox, platform or exited process).
  }
  return null;
}

async function launchCommand(file, env, cwd) {
  if (!await executableFile(file)) return null;
  if (!windows || /\.(?:exe|com)$/i.test(file)) return { file, prefix: [] };
  if (!/^(?:codex)\.(?:cmd|bat|ps1)$/i.test(basename(file))) return null;
  // Run the npm entry as an argv array. cmd.exe would interpret the prompt and
  // TOML values as shell input, and cmd/PowerShell quoting is not interchangeable.
  const launcher = join(dirname(file), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!await executableFile(launcher)) return null;
  const adjacentNode = join(dirname(file), "node.exe");
  if (await executableFile(adjacentNode)) return { file: adjacentNode, prefix: [launcher] };
  for await (const node of pathCandidates("node", env, cwd)) {
    if (extname(node).toLowerCase() === ".exe") return { file: node, prefix: [launcher] };
  }
  return { file: process.execPath, prefix: [launcher] };
}

export async function resolveCodexLaunch({ env, cwd, explicit, findCurrent = currentCodexExecutable }) {
  if (explicit?.value) {
    const command = await launchCommand(resolve(cwd, explicit.value), env, cwd);
    return command && { ...command, source: explicit.source };
  }
  const current = await findCurrent(env);
  if (current) {
    const command = await launchCommand(current, env, cwd);
    if (command) return { ...command, source: "current_codex_session" };
  }
  for await (const candidate of pathCandidates("codex", env, cwd)) {
    const command = await launchCommand(candidate, env, cwd);
    if (command) return { ...command, source: "PATH" };
  }
  return null;
}

export function runCodex(launch, args, options) {
  return execFileAsync(launch.file, [...launch.prefix, ...args], { ...options, windowsHide: true });
}
