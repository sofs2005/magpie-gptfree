/**
 * Browser-based OpenAI / Codex OAuth PKCE sign-in for GPT号池.
 *
 * Mirrors Magpie's Codex OAuth flow (`app_EMoamEEZ73f0CkXaXp7hrann`, loopback
 * callback `http://localhost:1455/auth/callback`) so users can either:
 *   1. Open the authorization URL directly in their browser, or
 *   2. Copy the URL into another browser / incognito / remote session and paste
 *      back the resulting callback URL (or authorization code).
 *
 * Security boundaries:
 * - Callback listener binds strictly to `127.0.0.1`.
 * - State parameter is checked before any token exchange.
 * - OAuth tokens and raw emails are saved only to the owner's encrypted local
 *   vault; status snapshots never expose tokens, PKCE verifiers, or raw emails.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { spawn } from "node:child_process";
import { upsertPool } from "./pool-vault.mjs";
import { accountSlotTag, formatAccountSlotLabel } from "./pool-connection.mjs";

export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CODEX_CALLBACK_HOST = "127.0.0.1";
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 30 * 1000;
const ALLOWED_CALLBACK_PATHS = new Set(["/auth/callback", "/callback", "/oauth2callback", "/oauth-callback"]);

export function generatePkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildCodexAuthorizeUrl({
  state,
  codeChallenge,
  redirectUri = CODEX_REDIRECT_URI,
  authorizeUrl = CODEX_AUTHORIZE_URL,
  clientId = CODEX_CLIENT_ID,
} = {}) {
  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CODEX_SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || !parts[1] || parts[1].length > 65536) return {};
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function extractIdentityFromTokens({ idToken = "", accessToken = "" } = {}) {
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const authClaims = accessClaims["https://api.openai.com/auth"] || idClaims["https://api.openai.com/auth"] || {};
  const profileClaims = accessClaims["https://api.openai.com/profile"] || idClaims["https://api.openai.com/profile"] || {};
  const rawEmail = String(
    idClaims.email ||
    profileClaims.email ||
    accessClaims.email ||
    "",
  ).trim().toLowerCase();
  const planType = String(
    authClaims.chatgpt_plan_type ||
    idClaims.chatgpt_plan_type ||
    "",
  ).trim().toLowerCase() || null;
  const accountId = String(
    authClaims.chatgpt_account_id ||
    accessClaims.chatgpt_account_id ||
    idClaims.chatgpt_account_id ||
    "",
  ).trim();
  return { email: rawEmail, planType, accountId };
}

function statesMatch(a, b) {
  const sa = Buffer.from(String(a || ""), "utf8");
  const sb = Buffer.from(String(b || ""), "utf8");
  return sa.length > 0 && sa.length === sb.length && timingSafeEqual(sa, sb);
}

/**
 * Accept a full browser callback URL (e.g. `http://localhost:1455/auth/callback?code=...&state=...`),
 * a query string (`code=...&state=...`), or a bare authorization code.
 */
export function parseCallbackInput(raw, expectedState = "") {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "请粘贴浏览器跳转后的回调链接或授权码" };

  let params = null;
  if (/^https?:\/\//i.test(text)) {
    let parsed;
    try { parsed = new URL(text); }
    catch { return { ok: false, error: "回调链接格式无效，请粘贴完整地址" }; }
    params = parsed.searchParams;
  } else if (text.includes("code=") || text.includes("error=")) {
    params = new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
  }

  if (params) {
    const errCode = params.get("error");
    if (errCode) {
      const desc = params.get("error_description") || errCode;
      return { ok: false, error: `授权被拒绝：${String(desc).slice(0, 160)}` };
    }
    const state = params.get("state") || "";
    if (expectedState && (!state || !statesMatch(state, expectedState))) {
      return { ok: false, error: "回调链接与当前授权会话不匹配（state 不一致），请重新生成授权链接" };
    }
    const code = (params.get("code") || "").trim();
    if (!code) return { ok: false, error: "回调链接中缺少 code 参数，请粘贴完整跳转地址" };
    return { ok: true, code };
  }

  if (/\s/.test(text) || text.length < 8) {
    return { ok: false, error: "请输入完整的回调链接（http://localhost:1455/auth/callback?code=...）或有效授权码" };
  }
  return { ok: true, code: text };
}

