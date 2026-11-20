import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CLIENT_ID,
  buildCodexAuthorizeUrl,
  createWebOAuthFlow,
  generatePkcePair,
  openExternalUrl,
  parseCallbackInput,
} from "../lib/web-oauth.mjs";
import { webOAuthMethod } from "../lib/provider-native-signin.mjs";
import { createGuiService } from "../lib/gui-service.mjs";
import { renewAccount, rotateAccountsForTest } from "../lib/codex-pool.mjs";
import { createInMemoryStatsStore } from "../lib/pool-stats.mjs";
import {
  createDefaultSettings,
  normalizeSettings,
  readSettings,
  togglePrioritySlot,
} from "../lib/pool-settings.mjs";
import { POOL_MARKER, POOL_PROVIDER, accountSlotTag } from "../lib/pool-connection.mjs";

function makeFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function openGui(options = {}) {
  const service = createGuiService({ port: 0, startSweep: null, sessionFile: false, ...options });
  const address = await service.listen();
  const base = "http://127.0.0.1:" + address.port + "/";
  const html = await (await fetch(base + "ui")).text();
  const token = html.match(/meta name="gptfree-session" content="([0-9a-f]{64})"/)?.[1];
  assert.ok(token, "GUI page capability issued");
  const api = async (route, body) => {
    const headers = { Origin: "null", "X-GPTFree-Session": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + "api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { service, api, close: () => service.close() };
}

test("web-oauth builds standard Codex PKCE URL and parses callback URLs safely", () => {
  const pkce = generatePkcePair();
  assert.ok(pkce.verifier.length >= 43);
  assert.ok(pkce.challenge.length >= 43);

  const url = buildCodexAuthorizeUrl({ state: "st_abc123", codeChallenge: pkce.challenge });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://auth.openai.com");
  assert.equal(parsed.pathname, "/oauth/authorize");
  assert.equal(parsed.searchParams.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("state"), "st_abc123");

  assert.deepEqual(
    parseCallbackInput("http://localhost:1455/auth/callback?code=ac_good&state=st_abc123", "st_abc123"),
    { ok: true, code: "ac_good" },
  );
  assert.equal(
    parseCallbackInput("http://localhost:1455/auth/callback?code=ac_good&state=wrong", "st_abc123").ok,
    false,
  );
  assert.equal(
    parseCallbackInput("http://localhost:1455/auth/callback?error=access_denied", "st_abc123").ok,
    false,
  );
  assert.deepEqual(parseCallbackInput("ac_bare_code_12345", "st_abc123"), { ok: true, code: "ac_bare_code_12345" });
});

test("createWebOAuthFlow completes via loopback callback without leaking secrets in status", async () => {
  const saved = [];
  const fakeAccess = makeFakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "alice@example.com",
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct_123" },
  });
  const fakeId = makeFakeJwt({ email: "alice@example.com" });

  const flow = await createWebOAuthFlow({
    callbackPort: 0,
    save: async (rec) => { saved.push(rec); },
    fetcher: async (url, init) => {
      assert.equal(url, "https://auth.openai.com/oauth/token");
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "code_loopback_1");
      assert.equal(params.get("client_id"), CODEX_CLIENT_ID);
      assert.ok(params.get("code_verifier"));
      return new Response(JSON.stringify({
        access_token: fakeAccess,
        refresh_token: "rt_secret_value",
        id_token: fakeId,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  try {
    assert.equal(flow.callbackListening, true);
    const cbRes = await fetch(`${flow.redirectUri}?code=code_loopback_1&state=${flow.state}`);
    assert.equal(cbRes.status, 200);
    const done = await flow.wait();
    assert.equal(done.state, "done");
    assert.equal(done.slotTag, accountSlotTag("alice@example.com"));
    assert.equal(done.planType, "plus");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].email, "alice@example.com");
    assert.equal(saved[0].refreshToken, "rt_secret_value");
    assert.equal(saved[0].authType, "oauth");
    const serialized = JSON.stringify(done);
    assert.ok(!serialized.includes("alice@example.com"), "raw email must not appear in status");
    assert.ok(!serialized.includes("rt_secret_value"), "refresh token must not appear in status");
    assert.ok(!serialized.includes(fakeAccess), "access token must not appear in status");
  } finally {
    flow.cancel();
  }
});

test("webOAuthMethod returns provider OAuth URL and completes via pasted callback", async () => {
  const claimed = [];
  let synced = 0;
  const fakeAccess = makeFakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "bob@example.com",
    "https://api.openai.com/auth": { chatgpt_plan_type: "free", chatgpt_account_id: "acct_bob" },
  });
  const method = webOAuthMethod({
    startFlow: (opts) => createWebOAuthFlow({
      ...opts,
      callbackPort: 0,
      save: async () => {},
      fetcher: async () => new Response(JSON.stringify({
        access_token: fakeAccess,
        refresh_token: "rt_bob",
        id_token: makeFakeJwt({ email: "bob@example.com" }),
      }), { status: 200 }),
    }),
    probeQuota: async () => ({ ok: true, imageQuota: 15, planType: "free", rateLimited: false }),
    claimSlotKey: (slot, key) => claimed.push({ slot, key }),
    syncPool: async () => { synced++; },
    activeKey: () => `${POOL_PROVIDER}#entry2`,
  });

  const started = await method.authorize();
  assert.ok(started.url.startsWith("https://auth.openai.com/oauth/authorize?"));
  assert.equal(started.method, "auto");
  const state = new URL(started.url).searchParams.get("state");
  const result = await started.callback(`http://localhost:1455/auth/callback?code=code_paste_bob&state=${state}`);
  assert.equal(result.type, "success");
  assert.equal(result.key, POOL_MARKER);
  assert.equal(result.metadata.poolSlot, accountSlotTag("bob@example.com"));
  assert.ok(!result.metadata.email.includes("bob@example.com"));
  assert.deepEqual(claimed, [{ slot: accountSlotTag("bob@example.com"), key: `${POOL_PROVIDER}#entry2` }]);
  assert.equal(synced, 1);
});

test("openExternalUrl only allows official https://auth.openai.com URLs", () => {
  let called = null;
  openExternalUrl("https://auth.openai.com/oauth/authorize?client_id=test", {
    platform: "win32",
    spawner: (cmd, args, opts) => { called = { cmd, args, opts }; return { unref() {} }; },
  });
  assert.equal(called.cmd, "rundll32.exe");
  assert.equal(called.opts.shell, false);
  assert.throws(() => openExternalUrl("https://evil.example.com/oauth"), /仅允许打开官方 OpenAI/);
  assert.throws(() => openExternalUrl("javascript:alert(1)"), /仅允许打开官方 OpenAI/);
});

test("renewAccount refreshes OAuth accounts using refreshToken without requiring password", async () => {
  const newAccess = makeFakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, email: "oauth@example.com" });
  const saved = [];
  let httpLoginCalled = 0;
  const updated = await renewAccount(
    { email: "oauth@example.com", password: "", totp: "", accessToken: "old", refreshToken: "rt_old", authType: "oauth" },
    {
      authenticate: async () => { httpLoginCalled++; throw new Error("should not call password login"); },
      refreshOAuth: async ({ refreshToken }) => {
        assert.equal(refreshToken, "rt_old");
        return { accessToken: newAccess, refreshToken: "rt_rotated", idToken: "id_new" };
      },
      verify: async (tok) => ({ accepted: tok === newAccess }),
      save: async (rec) => { saved.push(rec); },
    },
  );
  assert.equal(httpLoginCalled, 0);
  assert.equal(updated.accessToken, newAccess);
  assert.equal(updated.refreshToken, "rt_rotated");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].refreshToken, "rt_rotated");
});

