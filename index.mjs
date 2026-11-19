/**
 * Standalone Magpie GUI and token-pool providers (GPT号池).
 * GUI entry runs in the plugin-host and serves its own sandboxed page.
 * Primary import & management live in the left-sidebar page (GPT号池).
 */
import { CODEX_BASE, discoverPoolModels, poolFetch } from "./lib/codex-pool.mjs";
import { checkWebImageQuota } from "./lib/chatgpt-web-image.mjs";
import { GUI_PORT, startGuiServer } from "./lib/gui-service.mjs";
import { accountSlotTag, createPoolConnector, POOL_MARKER, POOL_PROVIDER } from "./lib/pool-connection.mjs";
import { readPoolStats, recordQuotaCheck } from "./lib/pool-stats.mjs";
import { listPool } from "./lib/pool-vault.mjs";
import { nativeImportMethod } from "./lib/provider-native-signin.mjs";

let sharedClient = null;
let sharedConnector = null;
let sharedActiveKey = null;

function ensurePoolConnector(ctx) {
  if (typeof ctx?.magpie?.account === "function") {
    sharedActiveKey = () => String(ctx.magpie.account(POOL_PROVIDER) || "");
  }
  if (typeof ctx?.client?.auth?.set === "function" &&
      typeof ctx?.client?.auth?.remove === "function") {
    if (!sharedConnector || sharedClient !== ctx.client) {
      sharedClient = ctx.client;
      sharedConnector = createPoolConnector(ctx.client, {
        getActiveKey: () => (sharedActiveKey ? sharedActiveKey() : ""),
      });
    }
  }
  return sharedConnector;
}

function slotFromAuth(auth) {
  const slot = auth?.metadata?.poolSlot;
  return typeof slot === "string" && /^s[0-9a-f]{6,16}$/i.test(slot) ? slot : "";
}

export const GPTFreeGuiPlugin = async (ctx, options) => {
  const raw = options?.port ?? GUI_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("GPT号池 GUI: invalid service port");
  const connection = ensurePoolConnector(ctx) || createPoolConnector(ctx.client);
  // The GUI port is normally held by the previous host, which is still
  // shutting down: a host restart overlaps the two for a moment.
  // startGuiServer waits for the port, so the plugin load does not: the
  // pool's provider side needs no GUI service and its models hook must
  // register at once ("GPT号池 has no endpoint configured" otherwise).
  startGuiServer({ port, onPoolChange: () => connection.sync() }).catch(async (error) => {
    const message = "GPT号池 GUI service could not start (" +
      String(error?.message || error) + "); the pool provider stays available, " +
      "the sidebar page is unavailable until the plugin host restarts";
    try {
      await ctx?.client?.app?.log?.({
        body: { service: "gptfree", level: "warn", message },
      });
    } catch {
      // A log that cannot be written must not stop the plugin from loading.
    }
  });
  // Restore Magpie's per-account local-pool slots automatically after
  // restarting. A corrupt vault must not make the GUI inaccessible.
  try {
    await connection.sync();
  } catch {
    await ctx.client.app.log({
      body: { service: "gptfree", level: "warn",
        message: "Could not restore local account-pool state; inspect GUI pool storage" },
    }).catch(() => {});
  }
  return {};
};

/**
 * Separate, multi-account access-token pool mode.
 * Every admitted vault account is synchronized to its own Magpie Providers
 * account row, allowing individual selection, preferred routing, and failover.
 */
export const GPTFreePoolPlugin = async (ctx = {}) => {
  const connector = ensurePoolConnector(ctx);
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[POOL_PROVIDER] ??= {
        name: "GPT号池",
        npm: "@ai-sdk/openai",
        api: CODEX_BASE,
        models: {},
      };
    },
    auth: {
      provider: POOL_PROVIDER,
      maxConcurrency: 2,
      // Native Magpie prompt & file chooser; never opens an external website.
      // Multi-account management stays enabled so every pooled account gets its
      // own toggleable row in Magpie Providers.
      methods: [nativeImportMethod({
        ...(connector ? { server: () => startGuiServer({ port: GUI_PORT, onPoolChange: () => sharedConnector?.sync() }) } : {}),
        syncPool: () => sharedConnector?.sync(),
        claimSlotKey: (slot, key) => sharedConnector?.claimKey(slot, key),
        activeKey: () => (sharedActiveKey ? sharedActiveKey() : ""),
      })],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};
        const preferredSlot = slotFromAuth(auth);
        return {
          baseURL: CODEX_BASE,
          apiKey: POOL_MARKER,
          fetch: (input, init) => poolFetch(input, init, { preferredSlot }),
        };
      },
      // magpie's own hook (host.js `auth.usage`): what the account's image
      // allowance has left, shown beside the account the way a built-in
      // provider's balance is. The upstream reports only what remains, never a
      // total, so it goes as `balance` — a number with no share to invent.
      //
      // The pool keeps the number itself: every generation takes one off
      // (recordImageCall), and a refusal that says the allowance is gone pins
      // it at 0 until the reset. So magpie asking again — it asks at its own
      // pace, a card at most every 30 seconds — is answered from the pool's
      // stats, and upstream is read only twice: once when nothing is known
      // yet, and once after a reset has gone by. Never while a known reading
      // still holds, and never more often than that.
      async usage(getAuth, _provider, options = {}) {
        const auth = await getAuth();
        const slot = slotFromAuth(auth);
        if (!slot) return { windows: [], error: "账号没有号池槽位" };
        const accounts = await listPool().catch(() => []);
        const account = accounts.find((item) => accountSlotTag(item.email) === slot);
        if (!account?.accessToken) return { windows: [], error: "这个账号不在号池里" };

        const stats = await readPoolStats().catch(() => null);
        const cached = stats?.accounts?.[slot];
        let quota = Number(cached?.imageQuota);
        let resetsAt = cached?.restoreAt || null;
        let plan = cached?.planType || "";
        const resetMs = Date.parse(cached?.limitedUntil || resetsAt || "");
        const checkedMs = cached?.quotaCheckedAt ? Date.parse(cached.quotaCheckedAt) : 0;

        const unknown = !Number.isFinite(quota);
        const resetPassed = resetMs > 0 && Date.now() >= resetMs && !(checkedMs >= resetMs);
        if (unknown || resetPassed) {
          const read = await checkWebImageQuota({
            accessToken: account.accessToken,
            signal: options?.signal,
          }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
          if (read?.ok) {
            quota = Number(read.quota) || 0;
            resetsAt = read.restore_at || null;
            plan = read.plan_type || plan;
            await recordQuotaCheck({
              email: account.email,
              quota,
              restoreAt: resetsAt,
              hasImageLimit: read.has_image_limit ?? null,
              planType: plan || null,
            }).catch(() => {});
          } else if (unknown) {
            return { windows: [], error: String(read?.error || "额度查询失败").slice(0, 120) };
          }
        }

        const when = cached?.limitedUntil || resetsAt;
        return {
          plan,
          user: account.email,
          windows: Number.isFinite(quota) ? [{
            name: "生图额度",
            balance: quota,
            unit: "张",
            // Both image models spend this one allowance.
            model: "image",
            ...(when ? { resetsAt: when } : {}),
          }] : [],
        };
      },
    },
    provider: {
      id: POOL_PROVIDER,
      async models(_provider, { auth } = {}) {
        if (auth?.type !== "api") return {};
        return discoverPoolModels({ preferredSlot: slotFromAuth(auth) });
      },
    },
  };
};