function resolveProxyEnv(explicitProxy = "") {
  const direct = String(explicitProxy || "").trim();
  if (direct) return direct;
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * Pure-stdlib HTTPS POST with optional HTTP CONNECT proxy tunnel (zero deps).
 */
async function postViaProxy({ targetUrl, proxyUrl, headers, body, signal, timeoutMs = TOKEN_TIMEOUT_MS }) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const targetHost = target.hostname;
  const targetPort = Number(target.port) || (target.protocol === "http:" ? 80 : 443);

  const run = async () => {
    if (target.protocol === "http:") {
      return new Promise((resolve, reject) => {
        const req = httpRequest({
          host: proxy.hostname,
          port: Number(proxy.port) || 80,
          method: "POST",
          path: target.toString(),
          headers: { ...headers, Host: target.host, "Content-Length": Buffer.byteLength(body) },
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
        req.end(body);
      });
    }

    const proxyHeaders = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username || proxy.password) {
      const creds = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        "utf8",
      ).toString("base64");
      proxyHeaders["Proxy-Authorization"] = `Basic ${creds}`;
    }

    const socket = await new Promise((resolve, reject) => {
      const connectReq = httpRequest({
        host: proxy.hostname,
        port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: proxyHeaders,
      });
      connectReq.on("connect", (res, sock) => {
        if (res.statusCode !== 200) {
          sock.destroy();
          reject(new Error(`代理握手失败 (${res.statusCode})`));
          return;
        }
        resolve(sock);
      });
      connectReq.on("error", reject);
      connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error("代理连接超时")));
      connectReq.end();
    });

    const tlsSocket = tlsConnect({ socket, servername: targetHost });
    return new Promise((resolve, reject) => {
      const req = httpsRequest({
        host: targetHost,
        port: targetPort,
        path: target.pathname + target.search,
        method: "POST",
        createConnection: () => tlsSocket,
        headers: {
          ...headers,
          Host: target.host,
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error("OAuth 令牌接口超时")));
      req.end(body);
    });
  };

  if (!signal) return run();
  if (signal.aborted) throw new Error("授权已取消");
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("授权已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    run().then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

async function postTokenEndpoint({ tokenUrl, contentType, body, proxy = "", fetcher = null, signal }) {
  const headers = {
    "Content-Type": contentType,
    Accept: "application/json",
    "User-Agent": "codex_cli_rs/0.164.0",
  };
  let status = 0;
  let text = "";

  if (typeof fetcher === "function") {
    const response = await fetcher(tokenUrl, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: signal || AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } else {
    const resolvedProxy = resolveProxyEnv(proxy);
    const parsedTarget = new URL(tokenUrl);
    const isLoopbackTarget = ["127.0.0.1", "localhost", "::1"].includes(parsedTarget.hostname);
    if (resolvedProxy && !isLoopbackTarget) {
      const res = await postViaProxy({ targetUrl: tokenUrl, proxyUrl: resolvedProxy, headers, body, signal });
      status = res.status;
      text = res.text;
    } else {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: signal || AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      status = response.status;
      text = await response.text();
    }
  }

  let parsed = {};
  try { parsed = JSON.parse(text || "{}"); } catch {}
  if (status < 200 || status >= 300) {
    const detail = parsed?.error_description || parsed?.detail || parsed?.message ||
      (typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message) || `HTTP ${status}`;
    throw new Error(`OAuth 令牌换取失败 (${status})：${String(detail).slice(0, 180)}`);
  }
  return parsed;
}

export async function exchangeCodexCode({
  code,
  verifier,
  redirectUri = CODEX_REDIRECT_URI,
  tokenUrl = CODEX_TOKEN_URL,
  clientId = CODEX_CLIENT_ID,
  proxy = "",
  fetcher = null,
  signal,
} = {}) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || "").trim(),
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const tok = await postTokenEndpoint({
    tokenUrl,
    contentType: "application/x-www-form-urlencoded",
    body: form.toString(),
    proxy,
    fetcher,
    signal,
  });
  const accessToken = String(tok.access_token || "").trim();
  const refreshToken = String(tok.refresh_token || "").trim();
  const idToken = String(tok.id_token || "").trim();
  if (!accessToken) {
    throw new Error("OpenAI 未返回 access_token，请重试网页授权");
  }
  const identity = extractIdentityFromTokens({ idToken, accessToken });
  if (!identity.email || !identity.email.includes("@")) {
    throw new Error("无法从 OAuth 令牌中识别账号邮箱");
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    email: identity.email,
    planType: identity.planType,
    accountId: identity.accountId,
  };
}

export async function refreshCodexToken({
  refreshToken,
  tokenUrl = CODEX_TOKEN_URL,
  clientId = CODEX_CLIENT_ID,
  proxy = "",
  fetcher = null,
  signal,
} = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("缺少 refresh_token，无法自动续期");
  const body = JSON.stringify({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: rt,
    refresh_reason: "scheduled",
  });
  const tok = await postTokenEndpoint({
    tokenUrl,
    contentType: "application/json",
    body,
    proxy,
    fetcher,
    signal,
  });
  const accessToken = String(tok.access_token || "").trim();
  if (!accessToken) throw new Error("刷新 OAuth 令牌未返回新的 access_token");
  return {
    accessToken,
    refreshToken: String(tok.refresh_token || "").trim() || rt,
    idToken: String(tok.id_token || "").trim(),
  };
}

