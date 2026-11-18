/**
 * Python runtime bootstrap for the GPTFree plugin.
 *
 * A desktop install of magpie has a system Python 3, and that is still what
 * gets used first. The Docker image (`ghcr.io/yetone/magpie`) has none: it is
 * a static Go binary plus curl, and plugins run on the Bun magpie downloads.
 * Without this module the workers could not start there at all.
 *
 * So when no interpreter is found, the plugin brings its own: the uv release
 * binary, the CPython uv manages, and curl_cffi inside an isolated venv. All
 * of it lives under MAGPIE_GPTFREE_HOME (by default ~/.magpie-gptfree, on a
 * Docker install a folder on the /config volume), so a restart or a new image
 * keeps it. Nothing else on the machine is touched and no system package
 * manager is involved.
 *
 * Mirrors, for networks that cannot reach GitHub or PyPI directly:
 *   MAGPIE_GPTFREE_UV_MIRROR     base URL of the uv release downloads
 *   MAGPIE_GPTFREE_PYTHON_MIRROR base URL of uv's CPython builds
 *   MAGPIE_GPTFREE_PIP_INDEX     index URL for curl_cffi
 *   MAGPIE_GPTFREE_UV            path to a uv binary already on the machine
 *   MAGPIE_GPTFREE_PYTHON        path to a Python 3 interpreter to prefer
 */
import { spawn } from "node:child_process";
import { mkdir, access, chmod, rename, rm, readdir, writeFile } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { join, dirname } from "node:path";

const DEFAULT_UV_BASE = "https://github.com/astral-sh/uv/releases/latest/download";
// 3.12 on purpose: curl_cffi ships manylinux wheels for it on every platform
// uv builds, so the install is a download and never a compile.
const PYTHON_SERIES = "3.12";
const DOWNLOAD_TIMEOUT = 600000;
const UV_INSTALL_TIMEOUT = 900000;

const UV_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-arm": "armv7-unknown-linux-gnueabihf",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Spawn a command and resolve with its stdout. On failure the error carries
 * `stdout`/`stderr` so a bootstrap failure can say what actually went wrong.
 */
export function run(command, args, { input = "", timeout = 120000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, signal,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", ...(env || {}) },
      });
    } catch (error) {
      reject(Object.assign(new Error(`${command} could not start`), { stdout: "", stderr: "", cause: error }));
      return;
    }
    let stdout = "", stderr = "", ended = false;
    const timer = setTimeout(() => child.kill(), timeout);
    timer.unref?.();
    function finish(error) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    }
    child.once("error", (error) => finish(new Error(`${command} could not start: ${error?.message || error}`)));
    child.stdout.on("data", (part) => {
      stdout += String(part);
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (part) => {
      stderr += String(part);
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.once("close", (code) => {
      // stderr is kept on the error object, never in the message: worker
      // stderr can carry upstream text, and messages end up in the UI.
      if (code !== 0) finish(new Error(`${command} exited with ${code}`));
      else finish(null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function bootstrapPaths(env = process.env) {
  const root = env.MAGPIE_GPTFREE_HOME || join(homedir(), ".magpie-gptfree");
  const windows = platform() === "win32";
  const venv = join(root, "python-venv");
  return {
    root,
    venv,
    venvPython: windows ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"),
    uv: env.MAGPIE_GPTFREE_UV || join(root, "bin", windows ? "uv.exe" : "uv"),
    runtime: join(root, "python-runtime"),
    cache: join(root, "python-cache"),
    windows,
  };
}

/** Bootstrap failures are ours, so their stderr is safe to show. */
function describe(error) {
  const detail = String(error?.stderr || "").trim().split("\n").map((line) => line.trim())
    .filter(Boolean).slice(-2).join(" | ").slice(0, 300);
  const message = String(error?.message || error);
  return detail && !message.includes(detail) ? `${message}（${detail}）` : message;
}

async function findFile(dir, name, depth = 4) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return join(dir, entry.name);
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(dir, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

async function download(url, target, { signal } = {}) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT),
    });
  } catch (error) {
    throw new Error(`下载 ${url} 失败：${error?.message || error}`);
  }
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error(`下载 ${url} 失败：内容过小（${bytes.length} 字节）`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600 });
  return bytes.length;
}

/** uv's own environment: everything it downloads stays inside our folder. */
function uvEnv(paths, env) {
  return {
    UV_PYTHON_INSTALL_DIR: paths.runtime,
    UV_CACHE_DIR: paths.cache,
    UV_PYTHON_PREFERENCE: "only-managed",
    ...(env.MAGPIE_GPTFREE_PYTHON_MIRROR ? { UV_PYTHON_INSTALL_MIRROR: env.MAGPIE_GPTFREE_PYTHON_MIRROR } : {}),
  };
}

async function usableUv(candidate) {
  if (!candidate || !(await exists(candidate))) return false;
  try { await run(candidate, ["--version"], { timeout: 30000 }); return true; } catch { return false; }
}

async function ensureUv(paths, env) {
  if (await usableUv(env.MAGPIE_GPTFREE_UV)) return env.MAGPIE_GPTFREE_UV;
  if (await usableUv(paths.uv)) return paths.uv;

  const triple = UV_TRIPLES[`${platform()}-${arch()}`];
  if (!triple) {
    throw new Error(`这个平台没有可自动安装的 Python 运行时（${platform()}-${arch()}）。请自行安装 Python 3 并设置 MAGPIE_GPTFREE_PYTHON`);
  }
  const base = (env.MAGPIE_GPTFREE_UV_MIRROR || DEFAULT_UV_BASE).replace(/\/+$/, "");
  const archive = join(paths.root, "bin", `uv-${triple}.tar.gz`);
  await download(`${base}/uv-${triple}.tar.gz`, archive);

  const unpack = join(paths.root, "bin", "uv-unpack");
  await rm(unpack, { recursive: true, force: true });
  await mkdir(unpack, { recursive: true, mode: 0o700 });
  await run("tar", ["xf", archive, "-C", unpack], { timeout: 120000 });
  const found = await findFile(unpack, paths.windows ? "uv.exe" : "uv");
  if (!found) throw new Error("uv 压缩包里没有找到可执行文件");
  await mkdir(dirname(paths.uv), { recursive: true, mode: 0o700 });
  await rm(paths.uv, { force: true });
  await rename(found, paths.uv);
  await chmod(paths.uv, 0o755).catch(() => {});
  await rm(unpack, { recursive: true, force: true }).catch(() => {});
  await rm(archive, { force: true }).catch(() => {});
  await run(paths.uv, ["--version"], { timeout: 30000 });
  return paths.uv;
}

async function locatePython(env) {
  if (env.MAGPIE_GPTFREE_PYTHON) {
    const python = env.MAGPIE_GPTFREE_PYTHON;
    try {
      const out = await run(python, ["-c", "import sys;print(sys.version_info.major)"], { timeout: 20000 });
      if (out.trim() === "3") return { python, prefix: [] };
    } catch {}
    return null;
  }
  const candidates = platform() === "win32"
    ? [{ python: "py", prefix: ["-3"] }, { python: "python", prefix: [] }]
    : [{ python: "python3", prefix: [] }, { python: "python", prefix: [] }];
  for (const candidate of candidates) {
    try {
      const out = await run(candidate.python, [...candidate.prefix, "-c", "import sys;print(sys.version_info.major)"], { timeout: 20000 });
      if (out.trim() === "3") return candidate;
    } catch {}
  }
  return null;
}

async function hasCurlCffi(python) {
  try {
    await run(python, ["-c", "import curl_cffi"], { timeout: 30000 });
    return true;
  } catch { return false; }
}

async function pipInstall(python, requirements, env, signal) {
  const indexArgs = env.MAGPIE_GPTFREE_PIP_INDEX ? ["--index-url", env.MAGPIE_GPTFREE_PIP_INDEX] : [];
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...indexArgs, "-r", requirements],
    { timeout: UV_INSTALL_TIMEOUT, signal });
}

