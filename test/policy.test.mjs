import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROTATION_STRATEGIES,
  createDefaultSettings,
  mergeSettings,
  normalizeSettings,
  readSettings,
  writeSettings,
} from "../lib/pool-settings.mjs";
import { runQuotaSweep, startQuotaSweep } from "../lib/quota-sweep.mjs";
import { createInMemoryStatsStore, recordQuotaCheck } from "../lib/pool-stats.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";
import { rotateAccountsForTest } from "../lib/codex-pool.mjs";
import { createGuiService } from "../lib/gui-service.mjs";

async function tempDir(tag) {
  return mkdtemp(join(tmpdir(), `gptfree-${tag}-`));
}

// --- settings ------------------------------------------------------------

test("settings defaults are valid and cover every rotation strategy", () => {
  const defaults = createDefaultSettings();
  assert.ok(ROTATION_STRATEGIES.includes(defaults.rotation.strategy));
  assert.equal(defaults.sweep.enabled, true);
  assert.ok(defaults.sweep.intervalMinutes > 0);
  // Round-tripping the defaults must not change them.
  assert.deepEqual(normalizeSettings(defaults), defaults);
  assert.deepEqual(normalizeSettings(undefined), defaults);
  assert.deepEqual(normalizeSettings("garbage"), defaults);
});

test("settings reject an unknown strategy and clamp out-of-range numbers", () => {
  const bad = normalizeSettings({
    rotation: { strategy: "random-evil", skipRateLimited: "yes" },
    sweep: { intervalMinutes: -5, staleAfterMinutes: 999999 },
  });
  assert.equal(bad.rotation.strategy, "preferred");
  assert.equal(bad.rotation.skipRateLimited, true);
  assert.equal(bad.sweep.intervalMinutes, 0);
  assert.equal(bad.sweep.staleAfterMinutes, 24 * 60);
});