function callbackHtml(ok, title, detail) {
  const esc = (s) => String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const color = ok ? "#16845c" : "#c0392b";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#f7f8fa;color:#1f2328;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
    .card{max-width:440px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 26px;box-shadow:0 4px 18px rgba(0,0,0,.06)}
    h1{font-size:18px;margin:0 0 10px;color:${color}}
    p{font-size:14px;line-height:1.6;margin:0;color:#4b5563}
  </style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
  </div>
</body>
</html>`;
}

async function pingExistingCancel(port) {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: CODEX_CALLBACK_HOST,
      port,
      path: "/cancel",
      method: "GET",
      timeout: 1200,
    }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function bindCallbackServer(server, port) {
  const tryListen = () => new Promise((resolve, reject) => {
    const onErr = (err) => { server.off("listening", onOk); reject(err); };
    const onOk = () => { server.off("error", onErr); resolve(server.address()); };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(port, CODEX_CALLBACK_HOST);
  });

  try {
    return { address: await tryListen(), blocked: "" };
  } catch (err) {
    if (err?.code === "EADDRINUSE" && port > 0) {
      await pingExistingCancel(port);
      await new Promise((r) => setTimeout(r, 180));
      try {
        return { address: await tryListen(), blocked: "" };
      } catch (err2) {
        return { address: null, blocked: err2?.code === "EACCES" ? "reserved" : "busy" };
      }
    }
    return { address: null, blocked: err?.code === "EACCES" ? "reserved" : "busy" };
  }
}

export function openExternalUrl(url, { platform = process.platform, spawner = spawn } = {}) {
  let parsed;
  try { parsed = new URL(String(url || "")); }
  catch { throw new Error("无效的授权链接"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com") {
    throw new Error("仅允许打开官方 OpenAI 授权页面");
  }
  const safe = parsed.toString();
  let cmd;
  let args;
  if (platform === "win32") {
    cmd = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", safe];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [safe];
  } else {
    cmd = "xdg-open";
    args = [safe];
  }
  const child = spawner(cmd, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true });
  child?.unref?.();
  return true;
}

/**
 * Start an interactive browser OAuth PKCE sign-in flow.
 * Resolves via either the local 127.0.0.1:1455 callback or `submitCallback(raw)`.
 */
export async function createWebOAuthFlow({
  callbackPort = CODEX_CALLBACK_PORT,
  authorizeUrl = CODEX_AUTHORIZE_URL,
  tokenUrl = CODEX_TOKEN_URL,
  proxy = "",
  fetcher = null,
  save = upsertPool,
  onComplete = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const id = randomBytes(12).toString("hex");
  const state = randomBytes(24).toString("hex");
  const { verifier, challenge } = generatePkcePair();

  let statusState = "waiting";
  let errorMessage = "";
  let accountLabel = "";
  let slotTag = "";
  let planType = null;
  let imageQuota = null;
  let quotaChecked = false;
  let claimed = false;
  let settled = false;
  let resolveDone;
  const donePromise = new Promise((resolve) => { resolveDone = resolve; });

  const abortController = new AbortController();
  let server = null;
  let closeTimer = null;

  function snapshot() {
    return {
      id,
      state: statusState,
      url,
      redirectUri,
      callbackListening,
      callbackBlocked,
      accountLabel,
      slotTag,
      planType,
      imageQuota,
      quotaChecked,
      error: errorMessage,
    };
  }

  function closeServerNow() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (!server) return;
    const srv = server;
    server = null;
    try {
      if (srv.listening) srv.close();
      srv.closeAllConnections?.();
    } catch {}
  }

  function closeServerSoon(delayMs = 0) {
    if (!server) return;
    if (delayMs > 0) {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(closeServerNow, delayMs);
      closeTimer?.unref?.();
    } else {
      closeServerNow();
    }
  }

  function finish(nextState, details = {}, closeDelayMs = 0) {
    if (settled) return snapshot();
    settled = true;
    clearTimeout(timeoutHandle);
    statusState = nextState;
    if (details.error) errorMessage = String(details.error).slice(0, 240);
    if (details.accountLabel) accountLabel = details.accountLabel;
    if (details.slotTag) slotTag = details.slotTag;
    if (details.planType !== undefined) planType = details.planType;
    if (details.imageQuota !== undefined) imageQuota = details.imageQuota;
    if (details.quotaChecked !== undefined) quotaChecked = Boolean(details.quotaChecked);
    closeServerSoon(closeDelayMs);
    const snap = snapshot();
    resolveDone(snap);
    return snap;
  }

  async function completeWithCode(code, fromBrowser = false) {
    if (settled) return snapshot();
    if (claimed) return donePromise;
    claimed = true;
    statusState = "exchanging";
    try {
      const tokens = await exchangeCodexCode({
        code,
        verifier,
        redirectUri,
        tokenUrl,
        proxy,
        fetcher,
        signal: abortController.signal,
      });
      const label = formatAccountSlotLabel(tokens.email);
      const tag = accountSlotTag(tokens.email);
      const record = {
        email: tokens.email,
        password: "",
        totp: "",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        authType: "oauth",
        kind: "oauth",
        planType: tokens.planType,
        updatedAt: new Date().toISOString(),
      };
      await save(record);
      let resolvedPlan = tokens.planType;
      let resolvedQuota = null;
      let resolvedQuotaChecked = false;
      if (typeof onComplete === "function") {
        try {
          const extra = await onComplete({ email: tokens.email, slotTag: tag, label, planType: tokens.planType, record });
          if (extra && typeof extra === "object") {
            if (typeof extra.imageQuota === "number" && Number.isFinite(extra.imageQuota)) {
              resolvedQuota = extra.imageQuota;
              resolvedQuotaChecked = true;
            }
            if (extra.quotaChecked === true) resolvedQuotaChecked = true;
            if (typeof extra.planType === "string" && extra.planType) resolvedPlan = extra.planType;
          }
        } catch {}
      }
      return finish("done", {
        accountLabel: label,
        slotTag: tag,
        planType: resolvedPlan,
        imageQuota: resolvedQuota,
        quotaChecked: resolvedQuotaChecked,
      }, fromBrowser ? 600 : 0);
    } catch (err) {
      return finish("failed", { error: err?.message || "网页授权失败，请重试" }, fromBrowser ? 600 : 0);
    }
  }

  server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const uri = new URL(req.url || "/", `http://${CODEX_CALLBACK_HOST}`);
    if (uri.pathname === "/cancel") {
      finish("canceled", { error: "授权已取消" });
      res.writeHead(204);
      res.end();
      return;
    }
    if (!ALLOWED_CALLBACK_PATHS.has(uri.pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (settled) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackHtml(statusState === "done", statusState === "done" ? "授权已完成" : "当前授权已结束", "请返回 Magpie GPT号池 查看。"));
      return;
    }
    const parsed = parseCallbackInput(uri.search, state);
    if (!parsed.ok) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackHtml(false, "网页授权未完成", parsed.error));
      if (uri.searchParams.get("error")) finish("failed", { error: parsed.error }, 400);
      return;
    }
    const result = await completeWithCode(parsed.code, true);
    const ok = result.state === "done";
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(callbackHtml(
      ok,
      ok ? "GPT号池授权成功" : "GPT号池授权失败",
      ok
        ? `账号 ${result.accountLabel} 已加入本地 GPT号池，可关闭此标签页返回 Magpie。`
        : (result.error || "请返回 Magpie 重试授权。"),
    ));
  });

  const { address, blocked } = await bindCallbackServer(server, callbackPort);
  const actualPort = address?.port || (callbackPort || CODEX_CALLBACK_PORT);
  const callbackListening = Boolean(address);
  const callbackBlocked = blocked;
  const redirectUri = callbackPort === 0 && address?.port
    ? `http://localhost:${actualPort}/auth/callback`
    : CODEX_REDIRECT_URI;
  const url = buildCodexAuthorizeUrl({ state, codeChallenge: challenge, redirectUri, authorizeUrl });

  const timeoutHandle = setTimeout(() => {
    abortController.abort();
    finish("failed", { error: "等待网页授权超时（10 分钟），请重新生成授权链接" });
  }, Math.max(1000, timeoutMs));
  timeoutHandle?.unref?.();

  return {
    id,
    url,
    state,
    redirectUri,
    callbackListening,
    callbackBlocked,
    status: snapshot,
    async submitCallback(raw) {
      if (settled) return snapshot();
      const parsed = parseCallbackInput(raw, state);
      if (!parsed.ok) {
        const err = new Error(parsed.error);
        err.status = 400;
        throw err;
      }
      return completeWithCode(parsed.code, false);
    },
    wait(signal) {
      if (!signal) return donePromise;
      if (signal.aborted) {
        abortController.abort();
        return Promise.resolve(finish("canceled", { error: "授权已取消" }));
      }
      return new Promise((resolve) => {
        const onAbort = () => {
          abortController.abort();
          resolve(finish("canceled", { error: "授权已取消" }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        donePromise.then((res) => {
          signal.removeEventListener("abort", onAbort);
          resolve(res);
        });
      });
    },
    cancel() {
      abortController.abort();
      closeServerNow();
      return finish("canceled", { error: "授权已取消" });
    },
  };
}