/**
 * Resolve a Python interpreter that can import curl_cffi, preparing one if
 * needed. Returns the path to use for every worker process.
 */
export async function ensureWorkerPython({ requirements, signal, env = process.env } = {}) {
  const paths = bootstrapPaths(env);

  // Already prepared: the common case after the first run.
  if (await exists(paths.venvPython) && await hasCurlCffi(paths.venvPython)) return paths.venvPython;

  await mkdir(paths.root, { recursive: true, mode: 0o700 });

  // A system Python (desktop install) still gets first refusal.
  const base = await locatePython(env);
  if (base) {
    if (!(await exists(paths.venvPython))) {
      try {
        await run(base.python, [...base.prefix, "-m", "venv", paths.venv], { timeout: 180000, signal });
      } catch {}
    }
    if (await exists(paths.venvPython)) {
      try {
        await pipInstall(paths.venvPython, requirements, env, signal);
      } catch {}
      if (await hasCurlCffi(paths.venvPython)) return paths.venvPython;
    }
  }

  // No usable interpreter (the Docker image), or its venv could not be built:
  // bring uv and a CPython of our own.
  let uv;
  try {
    uv = await ensureUv(paths, env);
  } catch (error) {
    throw new Error(`未找到可用 Python 3，自动准备运行环境也失败了：${describe(error)}`);
  }
  const uvArgs = { timeout: UV_INSTALL_TIMEOUT, signal, env: uvEnv(paths, env) };

  if (!(await exists(paths.venvPython))) {
    try {
      await run(uv, ["venv", "--python", PYTHON_SERIES, paths.venv], uvArgs);
    } catch (error) {
      throw new Error(`创建 Python 虚拟环境失败：${describe(error)}`);
    }
  }
  const indexArgs = env.MAGPIE_GPTFREE_PIP_INDEX ? ["--index-url", env.MAGPIE_GPTFREE_PIP_INDEX] : [];
  try {
    await run(uv, ["pip", "install", "--python", paths.venvPython, ...indexArgs, "-r", requirements], uvArgs);
  } catch (error) {
    throw new Error(`安装 curl_cffi 失败：${describe(error)}`);
  }
  if (!(await hasCurlCffi(paths.venvPython))) throw new Error("Python 环境已安装，但 curl_cffi 仍无法导入");
  return paths.venvPython;
}
