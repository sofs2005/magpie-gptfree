/**
 * Magpie Providers -> GPT号池 sign-in (direct OS TXT dialog, no prompt buttons).
 *
 * All full-featured import, editable TXT preview, validation, and account
 * management live in Magpie's left-sidebar page「GPT号池」which automatically
 * synchronizes every pooled account into Magpie Providers.
 *
 * If the user still clicks「GPT号池」from Providers -> 添加供应商 -> 来自插件,
 * Magpie calls authorize() directly without showing extra blue select buttons,
 * immediately popping up the OS native TXT file picker:
 *  - Valid TXT files start importing in background and register each account;
 *  - Malformed or empty TXT files are staged into the in-memory draft so
 *    opening left-sidebar「GPT号池」pre-fills the editable textarea.
 */
import { pickAccountTxt } from "./native-file-dialog.mjs";
import { startGuiServer, GUI_PORT } from "./gui-service.mjs";
import { POOL_MARKER, POOL_PROVIDER } from "./pool-connection.mjs";
import { createWebOAuthFlow } from "./web-oauth.mjs";
import { probeAccountImageQuota } from "./codex-pool.mjs";
import { defaultStatsFile } from "./pool-stats.mjs";

/**
 * Browser OAuth sign-in method for Magpie Providers -> GPT号池.
 *
 * Returns OpenAI's official Codex PKCE authorization URL so Magpie displays
 * both「打开网页」and「复制链接」(plus automatic callback paste forwarding to
 * 127.0.0.1:1455 when completed in another browser or on another device).
 */
export function webOAuthMethod({
  startFlow = createWebOAuthFlow,
  syncPool = null,
  claimSlotKey = null,
  activeKey = null,
  probeQuota = probeAccountImageQuota,
} = {}) {
  return {
    type: "oauth",
    label: "网页登录授权（跳转浏览器或复制链接）",
    async authorize(_inputs, { signal } = {}) {
      if (signal?.aborted) {
        return { type: "failed", error: "网页授权已取消" };
      }
      const signInKey = typeof activeKey === "function" ? activeKey() : "";
      let flow;
      try {
        flow = await startFlow({
          onComplete: async ({ slotTag, record, planType }) => {
            if (slotTag && typeof claimSlotKey === "function") {
              claimSlotKey(slotTag, signInKey || POOL_PROVIDER);
            }
            if (typeof syncPool === "function") {
              try { await syncPool(); } catch {}
            }
            if (record && typeof probeQuota === "function") {
              try {
                const probe = await probeQuota(record, {
                  statsFile: defaultStatsFile(),
                  signal: AbortSignal.timeout(10_000),
                });
                if (probe?.ok) {
                  return {
                    imageQuota: typeof probe.imageQuota === "number" ? probe.imageQuota : (probe.rateLimited ? 0 : null),
                    planType: probe.planType || planType || null,
                    quotaChecked: true,
                  };
                }
              } catch {}
            }
            return {};
          },
        });
      } catch (error) {
        return {
          type: "failed",
          error: String(error?.message || "无法启动网页授权流程").slice(0, 220),
        };
      }

      const blockedNote = flow.callbackListening
        ? "在浏览器中登录 ChatGPT 完成授权，或复制上方链接到其他浏览器打开；授权后会自动回传，也可直接粘贴回调链接。"
        : "本地 1455 回调端口被占用或保留：请打开或复制上方链接在浏览器完成登录，再将跳转后的完整地址粘贴回来完成授权。";

      return {
        url: flow.url,
        method: "auto",
        instructions: blockedNote,
        async callback(code, { signal: callbackSignal } = {}) {
          try {
            let result;
            if (typeof code === "string" && code.trim()) {
              result = await flow.submitCallback(code);
            } else {
              result = await flow.wait(callbackSignal);
            }
            if (result?.state !== "done") {
              return {
                type: "failed",
                error: result?.error || "网页授权未完成",
              };
            }
            return {
              type: "success",
              key: POOL_MARKER,
              metadata: {
                email: result.accountLabel || "GPT号池 账号",
                ...(result.slotTag ? { poolSlot: result.slotTag } : {}),
              },
            };
          } catch (error) {
            flow.cancel();
            return {
              type: "failed",
              error: String(error?.message || "网页授权失败").slice(0, 220),
            };
          }
        },
      };
    },
  };
}

export function nativeImportMethod({
  picker = pickAccountTxt,
  server = () => startGuiServer({ port: GUI_PORT }),
  claimSlotKey = null,
  activeKey = null,
} = {}) {
  return {
    type: "oauth",
    label: "选择 TXT 文件批量导入（推荐直接点击左侧菜单「GPT号池」）",
    async authorize(_inputs, { signal } = {}) {
      if (signal?.aborted)
        return { type: "failed", error: "导入已取消" };

      let file;
      try { file = await picker({ signal }); }
      catch (error) {
        const known = /系统文件选择器不可用|当前平台没有可用|请选择.*\.txt/.test(String(error?.message || ""));
        return {
          type: "failed",
          error: known
            ? String(error.message).slice(0, 200)
            : "无法打开系统文件选择器；请直接点击左侧菜单「GPT号池」选择或粘贴账号",
        };
      }

      if (signal?.aborted || !file) {
        return {
          type: "failed",
          error: "未选择 TXT 文件，您可以直接点击左侧菜单「GPT号池」选择文件或粘贴文本导入",
        };
      }

      const signInKey = typeof activeKey === "function" ? activeKey() : "";
      let job;
      try {
        const service = await server();
        // Do not pass authorize's short-lived signal into the background
        // batch. Magpie aborts it immediately after authorize returns.
        job = await service.startNativeImport(file, {
          mode: "pool",
          skipInvalid: false,
          onFirstAccount: (acc) => {
            if (acc?.slotTag && typeof claimSlotKey === "function")
              claimSlotKey(acc.slotTag, signInKey || POOL_PROVIDER);
          },
        });
      } catch (error) {
        return {
          type: "failed",
          error: /已有批量导入任务|账号 TXT|无法读取选中的 TXT|账号文件超过|单次最多导入/.test(String(error?.message || ""))
            ? String(error.message).slice(0, 240)
            : "本地导入服务未能启动，请点击左侧菜单「GPT号池」查看",
        };
      }

      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: "已选中 TXT 并开始后台批量导入：首个账号成功后本对话框即完成，其余账号会自动继续入池并分别同步到 Providers；也可在左侧菜单「GPT号池」编辑文本或管理号池。",
        async callback(_code, { signal: callbackSignal } = {}) {
          const cancel = () => job.cancel();
          if (callbackSignal?.aborted) job.cancel();
          else callbackSignal?.addEventListener("abort", cancel, { once: true });
          try {
            const first = await job.first;
            if (!first.ok) return {
              type: "failed",
              error: first.error || "账号尚未成功入池，请在左侧菜单「GPT号池」页面查看",
            };
            return {
              type: "success",
              key: POOL_MARKER,
              metadata: {
                email: first.label || "GPT号池 账号",
                ...(first.slotTag ? { poolSlot: first.slotTag } : {}),
              },
            };
          } finally {
            callbackSignal?.removeEventListener("abort", cancel);
          }
        },
      };
    },
  };
}