test("prioritySlots schedules priority pool accounts ahead of normal accounts across strategies", () => {
  const accounts = [
    { email: "norm1@example.com" },
    { email: "prio1@example.com" },
    { email: "norm2@example.com" },
    { email: "prio2@example.com" },
  ];
  const prio1Tag = accountSlotTag("prio1@example.com");
  const prio2Tag = accountSlotTag("prio2@example.com");
  const stats = {
    accounts: {
      [accountSlotTag("norm1@example.com")]: { imageQuota: 50, limitedUntil: null },
      [prio1Tag]: { imageQuota: 3, limitedUntil: null },
      [accountSlotTag("norm2@example.com")]: { imageQuota: 40, limitedUntil: null },
      [prio2Tag]: { imageQuota: 10, limitedUntil: null },
    },
  };

  // quotaFirst: priority pool (prio2=10, prio1=3) leads ahead of normal pool (norm1=50, norm2=40)
  const quotaOrdered = rotateAccountsForTest(accounts, stats, {
    strategy: "quotaFirst",
    skipRateLimited: true,
    prioritySlots: [prio1Tag, prio2Tag],
  });
  assert.deepEqual(
    quotaOrdered.map((a) => a.email),
    ["prio2@example.com", "prio1@example.com", "norm1@example.com", "norm2@example.com"],
  );

  // roundRobin: priority pool rotates among itself first, normal accounts follow
  const rr1 = rotateAccountsForTest(accounts, stats, {
    strategy: "roundRobin",
    skipRateLimited: true,
    prioritySlots: [prio1Tag, prio2Tag],
  });
  const rr2 = rotateAccountsForTest(accounts, stats, {
    strategy: "roundRobin",
    skipRateLimited: true,
    prioritySlots: [prio1Tag, prio2Tag],
  });
  assert.ok(["prio1@example.com", "prio2@example.com"].includes(rr1[0].email));
  assert.ok(["prio1@example.com", "prio2@example.com"].includes(rr1[1].email));
  assert.notEqual(rr1[0].email, rr2[0].email, "priority pool rotates internally under roundRobin");

  // Rate-limited priority account falls behind available normal accounts
  const future = new Date(Date.now() + 3600_000).toISOString();
  const limitedStats = {
    accounts: {
      ...stats.accounts,
      [prio1Tag]: { imageQuota: 0, limitedUntil: future },
    },
  };
  const withLimited = rotateAccountsForTest(accounts, limitedStats, {
    strategy: "preferred",
    skipRateLimited: true,
    prioritySlots: [prio1Tag, prio2Tag],
  });
  assert.equal(withLimited[0].email, "prio2@example.com");
  assert.equal(withLimited[withLimited.length - 1].email, "prio1@example.com");
});

