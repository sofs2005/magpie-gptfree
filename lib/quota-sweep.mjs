/**
 * Scheduled quota sweep for the GPT号池.
 *
 * Re-checks each pooled account's remaining image quota on a timer so the pool
 * stops trusting week-old numbers: `imageQuota` used to be written only by a
 * manual "检测刷新" or by a 429, which left the GUI showing stale counts and
 * kept the queue ordering wrong.
 *
 * A sweep calls only `/backend-api/conversation/init` (via checkWebImageQuota),
 * which does not consume an image generation. Accounts checked recently are
 * skipped, the sweep is aborted if the host shuts down, and one bad account
 * never stops the rest.
 */
import { probeAccountImageQuota } from "./codex-pool.mjs";
import { accountSlotTag } from "./pool-connection.mjs";
import { readPoolStats } from "./pool-stats.mjs";
import { poolDir } from "./pool-vault.mjs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

const EVENTS_FILE = "pool-events.jsonl";
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;

let eventQueue = Promise.resolve();

/** Append one audit line to the pool event log. Never throws. */
export function recordEvent(entry, { file = undefined } = {}) {
  const target = file === false ? null : file !== undefined ? file : join(poolDir(), EVENTS_FILE);
  if (!target) return Promise.resolve();
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n";
  eventQueue = eventQueue.then(async () => {
    try {
      let size = 0;
      try { size = (await stat(target)).size; } catch {}
      if (size > MAX_EVENTS_BYTES) await rename(target, target + ".1").catch(() => {});
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 }).catch(() => {});
      await appendFile(target, line, { mode: 0o600 });
    } catch {
      // An unwritable log must never break the pool.
    }
  }, () => {});
  return eventQueue;
}

/**
 * One pass over the pool.
 *
 * @returns {Promise<{checked:number, skipped:number, ok:number, failed:number,
 *                    rateLimited:number, aborted:boolean}>}
 */
export async function runQuotaSweep({
  poolRead,
  nowMs = Date.now(),
  staleAfterMinutes = 120,
  isBusy = () => false,
  pauseDuringImport = true,
  signal,
  probe = probeAccountImageQuota,
  record = recordEvent,
  statsTarget = {},
  proxy = "",
  onAccount = null,
} = {}) {
  const summary = { checked: 0, skipped: 0, ok: 0, failed: 0, rateLimited: 0, aborted: false };
  if (pauseDuringImport && isBusy()) {
    summary.aborted = true;
    return summary;
  }

  let rows = [];
  try { rows = await poolRead(); } catch { return summary; }
  rows = Array.isArray(rows) ? rows : [];

  const rawStale = Number(staleAfterMinutes);
  const staleMs = rawStale === 0
    ? 0
    : Math.max(5, Number.isFinite(rawStale) && rawStale > 0 ? rawStale : 120) * 60 * 1000;
  let stats = null;
  if (staleMs > 0 && (statsTarget?.statsStore || statsTarget?.statsFile)) {
    stats = await readPoolStats(statsTarget).catch(() => null);
  }
  const due = [];
  for (const row of rows) {
    if (typeof row?.email !== "string" || !row.email.includes("@")) continue;
    const statsCheckedAt = stats?.accounts?.[accountSlotTag(row.email)]?.quotaCheckedAt || null;
    const checkedAt = row.quotaCheckedAt ?? statsCheckedAt;
    const lastMs = checkedAt ? Date.parse(checkedAt) : NaN;
    // Accounts never checked are always due; recently checked ones are skipped
    // so a short interval does not hammer chatgpt.com.
    if (staleMs > 0 && Number.isFinite(lastMs) && nowMs - lastMs < staleMs) {
      summary.skipped++;
      continue;
    }
    due.push(row);
  }

  for (const row of due) {
    if (signal?.aborted) { summary.aborted = true; break; }
    if (pauseDuringImport && isBusy()) { summary.aborted = true; break; }
    summary.checked++;
    let outcome;
    try {
      outcome = await probe(row, { proxy, ...statsTarget, signal });
    } catch (err) {
      summary.failed++;
      await record({ event: "quota_sweep", ok: false, reason: String(err?.message || err).slice(0, 120) });
      continue;
    }
    if (outcome?.ok === true) {
      if (outcome.rateLimited) summary.rateLimited++;
      else summary.ok++;
    } else {
      summary.failed++;
    }
    if (typeof onAccount === "function") {
      try { onAccount(row, outcome); } catch {}
    }
  }

  await record({
    event: "quota_sweep_done",
    accounts: rows.length,
    ...summary,
  });
  return summary;
}

/**
 * Start the recurring sweep. Returns a controller with `stop()` and `runNow()`.
 *
 * The timer is unref'd so a sweep never keeps the plugin host alive, and the
 * first pass runs shortly after start (the host restarts often, so waiting a
 * whole interval would mean the GUI stays stale).
 */
export function startQuotaSweep({
  readSettings,
  poolRead,
  isBusy = () => false,
  probe,
  record,
  statsTarget = {},
  proxy = "",
  log = () => {},
  initialDelayMs = 20_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let timer = null;
  let running = false;
  let controller = null;

  async function settings() {
    try { return await readSettings(); }
    catch { return { sweep: { enabled: false, intervalMinutes: 0, staleAfterMinutes: 120, pauseDuringImport: true } }; }
  }

  function schedule(minutes) {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (stopped) return;
    if (!minutes || minutes <= 0) {
      return;
    }
    timer = setTimer(() => { void tick(); }, minutes * 60 * 1000);
    timer?.unref?.();
  }

  async function tick() {
    if (stopped || running) return;
    const cfg = await settings();
    if (!cfg.sweep.enabled) { schedule(0); return; }
    running = true;
    controller = new AbortController();
    try {
      const summary = await runQuotaSweep({
        poolRead,
        staleAfterMinutes: cfg.sweep.staleAfterMinutes,
        isBusy,
        pauseDuringImport: cfg.sweep.pauseDuringImport,
        signal: controller.signal,
        probe,
        record,
        statsTarget,
        proxy,
      });
      log(`quota sweep: checked=${summary.checked} ok=${summary.ok} ` +
        `rateLimited=${summary.rateLimited} failed=${summary.failed} skipped=${summary.skipped}`);
    } catch (err) {
      log(`quota sweep failed: ${String(err?.message || err).slice(0, 160)}`);
    } finally {
      running = false;
      controller = null;
    }
    schedule(cfg.sweep.intervalMinutes);
  }

  // Kick off shortly after start so a restarted host refreshes promptly.
  const kickoff = setTimer(() => { void tick(); }, Math.max(0, initialDelayMs));
  kickoff?.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      clearTimer(kickoff);
      controller?.abort();
    },
    async runNow() {
      if (stopped || running) return { aborted: true };
      const cfg = await settings();
      running = true;
      controller = new AbortController();
      let summary;
      try {
        summary = await runQuotaSweep({
          poolRead,
          staleAfterMinutes: 0,
          isBusy,
          pauseDuringImport: false,
          signal: controller.signal,
          probe,
          record,
          statsTarget,
          proxy,
        });
      } finally {
        running = false;
        controller = null;
      }
      schedule(cfg.sweep.enabled ? cfg.sweep.intervalMinutes : 0);
      return summary;
    },
    isRunning: () => running,
  };
}