test("settings persist across a restart and never store credentials", async () => {
  const dir = await tempDir("settings");
  const file = join(dir, "pool-settings.json");
  try {
    assert.equal((await readSettings({ file })).rotation.strategy, "preferred");
    await writeSettings(mergeSettings(null, {
      rotation: { strategy: "quotaFirst", respectPreferredSlot: false },
      sweep: { intervalMinutes: 45 },
    }), { file });

    const reread = await readSettings({ file });
    assert.equal(reread.rotation.strategy, "quotaFirst");
    assert.equal(reread.rotation.respectPreferredSlot, false);
    assert.equal(reread.sweep.intervalMinutes, 45);

    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes("@"), "settings must not contain emails");
    assert.ok(!raw.includes("eyJ"), "settings must not contain tokens");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file falls back to defaults instead of throwing", async () => {
  const dir = await tempDir("settings-bad");
  const file = join(dir, "pool-settings.json");
  try {
    await writeFile(file, "{ not json", "utf8");
    const settings = await readSettings({ file });
    assert.equal(settings.rotation.strategy, "preferred");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- scheduled sweep -----------------------------------------------------

test("quota sweep skips recently checked accounts and reports per-account results", async () => {
  const nowMs = Date.now();
  const rows = [
    { email: "fresh@example.com", quotaCheckedAt: new Date(nowMs - 60_000).toISOString() },
    { email: "stale@example.com", quotaCheckedAt: new Date(nowMs - 5 * 3600_000).toISOString() },
    { email: "never@example.com", quotaCheckedAt: null },
  ];
  const probed = [];
  const summary = await runQuotaSweep({
    poolRead: async () => rows,
    nowMs,
    staleAfterMinutes: 120,
    probe: async (row) => {
      probed.push(row.email);
      return { ok: true, imageQuota: 12, rateLimited: false };
    },
    record: async () => {},
  });

  assert.deepEqual(probed.sort(), ["never@example.com", "stale@example.com"]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.ok, 2);
});

test("quota sweep counts rate-limited accounts and survives one failing probe", async () => {
  const rows = [{ email: "a@example.com" }, { email: "b@example.com" }, { email: "c@example.com" }];
  const summary = await runQuotaSweep({
    poolRead: async () => rows,
    probe: async (row) => {
      if (row.email === "a@example.com") return { ok: true, imageQuota: 0, rateLimited: true };
      if (row.email === "b@example.com") throw new Error("network down");
      return { ok: true, imageQuota: 5, rateLimited: false };
    },
    record: async () => {},
  });
  assert.equal(summary.checked, 3);
  assert.equal(summary.rateLimited, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.ok, 1);
});

test("quota sweep aborts while an import is running", async () => {
  let probed = 0;
  const summary = await runQuotaSweep({
    poolRead: async () => [{ email: "a@example.com" }],
    isBusy: () => true,
    pauseDuringImport: true,
    probe: async () => { probed++; return { ok: true }; },
    record: async () => {},
  });
  assert.equal(probed, 0);
  assert.equal(summary.aborted, true);
});

test("a sweep also respects a mid-run abort signal", async () => {
  const controller = new AbortController();
  const seen = [];
  const summary = await runQuotaSweep({
    poolRead: async () => [
      { email: "a@example.com" }, { email: "b@example.com" }, { email: "c@example.com" },
    ],
    signal: controller.signal,
    probe: async (row) => {
      seen.push(row.email);
      controller.abort();
      return { ok: true, imageQuota: 3 };
    },
    record: async () => {},
  });
  assert.equal(seen.length, 1);
  assert.equal(summary.aborted, true);
});

test("the sweep timer runs, records an event, and stops cleanly", async () => {
  const timers = [];
  const events = [];
  const controller = startQuotaSweep({
    readSettings: async () => ({
      rotation: {},
      sweep: { enabled: true, intervalMinutes: 30, staleAfterMinutes: 60, pauseDuringImport: true },
    }),
    poolRead: async () => [{ email: "a@example.com" }],
    probe: async () => ({ ok: true, imageQuota: 9, rateLimited: false }),
    record: async (entry) => { events.push(entry); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimer: () => {},
    initialDelayMs: 0,
  });
  try {
    // The kickoff timer fires the first pass.
    await timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.some((e) => e.event === "quota_sweep_done"));
    // A follow-up timer was scheduled for the configured interval.
    assert.ok(timers.some((t) => t.ms === 30 * 60 * 1000));
  } finally {
    controller.stop();
  }
});

// --- rotation ordering ---------------------------------------------------

test("quotaFirst puts accounts with more remaining quota first", () => {
  const accounts = [
    { email: "low@example.com" },
    { email: "high@example.com" },
    { email: "unknown@example.com" },
  ];
  const stats = {
    accounts: {
      [accountSlotTag("low@example.com")]: { imageQuota: 1, limitedUntil: null },
      [accountSlotTag("high@example.com")]: { imageQuota: 25, limitedUntil: null },
    },
  };
  const ordered = rotateAccountsForTest(accounts, stats, {
    strategy: "quotaFirst",
    skipRateLimited: true,
    preferredSlot: "",
    respectPreferredSlot: true,
  });
  assert.equal(ordered[0].email, "high@example.com");
  assert.equal(ordered[ordered.length - 1].email, "unknown@example.com");
});

test("a rate-limited account is pushed to the back under every strategy", () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const stats = {
    accounts: {
      [accountSlotTag("dead@example.com")]: { imageQuota: 0, limitedUntil: future },
      [accountSlotTag("alive@example.com")]: { imageQuota: 5, limitedUntil: null },
    },
  };
  for (const strategy of ["preferred", "roundRobin", "quotaFirst"]) {
    const ordered = rotateAccountsForTest(
      [{ email: "dead@example.com" }, { email: "alive@example.com" }],
      stats,
      { strategy, skipRateLimited: true, preferredSlot: "", respectPreferredSlot: true },
    );
    assert.equal(ordered[ordered.length - 1].email, "dead@example.com", strategy);
  }
});

test("skipRateLimited=false keeps the parked account in place", () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const stats = {
    accounts: { [accountSlotTag("b@example.com")]: { imageQuota: 0, limitedUntil: future } },
  };
  const ordered = rotateAccountsForTest(
    [{ email: "a@example.com" }, { email: "b@example.com" }],
    stats,
    { strategy: "preferred", skipRateLimited: false, preferredSlot: "", respectPreferredSlot: true },
  );
  assert.equal(ordered.length, 2);
});

// --- rotation ordering through the GUI service ---------------------------

/** Same shape as gui.test.mjs's harness: fetch the page, reuse its capability. */
async function openService(options = {}) {
  const service = createGuiService({ port: 0, ...options });
  const address = await service.listen();
  const base = "http://127.0.0.1:" + address.port + "/";
  const entry = await fetch(base + "ui");
  const html = await entry.text();
  const token = html.match(/meta name="gptfree-session" content="([0-9a-f]{64})"/)?.[1];
  assert.ok(token, "page capability issued");
  const api = async (route, body) => {
    const headers = { Origin: "null", "X-GPTFree-Session": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + "api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  };
  return { service, api, close: () => service.close() };
}

test("GUI settings endpoint saves the strategy and reports sweep status", async () => {
  const dir = await tempDir("gui-settings");
  const harness = await openService({
    poolRead: async () => [],
    statsStore: createInMemoryStatsStore(),
    sessionFile: false,
    settingsFile: join(dir, "pool-settings.json"),
    eventsFile: join(dir, "pool-events.jsonl"),
    startSweep: null,
  });
  try {
    const saved = await harness.api("settings", {
      rotation: { strategy: "quotaFirst", skipRateLimited: true },
      sweep: { intervalMinutes: 15 },
    });
    assert.equal(saved.settings.rotation.strategy, "quotaFirst");
    assert.equal(saved.settings.sweep.intervalMinutes, 15);
    assert.ok(Array.isArray(saved.strategies));
    assert.ok(saved.strategies.some((s) => s.id === "quotaFirst"));

    const readBack = await harness.api("settings");
    assert.equal(readBack.settings.rotation.strategy, "quotaFirst");
  } finally {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GUI logs endpoint returns newest-last events and honours the limit", async () => {
  const dir = await tempDir("gui-logs");
  const eventsFile = join(dir, "pool-events.jsonl");
  const lines = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({ t: new Date().toISOString(), event: "image_call", slot: `s${i}`, ok: i % 2 === 0 }));
  await writeFile(eventsFile, lines.join("\n") + "\n", "utf8");

  const harness = await openService({
    poolRead: async () => [],
    statsStore: createInMemoryStatsStore(),
    sessionFile: false,
    settingsFile: join(dir, "pool-settings.json"),
    eventsFile,
    startSweep: null,
  });
  try {
    const data = await harness.api("logs?limit=5");
    assert.equal(data.events.length, 5);
    assert.equal(data.events[4].slot, "s11");
    assert.ok(!JSON.stringify(data).includes("@"));
  } finally {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GUI logs endpoint tolerates a missing log file", async () => {
  const dir = await tempDir("gui-logs-missing");
  const harness = await openService({
    poolRead: async () => [],
    statsStore: createInMemoryStatsStore(),
    sessionFile: false,
    settingsFile: join(dir, "pool-settings.json"),
    eventsFile: join(dir, "does-not-exist.jsonl"),
    startSweep: null,
  });
  try {
    const data = await harness.api("logs");
    assert.deepEqual(data.events, []);
  } finally {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GUI sweep endpoint runs one pass over the pool", async () => {
  const dir = await tempDir("gui-sweep");
  let probed = 0;
  const harness = await openService({
    poolRead: async () => [{ email: "a@example.com", accessToken: "", password: "p", totp: "t" }],
    statsStore: createInMemoryStatsStore(),
    sessionFile: false,
    settingsFile: join(dir, "pool-settings.json"),
    eventsFile: join(dir, "pool-events.jsonl"),
    probeQuota: async () => { probed++; return { ok: true, imageQuota: 7, rateLimited: false }; },
    startSweep: ({ probe, record }) => ({
      isRunning: () => false,
      stop() {},
      runNow: () => runQuotaSweep({
        poolRead: async () => [{ email: "a@example.com" }],
        probe,
        record,
      }),
    }),
  });
  try {
    const summary = await harness.api("sweep/run", {});
    assert.equal(summary.checked, 1);
    assert.equal(probed, 1);
  } finally {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("roundRobin rotates starting accounts even when a preferredSlot is pinned", () => {
  const accounts = [
    { email: "one@example.com" },
    { email: "two@example.com" },
    { email: "three@example.com" },
  ];
  const preferredSlot = accountSlotTag("one@example.com");
  const firsts = new Set();
  for (let i = 0; i < 3; i++) {
    const ordered = rotateAccountsForTest(accounts, null, {
      strategy: "roundRobin",
      skipRateLimited: true,
      preferredSlot,
      respectPreferredSlot: true,
    });
    firsts.add(ordered[0].email);
  }
  assert.equal(firsts.size, 3, "roundRobin must rotate past the pinned preferred slot");
});

test("quota sweep reads quotaCheckedAt from pool stats and allows staleAfterMinutes=0 to force check", async () => {
  const statsStore = createInMemoryStatsStore();
  await recordQuotaCheck(
    { email: "fresh@example.com", quota: 8, rateLimited: false },
    { statsStore },
  );
  const rows = [{ email: "fresh@example.com" }, { email: "unchecked@example.com" }];

  const skippedRun = [];
  const summary1 = await runQuotaSweep({
    poolRead: async () => rows,
    staleAfterMinutes: 120,
    statsTarget: { statsStore },
    probe: async (row) => {
      skippedRun.push(row.email);
      return { ok: true, imageQuota: 5, rateLimited: false };
    },
    record: async () => {},
  });
  assert.deepEqual(skippedRun, ["unchecked@example.com"]);
  assert.equal(summary1.skipped, 1);
  assert.equal(summary1.checked, 1);

  const forcedRun = [];
  const summary2 = await runQuotaSweep({
    poolRead: async () => rows,
    staleAfterMinutes: 0,
    statsTarget: { statsStore },
    probe: async (row) => {
      forcedRun.push(row.email);
      return { ok: true, imageQuota: 5, rateLimited: false };
    },
    record: async () => {},
  });
  assert.deepEqual(forcedRun.sort(), ["fresh@example.com", "unchecked@example.com"]);
  assert.equal(summary2.skipped, 0);
  assert.equal(summary2.checked, 2);
});

test("startQuotaSweep runNow tracks running state, clears previous timer, and honours stop()", async () => {
  let cleared = 0;
  let releaseProbe;
  const controller = startQuotaSweep({
    readSettings: async () => ({
      rotation: {},
      sweep: { enabled: true, intervalMinutes: 30, staleAfterMinutes: 60, pauseDuringImport: true },
    }),
    poolRead: async () => [{ email: "a@example.com" }, { email: "b@example.com" }],
    probe: async (_row, { signal }) => {
      await new Promise((resolve) => {
        releaseProbe = resolve;
        signal?.addEventListener("abort", resolve, { once: true });
      });
      return { ok: true, imageQuota: 4, rateLimited: false };
    },
    record: async () => {},
    setTimer: (_fn, _ms) => ({ id: Math.random(), unref() {} }),
    clearTimer: () => { cleared++; },
    initialDelayMs: 60_000,
  });

  const runPromise = controller.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isRunning(), true);

  // Overlapping runNow is rejected cleanly without double-running.
  const overlapping = await controller.runNow();
  assert.equal(overlapping.aborted, true);

  // stop() aborts the in-flight manual sweep cleanly.
  controller.stop();
  const result = await runPromise;
  assert.equal(controller.isRunning(), false);
  assert.equal(result.aborted, true);
  assert.ok(cleared >= 1);
});

// --- helpers -------------------------------------------------------------