test("GUI priority toggle and OAuth endpoints persist state cleanly without secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-prio-oauth-"));
  const settingsFile = join(dir, "pool-settings.json");
  const pool = [
    { email: "first@example.com", password: "p", totp: "t", accessToken: makeFakeJwt({ exp: 9999999999 }) },
    { email: "second@example.com", password: "p", totp: "t", accessToken: makeFakeJwt({ exp: 9999999999 }) },
  ];
  let cacheInvalidated = 0;
  let openedUrl = "";
  const harness = await openGui({
    poolRead: async () => pool.slice(),
    poolWrite: async (rec) => { pool.push(rec); },
    poolRemove: async (email) => {
      const i = pool.findIndex((x) => x.email === email);
      if (i >= 0) pool.splice(i, 1);
    },
    statsStore: createInMemoryStatsStore(),
    settingsFile,
    eventsFile: false,
    invalidateRotationCache: () => { cacheInvalidated++; },
    openUrl: (u) => { openedUrl = u; },
    probeQuota: async (rec, opts) => {
      // Simulate real probeAccountImageQuota recording stats into statsStore
      const { recordQuotaCheck } = await import("../lib/pool-stats.mjs");
      await recordQuotaCheck({ email: rec.email, quota: 120, planType: "plus", rateLimited: false }, opts);
      return { ok: true, imageQuota: 120, planType: "plus", rateLimited: false };
    },
    oauthStart: (opts) => createWebOAuthFlow({
      ...opts,
      callbackPort: 0,
      fetcher: async () => new Response(JSON.stringify({
        access_token: makeFakeJwt({ exp: 9999999999, email: "webuser@example.com" }),
        refresh_token: "rt_webuser",
        id_token: makeFakeJwt({ email: "webuser@example.com" }),
      }), { status: 200 }),
    }),
  });

  try {
    // 1. Toggle priority on the second account
    const list1 = await harness.api("accounts");
    assert.equal(list1.status, 200);
    assert.equal(list1.data.priorityCount, 0);
    const secondId = list1.data.accounts[1].id;

    const prioOn = await harness.api("priority", { id: secondId, priority: true });
    assert.equal(prioOn.status, 200);
    assert.equal(prioOn.data.priority, true);
    assert.equal(prioOn.data.priorityCount, 1);
    assert.equal(cacheInvalidated, 1);

    const list2 = await harness.api("accounts");
    assert.equal(list2.data.priorityCount, 1);
    // Priority account automatically sorts to the front of the list
    assert.equal(list2.data.accounts[0].id, secondId);
    assert.equal(list2.data.accounts[0].priority, true);
    assert.equal(list2.data.accounts[1].priority, false);

    const savedRaw = await readFile(settingsFile, "utf8");
    assert.ok(!savedRaw.includes("@"), "settings must only store slot hashes");
    assert.ok(savedRaw.includes(accountSlotTag("second@example.com")));

    // 2. Removing the priority account prunes its slot tag from settings
    const rem = await harness.api("remove", { id: secondId });
    assert.equal(rem.status, 200);
    const afterRemove = await readSettings({ file: settingsFile });
    assert.deepEqual(afterRemove.rotation.prioritySlots, []);

    // 3. GUI Web OAuth flow: start -> open -> paste callback -> pool updated
    const started = await harness.api("oauth/start", {});
    assert.equal(started.status, 200);
    assert.equal(started.data.state, "waiting");
    assert.ok(started.data.url.startsWith("https://auth.openai.com/oauth/authorize?"));

    const opened = await harness.api("oauth/open", {});
    assert.equal(opened.status, 200);
    assert.equal(openedUrl, started.data.url);

    const state = new URL(started.data.url).searchParams.get("state");
    const cb = await harness.api("oauth/callback", {
      callbackUrl: `http://localhost:1455/auth/callback?code=gui_code_99&state=${state}`,
    });
    assert.equal(cb.status, 200);
    assert.equal(cb.data.state, "done");
    assert.equal(cb.data.slotTag, accountSlotTag("webuser@example.com"));
    assert.equal(cb.data.imageQuota, 120);
    assert.equal(cb.data.quotaChecked, true);
    assert.equal(cb.data.planType, "plus");

    const list3 = await harness.api("accounts");
    const webAcc = list3.data.accounts.find((a) => a.slotTag === accountSlotTag("webuser@example.com"));
    assert.ok(webAcc, "OAuth account appears in pool list");
    assert.equal(webAcc.authType, "oauth");
    assert.equal(webAcc.imageQuota, 120);
    assert.equal(webAcc.planType, "plus");
  } finally {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("togglePrioritySlot validates slot tags cleanly", () => {
  const s0 = createDefaultSettings();
  const tag = accountSlotTag("demo@example.com");
  const s1 = togglePrioritySlot(s0, tag, true);
  assert.deepEqual(s1.rotation.prioritySlots, [tag]);
  const s2 = togglePrioritySlot(s1, "not-a-slot", true);
  assert.deepEqual(s2.rotation.prioritySlots, [tag]);
  const s3 = togglePrioritySlot(s2, tag, false);
  assert.deepEqual(s3.rotation.prioritySlots, []);
  const norm = normalizeSettings({ rotation: { prioritySlots: [tag, tag, "bad@email.com"] } });
  assert.deepEqual(norm.rotation.prioritySlots, [tag]);
});
