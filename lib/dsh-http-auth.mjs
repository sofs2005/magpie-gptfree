/**
 * Standalone DSH-compatible HTTP password + TOTP authentication adapter.
 * No DSH service, no Playwright and no Codex CLI process.
 *
 * The Python worker was adapted from yang0/chatgpt2api-dsh and retains the
 * Platform OAuth client and curl_cffi request flow. Platform tokens are NOT
 * assumed to be accepted by the Codex backend: callers must validate them
 * against the actual model endpoint before placing accounts in the pool.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWorkerPython, run } from "./python-bootstrap.mjs";

const PYDIR = join(dirname(fileURLToPath(import.meta.url)), "../python");
const WORKER = join(PYDIR, "auth_worker.py");
const REQUIREMENTS = join(PYDIR, "requirements.txt");
let setup = null;

async function workerPython() {
  if (!setup) setup = ensureWorkerPython({ requirements: REQUIREMENTS }).catch((error) => {
    setup = null;
    throw error;
  });
  return setup;
}

export { workerPython };

export function normalizeWorkerResult(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw)); }
  catch { throw new Error("DSH HTTP 登录后端返回无效数据"); }
  if (parsed?.ok !== true)
    throw new Error("DSH HTTP 授权未完成（" + String(parsed?.error || "auth_failed").slice(0, 80) + "）");
  const accessToken = String(parsed.access_token || "");
  if (!accessToken || accessToken.length > 16384)
    throw new Error("HTTP 登录成功，但没有返回可用 access_token");
  return {
    access: accessToken,
    refresh: String(parsed.refresh_token || ""),
    id: String(parsed.id_token || ""),
  };
}

export async function loginHTTPAccount(account, { signal, proxy = "",
  worker = run, python = workerPython } = {}) {
  if (!account?.email || !account?.password)
    throw new Error("HTTP 登录需要邮箱和密码");
  if (signal?.aborted) throw new Error("HTTP 登录已取消");
  const command = await python();
  // One account per isolated worker so a failed account does not invalidate
  // a whole TXT batch. Input is never an argv argument or a log message.
  const output = await worker(command, [WORKER], {
    input: JSON.stringify({
      action: "authenticate", email: account.email, password: account.password,
      totp_secret: account.totp || "", proxy,
    }),
    timeout: 180000, signal,
  });
  const tokens = normalizeWorkerResult(output);
  return { tokens, email: account.email };
}
