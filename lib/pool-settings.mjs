/**
 * Local non-secret settings for the GPT号池 pool.
 *
 * Stores the rotation strategy and the scheduled quota-check schedule in
 * `poolDir()/pool-settings.json` (0600). Nothing here is a credential: no email,
 * password, TOTP seed, token or proxy URL ever reaches this file.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { poolDir } from "./pool-vault.mjs";

const SETTINGS_FILE = "pool-settings.json";
const FORMAT_VERSION = 1;

/** Rotation strategies, in the order the GUI offers them. */
export const ROTATION_STRATEGIES = Object.freeze(["preferred", "roundRobin", "quotaFirst"]);

const MIN_SWEEP_MINUTES = 5;
const MAX_SWEEP_MINUTES = 24 * 60;
const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;
const MAX_PRIORITY_SLOTS = 1000;

function cleanPrioritySlots(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!SLOT_TAG_RE.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_PRIORITY_SLOTS) break;
  }
  return out;
}

export function createDefaultSettings() {
  return {
    version: FORMAT_VERSION,
    rotation: {
      // "preferred" keeps upstream's original behaviour (the pinned slot first);
      // "roundRobin" spreads calls across every account;
      // "quotaFirst" prefers accounts with the most remaining quota.
      strategy: "preferred",
      // Skip accounts whose quota is 0 or whose cool-down is still running.
      // This is what stops a dead account from leading every request.
      skipRateLimited: true,
      // Honour Magpie's per-account "preferred" pin. Off = pure rotation.
      respectPreferredSlot: true,
      // Slot hashes marked "优先使用" in the account list. Accounts in this set
      // are always scheduled ahead of regular accounts (within the active strategy).
      prioritySlots: [],
    },
    sweep: {
      // Background re-check of each account's remaining image quota.
      enabled: true,
      // 0 means "only when the plugin host starts".
      intervalMinutes: 30,
      // Accounts checked this recently are left alone by a sweep.
      staleAfterMinutes: 120,
      // Do not sweep while an import/edit batch is running.
      pauseDuringImport: true,
    },
  };
}

export function defaultSettingsFile() {
  return join(poolDir(), SETTINGS_FILE);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  if (t < min) return min;
  if (t > max) return max;
  return t;
}

function cleanStrategy(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  return ROTATION_STRATEGIES.includes(raw) ? raw : fallback;
}

/** Coerce whatever is on disk into a valid settings object. Never throws. */
export function normalizeSettings(parsed) {
  const base = createDefaultSettings();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;

  const rotation = parsed.rotation && typeof parsed.rotation === "object" ? parsed.rotation : {};
  const sweep = parsed.sweep && typeof parsed.sweep === "object" ? parsed.sweep : {};

  base.rotation.strategy = cleanStrategy(rotation.strategy, base.rotation.strategy);
  base.rotation.skipRateLimited =
    typeof rotation.skipRateLimited === "boolean" ? rotation.skipRateLimited : base.rotation.skipRateLimited;
  base.rotation.respectPreferredSlot =
    typeof rotation.respectPreferredSlot === "boolean"
      ? rotation.respectPreferredSlot
      : base.rotation.respectPreferredSlot;
  base.rotation.prioritySlots = cleanPrioritySlots(rotation.prioritySlots);

  base.sweep.enabled = typeof sweep.enabled === "boolean" ? sweep.enabled : base.sweep.enabled;
  base.sweep.intervalMinutes = clampInt(
    sweep.intervalMinutes, 0, MAX_SWEEP_MINUTES, base.sweep.intervalMinutes);
  base.sweep.staleAfterMinutes = clampInt(
    sweep.staleAfterMinutes, MIN_SWEEP_MINUTES, MAX_SWEEP_MINUTES, base.sweep.staleAfterMinutes);
  base.sweep.pauseDuringImport =
    typeof sweep.pauseDuringImport === "boolean" ? sweep.pauseDuringImport : base.sweep.pauseDuringImport;
  return base;
}

/**
 * Merge a partial update into current settings, re-normalizing so an invalid
 * value falls back instead of corrupting the file.
 */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current);
  if (!patch || typeof patch !== "object") return base;
  const merged = {
    rotation: { ...base.rotation, ...(patch.rotation && typeof patch.rotation === "object" ? patch.rotation : {}) },
    sweep: { ...base.sweep, ...(patch.sweep && typeof patch.sweep === "object" ? patch.sweep : {}) },
  };
  return normalizeSettings(merged);
}

/** Add or remove a slot hash from the priority pool list. */
export function togglePrioritySlot(current, slotTag, enabled) {
  const base = normalizeSettings(current);
  const tag = typeof slotTag === "string" ? slotTag.trim().toLowerCase() : "";
  if (!SLOT_TAG_RE.test(tag)) return base;
  const list = base.rotation.prioritySlots.filter((s) => s !== tag);
  if (enabled) list.push(tag);
  return normalizeSettings({
    ...base,
    rotation: { ...base.rotation, prioritySlots: list },
  });
}

let pending = Promise.resolve();
function exclusive(work) {
  const run = pending.then(work, work);
  pending = run.catch(() => {});
  return run;
}

export async function readSettings({ file = undefined } = {}) {
  const target = file === false ? null : file !== undefined ? file : defaultSettingsFile();
  if (!target) return createDefaultSettings();
  return exclusive(async () => {
    try {
      const raw = await readFile(target, "utf8");
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return createDefaultSettings();
    }
  });
}

export async function writeSettings(next, { file = undefined } = {}) {
  const target = file === false ? null : file !== undefined ? file : defaultSettingsFile();
  const normalized = normalizeSettings(next);
  if (!target) return normalized;
  return exclusive(async () => {
    const dir = dirname(target);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600, flag: "wx" });
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
    return normalized;
  });
}
