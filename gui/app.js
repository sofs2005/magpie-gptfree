// GUI runs in Magpie's sandboxed frame, with a fresh in-memory capability
// sent on every request. Never write input secrets into persistent browser
// storage, query strings, logs, or plugin options.
(() => {
  const $ = (id) => document.getElementById(id);
  const session = document.querySelector('meta[name="gptfree-session"]')?.content || "";
  const labels = {
    standard: "邮箱 + 密码 + 2FA",
    mail_link: "附邮箱链接",
    access_token: "附带 JWT Token",
  };
  const tokenLabels = {
    expired: "Token 过期 · 将自动重登",
    unexpired_unverified: "Token 待服务器验证",
    unknown: "Token 有效期未知",
    not_yet_valid: "Token 尚未生效",
  };
  const poolTokenBadges = {
    unexpired_unverified: { cls: "good", text: "Token 有效（待请求确认）" },
    expired: { cls: "warn", text: "Token 已过期（会自动重登）" },
    missing: { cls: "bad", text: "无可用 Token" },
    unknown: { cls: "warn", text: "Token 状态未知" },
    not_yet_valid: { cls: "warn", text: "Token 尚未生效" },
    invalid: { cls: "bad", text: "Token 格式异常" },
  };
  const stateLabels = {
    authorizing: "正在授权",
    added: "导入成功",
    token_reused: "Token 已验证复用",
    token_expired: "Token 过期",
    token_needs_oauth: "需要 OAuth",
    token_unverified: "需要验证",
    mail_link_ignored: "邮箱链接已识别",
    failed: "授权失败",
  };
  let preview = null, previewSource = "", lastSeq = 0, polling = null, busy = false, poolBusy = false, checkingDraft = false, activeTab = "import";
  const jobStates = new Map();
  const rowMessages = new Map();
  // Rows whose "检测/刷新" is in flight.  The pool's own busy state disables
  // the pool-level buttons; a single row's check disables only that row.
  const checkingRows = new Set();
  // Magpie restarts its plugin host about once an hour (community plugin
  // auto-update). The page outlives that restart, so a request can be refused
  // with an expired page capability. Instead of leaving an error banner for the
  // rest of the session, reload the page once and let it open a fresh one.
  let reconnecting = false;
  function isSessionExpired(message) {
    return /session expired|会话已过期|session/i.test(String(message || ""));
  }
  function reconnectOnce() {
    if (reconnecting) return;
    reconnecting = true;
    notice("插件服务刚刚重启，正在自动重新连接…");
    setTimeout(() => location.reload(), 350);
  }

  function el(tag, className, content) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.textContent = String(content);
    return n;
  }
  function notice(message, error = false) {
    const n = $("notice");
    n.textContent = message;
    n.className = "notice" + (error ? " error" : "");
  }
  function hidden(id, yes) { $(id).classList.toggle("hidden", yes); }
  function countTextLines(text) {
    let lines = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const s = raw.trim();
      if (s && !s.startsWith("#") && !s.startsWith("//")) lines++;
    }
    return lines;
  }
  function updateLineCounter() {
    const n = countTextLines($("pasteAccounts").value);
    $("lineCount").textContent = n + " 行有效文本";
  }
  async function api(route, data = undefined) {
    const opts = {
      method: data === undefined ? "GET" : "POST",
      headers: { "X-GPTFree-Session": session },
      cache: "no-store",
      credentials: "omit",
    };
    if (data !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(data);
    }
    let response;
    try { response = await fetch("api/" + route, opts); }
    catch { throw new Error("无法连接本地导入服务，请重新打开 Magpie 插件页面"); }
    let json;
    try { json = await response.json(); }
    catch { throw new Error("本地服务返回无效响应"); }
    if (!response.ok) {
      const error = new Error(json.error || "操作失败");
      error.status = response.status;
      if (response.status === 403 && isSessionExpired(json.error)) reconnectOnce();
      throw error;
    }
    return json;
  }
  function hasDraftChanges() {
    return $("pasteAccounts").value !== previewSource;
  }
  function canStartImport() {
    return $("consent").checked && !!$("pasteAccounts").value.trim();
  }
  function setBusy(next) {
    busy = next;
    $("selectFile").disabled = busy;
    $("fileInput").disabled = busy;
    $("checkPaste").disabled = busy;
    $("clearPaste").disabled = busy;
    $("pasteAccounts").disabled = busy;
    $("skipInvalid").disabled = busy;
    $("proxyInput").disabled = busy;
    $("consent").disabled = busy;
    $("dropzone").classList.toggle("disabled", busy);
    $("startButton").disabled = busy || !canStartImport();
  }
  function renderPreview(rows) {
    const tbody = $("previewRows");
    const nodes = [];
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.line = row.line;
      const status = jobStates.get(row.line);
      const cols = [
        "#" + row.line, row.email,
        labels[row.format] || row.format,
        status ? stateLabels[status] || status :
          row.tokenState ? tokenLabels[row.tokenState] || "待验证" : "等待导入",
      ];
      for (const [i, val] of cols.entries()) {
        const td = el("td", i === 3 ? "status-cell" : "", val);
        tr.append(td);
      }
      nodes.push(tr);
    }
    tbody.replaceChildren(...nodes);
  }
  function renderValidation() {
    $("counts").textContent = preview.count + " 条有效 · " +
      preview.duplicates + " 条重复 · " + preview.errors.length + " 条错误";
    const box = $("validation");
    box.replaceChildren();
    if (preview.errors.length) {
      box.append(el("strong", "",
        "以下行存在格式错误，请直接在上方文本框修改对应行，或勾选「跳过格式错误行，仅导入有效账号」："));
      const ul = el("ul");
      for (const e of preview.errors.slice(0, 20))
        ul.append(el("li", "", "第 " + e.line + " 行：" + e.reason));
      box.append(ul);
      hidden("validation", false);
    } else hidden("validation", true);
    renderPreview(preview.rows);
    hidden("previewBox", false);
    setBusy(busy);
  }
  async function previewText(text, sourceLabel = "文本框内容") {
    if (!text || !text.trim()) {
      notice("请先选择 TXT 文件或在文本框输入账号列表", true);
      return false;
    }
    if (new TextEncoder().encode(text).length > 1024 * 1024) {
      notice("账号列表超过 1 MiB，请分批导入", true);
      return false;
    }
    const wasBusy = busy;
    setBusy(true);
    hidden("progressBox", true);
    jobStates.clear();
    preview = null;
    previewSource = text;
    try {
      const data = await api("preview", { text });
      preview = data;
      renderValidation();
      if (data.errors.length && !$("skipInvalid").checked) {
        notice(sourceLabel + " 已加载到文本框（发现 " + data.errors.length + " 行格式错误）：可直接编辑修改后继续，或勾选「跳过格式错误行」", true);
      } else if (data.errors.length) {
        notice(sourceLabel + " 已解析：" + data.count + " 条有效（已选择跳过 " + data.errors.length + " 条错误行），可点击「导入并授权入池」");
      } else {
        notice(sourceLabel + " 已解析（" + data.count + " 条有效），可继续在文本框微调或点击「导入并授权入池」");
      }
      return true;
    } catch (err) {
      hidden("previewBox", true);
      notice(err.message, true);
      return false;
    } finally { setBusy(wasBusy); }
  }
  async function loadText(file) {
    if (busy || !file) return;
    if (file.size > 1024 * 1024) {
      notice("请选择小于 1 MiB 的 TXT 文件", true);
      return;
    }
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
      notice("请使用 TXT 文件", true);
      return;
    }
    $("fileName").textContent = file.name + " · " + Math.ceil(file.size / 1024) + " KiB（已填入下方文本框，可直接编辑）";
    const text = await file.text();
    // Put loaded file text straight into the editable textarea so malformed lines
    // can be inspected and corrected without re-uploading.
    $("pasteAccounts").value = text;
    updateLineCounter();
    $("pasteAccounts").focus();
    await previewText(text, "TXT 文件");
  }
  function addEvent(entry) {
    const div = el("div", "event");
    div.append(el("span", "event-dot " + entry.state));
    div.append(el("span", "event-account", "第 " + entry.line + " 行 · " + entry.email));
    div.append(el("span", "event-state", stateLabels[entry.state] || entry.state));
    if (entry.reason) div.append(el("span", "event-reason", entry.reason));
    // One line, replaced as the job advances: the log tracks the job's
    // current state, not its history, so the line always reads as the
    // latest thing that happened and stops there when the job ends.
    $("events").replaceChildren(div);
    if (entry.line) jobStates.set(entry.line, entry.state);
  }
  function setSummaryEvent(text, state) {
    // What the log rests on once the job is over.
    const div = el("div", "event");
    div.append(el("span", "event-dot " + state));
    div.append(el("span", "event-state", text));
    $("events").replaceChildren(div);
  }
  async function status() {
    let info;
    try { info = await api("status"); }
    catch (err) { stopPolling(); notice(err.message, true); return; }
    if (info.state === "idle") return;
    const incoming = info.events || [];
    if (incoming.length && incoming.at(-1).seq < lastSeq) {
      $("events").replaceChildren();
      lastSeq = 0;
    }
    for (const entry of incoming.filter((event) => event.seq > lastSeq)) addEvent(entry);
    if (incoming.length) lastSeq = incoming.at(-1).seq;
    if (preview?.rows) renderPreview(preview.rows);
    hidden("progressBox", false);
    if (info.state === "running") {
      setBusy(true);
      if (!polling) polling = setInterval(status, 850);
    }
    $("doneCount").textContent = String(info.done || 0);
    $("addedCount").textContent = String(info.result?.added ?? info.added ?? 0);
    $("reusedCount").textContent = String(info.result?.reused ?? info.reused ?? 0);
    $("failedCount").textContent = String(info.result?.failed ?? info.failed ?? 0);
    const percent = Math.round((info.done || 0) / Math.max(1, info.total) * 100);
    $("progressFill").style.width = percent + "%";
    $("progressTrack").setAttribute("aria-valuenow", String(percent));
    $("progressCaption").textContent = (info.done || 0) + " / " + info.total + " · " +
      ({ running: "正在导入", completed: "已完成", canceled: "已取消", error: "导入异常" }[info.state] || "");
    if (info.state !== "running") {
      stopPolling();
      setBusy(false);
      hidden("cancelButton", true);
      hidden("againButton", false);
      await loadPool();
      if (activeTab === "stats") await loadStats();
      if (info.state === "completed") {
        const added = info.result?.added ?? info.added ?? 0;
        const failed = info.result?.failed ?? info.failed ?? 0;
        const skipped = info.result?.invalid ?? 0;
        const providerCount = info.providerCount ?? added;
        setSummaryEvent(
          `导入完成：成功 ${added} 个 · 失败 ${failed} 个${skipped ? ` · 跳过错误行 ${skipped}` : ""}`,
          "added",
        );
        if (info.providerConnected === true)
          notice(`导入完成：本次新增/更新 ${added} 个账号（失败 ${failed}${skipped ? `，已跳过错误行 ${skipped}` : ""}），当前已有 ${providerCount} 个账号独立入驻 Magpie Providers`);
        else if (info.providerConnected === false)
          notice(info.message || "账号已入池，但连接 Magpie 号池失败；请检查插件状态", true);
        else
          notice("批量处理完成，可在「我的账号池」与「额度统计」查看账号与详细状态；没有可用账号时不会连接供应商");
      } else {
        setSummaryEvent(info.message || "批量导入已停止，未完成的账号可稍后重试", "failed");
        notice(info.message || "批量导入已停止，未完成的账号可稍后重试", true);
      }
    }
  }
  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = null;
  }
  async function begin() {
    if (busy || !$("consent").checked) return;
    const text = $("pasteAccounts").value;
    const skipInvalid = $("skipInvalid").checked;
    if (!text.trim()) {
      notice("请先选择 TXT 文件或在文本框输入账号", true);
      return;
    }
    if (hasDraftChanges() || !preview) {
      const ok = await previewText(text, "当前编辑文本");
      if (!ok) return;
    }
    if (!preview || !preview.count) {
      notice("没有可导入的有效账号，请检查文本框内容", true);
      return;
    }
    if (preview.errors.length && !skipInvalid) {
      $("previewBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      notice("仍有 " + preview.errors.length + " 行格式错误：请直接在上方文本框修改，或勾选「跳过格式错误行，仅导入有效账号」", true);
      return;
    }
    setBusy(true);
    jobStates.clear();
    lastSeq = 0;
    $("events").replaceChildren();
    hidden("progressBox", false);
    hidden("againButton", true);
    hidden("cancelButton", false);
    $("progressFill").style.width = "0%";
    try {
      await api("start", {
        mode: "pool",
        consent: true,
        skipInvalid,
        proxy: $("proxyInput").value.trim(),
      });
      $("progressBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      stopPolling();
      await status();
      notice("已开始 DSH 风格后台 HTTP 批量登录；成功账号将逐个独立同步到 Magpie Providers 供多账号使用");
    } catch (err) {
      setBusy(false);
      hidden("progressBox", true);
      notice(err.message, true);
    }
  }
  async function cancel() {
    try {
      await api("cancel", {});
      $("cancelButton").disabled = true;
      $("cancelButton").textContent = "正在停止…";
      notice("已请求停止；当前账号的授权操作正在取消");
    } catch (err) { notice(err.message, true); }
  }
  function formatTime(iso, prefix = "更新于 ") {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : prefix + d.toLocaleString();
  }
  function quotaBadgeInfo(account) {
    const status = account.quotaStatus || (typeof account.imageQuota === "number"
      ? (account.imageQuota === 0 ? "limited" : "available")
      : (account.quotaError ? "error" : "unchecked"));
    if (status === "available") {
      return {
        cls: "good",
        pillText: "生图额度：" + account.imageQuota,
        statusLabel: "可用",
        quotaCell: String(account.imageQuota),
        title: account.quotaCheckedAt ? formatTime(account.quotaCheckedAt, "检测于 ") : "上游返回的剩余生图额度",
      };
    }
    if (status === "limited") {
      return {
        cls: "bad",
        pillText: account.cooldownExpired ? "冷却到期 · 待检测 (0)" : "已限流 · 剩余 0",
        statusLabel: account.cooldownExpired ? "待复检" : "限流中",
        quotaCell: "0",
        title: account.quotaResetAt ? formatTime(account.quotaResetAt, "预计恢复 ") : "上游返回剩余额度为 0",
      };
    }
    if (status === "needs_renew") {
      return {
        cls: "warn",
        pillText: typeof account.imageQuota === "number"
          ? "生图额度：" + account.imageQuota + "（需续期）"
          : "生图额度：需先续期",
        statusLabel: "需续期",
        quotaCell: typeof account.imageQuota === "number" ? String(account.imageQuota) : "—",
        title: "Token 已过期，需重新授权后再检测生图额度",
      };
    }
    if (status === "unavailable") {
      return {
        cls: "bad",
        pillText: "无可用 Token",
        statusLabel: "不可用",
        quotaCell: "—",
        title: "缺失或异常 Token，请检测/刷新授权",
      };
    }
    if (status === "error") {
      return {
        cls: "warn",
        pillText: "额度查询失败",
        statusLabel: "查询失败",
        quotaCell: "失败",
        title: account.quotaError || "查询 ChatGPT Web 生图额度失败",
      };
    }
    return {
      cls: "neutral",
      pillText: "生图额度：待检测",
      statusLabel: "待检测",
      quotaCell: "待检测",
      title: "尚未向 chatgpt.com 查询生图额度，点击检测/刷新获取真实额度",
    };
  }
  function setPoolBusyState(next) {
    poolBusy = next;
    const hasRows = !!$("poolList")?.querySelector(".account-row");
    $("refreshAllPool").disabled = poolBusy || !hasRows;
    if ($("syncProviders")) $("syncProviders").disabled = poolBusy;
    if ($("refreshStatsQuota")) $("refreshStatsQuota").disabled = poolBusy || !hasRows;
    if ($("reloadStats")) $("reloadStats").disabled = poolBusy;
  }
  async function refreshAccounts(payload) {
    if (poolBusy || busy) return;
    setPoolBusyState(true);
    try {
      const proxy = ($("poolProxyInput").value || $("statsProxyInput")?.value || $("proxyInput").value || "").trim();
      const res = await api("accounts/refresh", { ...payload, proxy });
      const quotaOnly = payload?.quotaOnly === true;
      for (const item of res.results || []) {
        if (quotaOnly) {
          if (item.quotaOk) {
            rowMessages.set(item.id, "最新生图额度：剩余 " + (item.imageQuota ?? 0));
          } else {
            rowMessages.set(item.id, "额度查询失败：" + (item.quotaError || item.reason || "请检查代理或网络"));
          }
        } else if (item.status === "valid") {
          rowMessages.set(
            item.id,
            item.quotaOk === true
              ? "上次检测：Token 有效 · 生图额度 " + (item.imageQuota ?? 0)
              : item.quotaOk === false
                ? "Token 有效 · 额度查询失败：" + (item.quotaError || "请检查代理")
                : "上次检测：有效可用",
          );
        } else if (item.status === "renewed") {
          rowMessages.set(
            item.id,
            item.quotaOk === true
              ? "已续期 Token · 生图额度 " + (item.imageQuota ?? 0)
              : item.quotaOk === false
                ? "已续期 Token · 额度查询失败：" + (item.quotaError || "请检查代理")
                : "上次刷新：已重新授权并更新 Token",
          );
        } else {
          rowMessages.set(item.id, "上次刷新失败：" + (item.reason || "请检查网络或账号状态"));
        }
      }
      if (activeTab === "stats") {
        await loadStats();
      } else {
        await loadPool();
      }
      if (quotaOnly) {
        if (res.failed > 0 && res.quotaChecked === 0) {
          const detail = res.results?.[0]?.quotaError || res.results?.[0]?.reason || "请检查代理或账号状态";
          notice("额度检测失败：" + res.failed + " 个账号查询失败（" + detail + "）", true);
        } else {
          const totalQ = res.quotaStats?.totalQuota ?? 0;
          notice(`额度检测完成：已更新 ${res.quotaChecked ?? (res.valid + res.renewed)} 个账号 · 当前可用总剩余额度 ${totalQ}${res.failed ? ` · 失败 ${res.failed} 个` : ""}`);
        }
      } else if (res.failed > 0 && res.renewed === 0 && res.valid === 0) {
        notice("检测完成：" + res.failed + " 个账号刷新失败，请检查代理或账号状态", true);
      } else if (res.quotaFailed > 0) {
        notice(`检测完成：有效 ${res.valid} · 续期 ${res.renewed}（其中 ${res.quotaFailed} 个账号生图额度查询失败，请检查 chatgpt.com 代理连通性）`);
      } else {
        const extra = res.quotaChecked > 0 ? ` · 生图总剩余额度 ${res.quotaStats?.totalQuota ?? 0}` : "";
        notice(`检测完成：有效 ${res.valid} 个 · 续期 ${res.renewed} 个 · 失败 ${res.failed} 个${extra}`);
      }
    } catch (err) {
      notice(err.message, true);
    } finally {
      setPoolBusyState(false);
    }
  }
  async function syncProvidersNow() {
    if (poolBusy || busy) return;
    setPoolBusyState(true);
    try {
      const res = await api("sync", {});
      await loadPool();
      if (res.connected)
        notice(`已将 ${res.count} 个账号分别同步到 Magpie Providers，可在 Providers 中独立勾选、设为首选与轮询`);
      else
        notice("当前号池暂无可用账号，已清理 Providers 中的空号池条目");
    } catch (err) {
      notice(err.message, true);
    } finally {
      setPoolBusyState(false);
    }
  }
  async function loadPendingDraft() {
    if (busy || checkingDraft) return;
    checkingDraft = true;
    try {
      const draft = await api("draft");
      if (!draft?.hasDraft || typeof draft.text !== "string" || busy) return;
      tab("import");
      $("pasteAccounts").value = draft.text;
      $("fileName").textContent = (draft.filename || "accounts.txt") + "（已预加载，可直接在下方编辑修正）";
      updateLineCounter();
      await previewText(draft.text, "预加载的 TXT 文件");
      $("pasteAccounts").focus();
    } catch {
      // Ignore transient errors when polling pending drafts.
    } finally {
      checkingDraft = false;
    }
  }
  function renderStatsView(data) {
    const qs = data?.quotaStats || {};
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const totalAccounts = Number(qs.total ?? accounts.length ?? 0);
    const activeAccounts = Number(qs.active ?? 0);
    const limitedAccounts = Number(qs.limited ?? 0);
    const uncheckedAccounts = Number(qs.unchecked ?? 0);
    const erroredAccounts = Number(qs.errored ?? 0);
    const totalQuota = Number(qs.totalQuota ?? 0);
    const totalSuccess = Number(qs.totalSuccess ?? 0);
    const totalFail = Number(qs.totalFail ?? 0);

    $("statTotalAccounts").textContent = String(totalAccounts);
    $("statActiveAccounts").textContent = String(activeAccounts);
    $("statLimitedAccounts").textContent = String(limitedAccounts);
    $("statTotalQuota").textContent = (totalAccounts && qs.checked === 0 && totalQuota === 0)
      ? (erroredAccounts > 0 ? "—" : "待检测")
      : String(totalQuota);
    $("statTotalSuccess").textContent = String(totalSuccess);
    $("statTotalFail").textContent = String(totalFail);
    $("statQuotaNote").textContent = uncheckedAccounts > 0
      ? `尚有 ${uncheckedAccounts} 个账号未检测额度`
      : erroredAccounts > 0
        ? `其中 ${erroredAccounts} 个账号额度查询失败`
        : "从上游状态接口读取";
    $("statsMeta").textContent = totalAccounts
      ? `共 ${totalAccounts} 个账号 · 可用 ${activeAccounts} · 限流 ${limitedAccounts} · 待检测 ${uncheckedAccounts}${erroredAccounts ? ` · 查询失败 ${erroredAccounts}` : ""}`
      : "号池暂无账号 · 请先在「批量导入」添加账号";

    if ($("refreshStatsQuota")) {
      $("refreshStatsQuota").disabled = poolBusy || !accounts.length;
    }

    const hint = $("statsHint");
    if (!accounts.length) {
      hint.classList.add("hidden");
      hint.textContent = "";
    } else if (erroredAccounts > 0 && activeAccounts === 0) {
      hint.classList.remove("hidden");
      hint.textContent = "部分或全部账号查询生图额度失败：登录走 auth.openai.com，而生图额度查询需访问 chatgpt.com。请确认本机 HTTP(S) 代理可访问 chatgpt.com 后点击「刷新全部额度」。";
    } else if (uncheckedAccounts > 0) {
      hint.classList.remove("hidden");
      hint.textContent = `当前有 ${uncheckedAccounts} 个账号尚未获取 chatgpt.com 生图额度，可点击右上角「刷新全部额度」实时检测（不会伪造或估算数值）。`;
    } else if (totalAccounts > 0 && limitedAccounts === totalAccounts) {
      hint.classList.remove("hidden");
      hint.textContent = "上游返回所有账号当前生图剩余额度均为 0（已限流）。请等待官方配额恢复或补充新账号。";
    } else {
      hint.classList.add("hidden");
      hint.textContent = "";
    }

    const tbody = $("statsRows");
    if (!accounts.length) {
      const tr = el("tr");
      const td = el("td", "stats-empty", "号池暂无账号，暂无额度统计明细。");
      td.colSpan = 7;
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }

    const rows = [];
    for (const account of accounts) {
      const tr = el("tr");
      const q = quotaBadgeInfo(account);
      const nameTd = el("td");
      nameTd.append(el("strong", "", account.slotLabel || account.email));
      if (account.priority) {
        nameTd.append(" ", el("span", "pill priority", "优先"));
      }
      tr.append(nameTd);

      const planTd = el("td");
      planTd.append(el("span", "pill " + (account.planType ? "plan" : "neutral"),
        account.planType ? account.planType.toUpperCase() : "未知"));
      tr.append(planTd);

      const statusTd = el("td");
      statusTd.append(el("span", "pill " + q.cls, q.statusLabel));
      tr.append(statusTd);

      const quotaTd = el("td", "quota-num", q.quotaCell);
      if (q.title) quotaTd.title = q.title;
      tr.append(quotaTd);

      const callsTd = el("td", "", (account.successCalls || 0) + " / " + (account.failCalls || 0));
      tr.append(callsTd);

      const checkedText = account.quotaCheckedAt
        ? formatTime(account.quotaCheckedAt, "")
        : (account.quotaError ? "查询失败" : "尚未检测");
      const checkedTd = el("td", "muted", checkedText);
      if (account.quotaError) checkedTd.title = account.quotaError;
      tr.append(checkedTd);

      const actTd = el("td");
      const btn = el("button", "btn secondary small", "检测额度");
      btn.type = "button";
      btn.disabled = poolBusy;
      btn.addEventListener("click", async () => {
        btn.textContent = "检测中…";
        await refreshAccounts({
          id: account.id,
          quotaOnly: true,
          force: account.tokenState !== "unexpired_unverified",
        });
      });
      actTd.append(btn);
      tr.append(actTd);

      rows.push(tr);
    }
    tbody.replaceChildren(...rows);
  }
  function renderPoolView(data) {
    $("poolCount").textContent = data.total;
    const summary = data.summary || { total: data.total, valid: 0, needsRenew: 0 };
    const qs = data.quotaStats || {};
    if (data.total) {
      const quotaSeg = qs.checked > 0
        ? ` · 生图可用 ${qs.active ?? 0} · 限流 ${qs.limited ?? 0} · 剩余额度 ${qs.totalQuota ?? 0}`
        : ` · 生图额度待检测`;
      const priorityCount = data.priorityCount ?? data.accounts.filter((a) => a.priority).length;
      const prioritySeg = priorityCount > 0
        ? ` · 优先号池 ${priorityCount}`
        : "";
      $("poolSummary").textContent =
        `共 ${summary.total} 个入池账号 · 有效 ${summary.valid} · 待续期/异常 ${summary.needsRenew}${prioritySeg}${quotaSeg}`;
    } else {
      $("poolSummary").textContent = "号池暂无账号 · 请先导入账号";
    }
    const list = $("poolList");
    list.replaceChildren();
    if (!data.accounts.length) {
      list.append(el("div", "empty", "独立号池暂无账号。请在「批量导入」进行网页登录授权或批量导入 TXT 账号。"));
      setPoolBusyState(poolBusy);
      return;
    }
    for (const account of data.accounts) {
      const item = el("div", "account-row" + (account.priority ? " is-priority" : ""));
      const left = el("div", "account-main");
      const head = el("div", "account-head");
      head.append(el("strong", "", account.slotLabel || account.email));
      if (account.priority) {
        head.append(el("span", "pill priority", "优先"));
      }
      if (account.authType === "oauth") {
        head.append(el("span", "pill oauth", "网页授权"));
      }
      // "待请求确认" is what the local JWT check can say on its own: not
      // expired, never seen by the upstream (credentials.mjs says as much).
      // Once a generation has gone through on this token, it has been
      // confirmed, so say so instead of leaving the badge waiting forever.
      const confirmed = account.tokenState === "unexpired_unverified" && (account.successCalls || 0) > 0;
      const badge = confirmed
        ? { cls: "good", text: `Token 已验证（成功 ${account.successCalls} 次）` }
        : poolTokenBadges[account.tokenState] || (account.hasAccess
          ? poolTokenBadges.unexpired_unverified
          : poolTokenBadges.missing);
      head.append(el("span", "pill " + badge.cls, badge.text));
      if (account.planType) {
        head.append(el("span", "pill plan", account.planType.toUpperCase()));
      }
      left.append(head);

      const q = quotaBadgeInfo(account);
      const usagePart = (account.successCalls || account.failCalls)
        ? `成功 ${account.successCalls || 0} / 失败 ${account.failCalls || 0}`
        : "";
      const resetPart = account.quotaResetAt ? formatTime(account.quotaResetAt, "预计恢复 ") : "";
      const checkedPart = account.quotaCheckedAt ? formatTime(account.quotaCheckedAt, "额度检测于 ") : "";
      const errPart = account.quotaError ? "额度错误：" + account.quotaError : "";
      const sub = [
        formatTime(account.updatedAt),
        checkedPart,
        resetPart,
        usagePart,
        errPart,
        rowMessages.get(account.id),
      ].filter(Boolean).join(" · ");
      left.append(el("small", "", sub || "已在 Providers 独立入驻 · 轮询与故障转移就绪 · Token 无明文显示"));
      item.append(left);

      const side = el("div", "account-side");
      const quotaPill = el("span", "quota-pill " + q.cls, q.pillText);
      if (q.title) quotaPill.title = q.title;
      side.append(quotaPill);

      const controls = el("div", "account-buttons");
      const priorityLabel = document.createElement("label");
      priorityLabel.className = "priority-switch";
      priorityLabel.title = "开启后该账号将加入优先号池，生图与对话请求会优先调度";
      const priorityInput = document.createElement("input");
      priorityInput.type = "checkbox";
      priorityInput.checked = account.priority === true;
      priorityInput.setAttribute("aria-label", "优先使用该账号");
      priorityInput.addEventListener("change", async () => {
        const nextPriority = priorityInput.checked;
        priorityLabel.classList.add("busy");
        priorityInput.disabled = true;
        try {
          await api("priority", { id: account.id, priority: nextPriority });
          await loadPool();
          notice(nextPriority ? "已开启优先使用，该账号已加入优先号池" : "已关闭优先使用，该账号已移出优先号池");
        } catch (err) {
          priorityInput.checked = !nextPriority;
          notice("更新优先状态失败：" + err.message, true);
        } finally {
          priorityLabel.classList.remove("busy");
          priorityInput.disabled = false;
        }
      });
      priorityLabel.append(
        priorityInput,
        el("span", "switch-track", ""),
        el("span", "switch-label", "优先使用"),
      );
      const refresh = el("button", "btn secondary small", "检测/刷新");
      refresh.type = "button";
      refresh.disabled = poolBusy || checkingRows.has(account.id);
      refresh.addEventListener("click", async () => {
        if (refresh.disabled) return;
        checkingRows.add(account.id);
        refresh.disabled = true;
        refresh.textContent = "处理中…";
        try {
          await refreshAccounts({ id: account.id, force: account.tokenState !== "unexpired_unverified" });
        } finally {
          checkingRows.delete(account.id);
          // The refresh's own loadPool renders while this row is still marked
          // busy; this one puts the buttons back the way they were.
          await loadPool();
        }
      });
      const remove = el("button", "btn secondary small", "移除");
      remove.type = "button";
      let confirming = false;
      remove.addEventListener("click", async () => {
        if (!confirming) {
          confirming = true;
          remove.classList.add("danger");
          remove.textContent = "确认移除";
          return;
        }
        remove.disabled = true;
        try {
          const removed = await api("remove", { id: account.id });
          rowMessages.delete(account.id);
          await loadPool();
          if (removed.connectionError)
            notice("账号已移除，但 Magpie 供应商状态同步失败", true);
          else if (removed.providerConnected === false)
            notice("最后一个账号已移除，GPT号池已自动断开");
          else
            notice("账号已从本地号池移除，其余账号将继续轮询工作");
        }
        catch (err) { notice(err.message, true); remove.disabled = false; }
      });
      controls.append(priorityLabel, refresh, remove);
      side.append(controls);
      item.append(side);
      list.append(item);
    }
    setPoolBusyState(poolBusy);
  }
  let poolSweepRefreshTimer = null;
  let lastPoolRefreshAt = 0;
  function scheduleSweepFollowup(sweepRunning) {
    if (poolSweepRefreshTimer) {
      clearTimeout(poolSweepRefreshTimer);
      poolSweepRefreshTimer = null;
    }
    if (sweepRunning && !poolBusy && !busy) {
      poolSweepRefreshTimer = setTimeout(() => {
        poolSweepRefreshTimer = null;
        void loadPool();
      }, 3000);
    }
  }
  async function loadPool() {
    lastPoolRefreshAt = Date.now();
    try {
      const data = await api("accounts");
      renderPoolView(data);
      renderStatsView(data);
      scheduleSweepFollowup(data.sweepRunning === true);
    } catch (err) {
      $("poolList").replaceChildren(el("p", "muted", "无法读取号池：" + err.message));
    }
  }
  async function loadStats() {
    try {
      const data = await api("stats");
      renderStatsView(data);
      renderPoolView({
        total: data.total,
        summary: {
          total: data.total,
          valid: (data.accounts || []).filter((a) => a.tokenState === "unexpired_unverified").length,
          needsRenew: (data.accounts || []).filter((a) => a.tokenState !== "unexpired_unverified").length,
        },
        quotaStats: data.quotaStats,
        accounts: data.accounts || [],
      });
    } catch (err) {
      $("statsMeta").textContent = "无法读取额度统计：" + err.message;
    }
  }
  function tab(next) {
    activeTab = next;
    document.querySelectorAll(".tab").forEach((button) => {
      const selected = button.dataset.tab === next;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    hidden("importPanel", next !== "import");
    hidden("poolPanel", next !== "pool");
    hidden("statsPanel", next !== "stats");
    hidden("policyPanel", next !== "policy");
    if (next === "pool") loadPool();
    if (next === "stats") loadStats();
    if (next === "policy") { loadPolicy(); loadLogs(); }
  }

  // --- rotation strategy + scheduled sweep -------------------------------
  let policyState = null;

  function renderStrategyCards(strategies, selected) {
    const host = $("strategyCards");
    host.replaceChildren(...strategies.map((strategy) => {
      const card = el("button", "strategy-card");
      card.type = "button";
      card.dataset.strategy = strategy.id;
      card.setAttribute("role", "radio");
      const isOn = strategy.id === selected;
      card.classList.toggle("selected", isOn);
      card.setAttribute("aria-checked", isOn ? "true" : "false");
      const title = el("div", "strategy-name");
      title.append(el("span", "tick", "✓"), el("span", "", strategy.name));
      card.append(title, el("div", "strategy-detail", strategy.detail));
      card.addEventListener("click", () => {
        host.querySelectorAll(".strategy-card").forEach((node) => {
          const on = node === card;
          node.classList.toggle("selected", on);
          node.setAttribute("aria-checked", on ? "true" : "false");
        });
        if (policyState) policyState.settings.rotation.strategy = strategy.id;
      });
      return card;
    }));
  }

  function sweepHintText(settings, sweep) {
    const parts = [];
    parts.push(sweep?.running ? "巡检正在运行…" : "巡检空闲");
    if (!settings.sweep.enabled) parts.push("已关闭定时巡检");
    else if (settings.sweep.intervalMinutes === 0) parts.push("只在插件启动时跑一次");
    else parts.push(`每 ${settings.sweep.intervalMinutes} 分钟检查一次`);
    parts.push(`跳过 ${settings.sweep.staleAfterMinutes} 分钟内已检测过的账号`);
    return parts.join(" · ");
  }

  function applyPolicyToForm(data) {
    policyState = data;
    const settings = data.settings;
    renderStrategyCards(data.strategies || [], settings.rotation.strategy);
    $("skipRateLimited").checked = settings.rotation.skipRateLimited;
    $("respectPreferredSlot").checked = settings.rotation.respectPreferredSlot;
    $("sweepEnabled").checked = settings.sweep.enabled;
    $("sweepPauseDuringImport").checked = settings.sweep.pauseDuringImport;
    $("sweepInterval").value = String(settings.sweep.intervalMinutes);
    $("sweepStale").value = String(settings.sweep.staleAfterMinutes);
    $("sweepHint").textContent = sweepHintText(settings, data.sweep);
    const strategy = (data.strategies || []).find((s) => s.id === settings.rotation.strategy);
    $("policyHint").textContent = strategy
      ? `当前生效：${strategy.name}。${settings.rotation.skipRateLimited ? "限流账号自动排到队尾。" : "注意：已关闭跳过限流账号，耗尽额度的账号仍可能被尝试。"}`
      : "";
  }

  async function loadPolicy() {
    try {
      applyPolicyToForm(await api("settings"));
    } catch (err) {
      $("policyHint").textContent = "无法读取策略设置：" + err.message;
    }
  }

  async function savePolicy() {
    if (!policyState) return;
    const next = {
      rotation: {
        strategy: policyState.settings.rotation.strategy,
        skipRateLimited: $("skipRateLimited").checked,
        respectPreferredSlot: $("respectPreferredSlot").checked,
      },
      sweep: {
        enabled: $("sweepEnabled").checked,
        pauseDuringImport: $("sweepPauseDuringImport").checked,
        intervalMinutes: Number($("sweepInterval").value),
        staleAfterMinutes: Number($("sweepStale").value),
      },
    };
    try {
      setPolicyBusy(true);
      const saved = await api("settings", next);
      applyPolicyToForm(saved);
      notice("策略已保存，下一次生图请求即按新策略调度。");
    } catch (err) {
      notice("保存失败：" + err.message, true);
    } finally {
      setPolicyBusy(false);
    }
  }

  function setPolicyBusy(next) {
    $("savePolicy").disabled = next;
    $("runSweep").disabled = next;
    $("savePolicy").textContent = next ? "保存中…" : "保存策略";
  }

  async function runSweepNow() {
    try {
      setPolicyBusy(true);
      $("sweepHint").textContent = "正在巡检全部账号额度…";
      const summary = await api("sweep/run", {});
      await loadPolicy();
      await loadLogs();
      notice(summary.aborted
        ? "巡检已中止（批量导入进行中或服务已停止）。"
        : `巡检完成：检查 ${summary.checked} 个，正常 ${summary.ok || 0}，` +
          `限流 ${summary.rateLimited || 0}，失败 ${summary.failed || 0}，跳过 ${summary.skipped || 0}。`);
    } catch (err) {
      notice("巡检失败：" + err.message, true);
      $("sweepHint").textContent = "";
    } finally {
      setPolicyBusy(false);
    }
  }

  // --- event log ---------------------------------------------------------
  function formatEventTime(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "--:--:--";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:` +
      `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function describeEvent(event) {
    if (event.event === "quota_sweep" || event.event === "quota_sweep_done") {
      const bits = [];
      if (event.event === "quota_sweep_done") {
        bits.push(`巡检结束`);
        if (event.checked !== undefined) bits.push(`检查 ${event.checked}`);
        if (event.ok !== undefined) bits.push(`正常 ${event.ok}`);
        if (event.rateLimited !== undefined) bits.push(`限流 ${event.rateLimited}`);
        if (event.failed !== undefined) bits.push(`失败 ${event.failed}`);
        if (event.skipped !== undefined) bits.push(`跳过 ${event.skipped}`);
      } else {
        bits.push("巡检单个账号失败");
        if (event.reason) bits.push(event.reason);
      }
      return { level: event.ok === false ? "fail" : "ok", text: bits.join(" · ") };
    }
    const bits = [];
    if (event.ok === true) bits.push("成功");
    else if (event.rateLimited === true) bits.push("额度耗尽");
    else if (event.status) bits.push("失败");
    else bits.push(event.ok === false ? "失败" : "—");
    if (event.status) bits.push(`HTTP ${event.status}`);
    if (event.retryAfter) {
      const minutes = Math.round(Number(event.retryAfter) / 60);
      bits.push(`冷却 ${minutes >= 60 ? Math.round(minutes / 60) + " 小时" : minutes + " 分钟"}`);
    }
    if (event.code) bits.push(event.code);
    if (event.tried !== undefined) bits.push(`候选 ${event.tried} 个`);
    const level = event.ok === true ? "ok" : (event.rateLimited === true ? "warn" : "fail");
    return { level, text: bits.join(" · ") };
  }

  function renderLogs(events) {
    const host = $("logView");
    const onlyFailures = $("logOnlyFailures").checked;
    const rows = (events || []).filter((event) =>
      !onlyFailures || event.ok === false || event.rateLimited === true || event.event === "quota_sweep");
    if (!rows.length) {
      host.replaceChildren(el("div", "log-empty",
        onlyFailures ? "没有失败记录 —— 账号一直都能正常出图。" : "还没有日志；发生一次生图或巡检后就会出现。"));
      return;
    }
    host.replaceChildren(...rows.slice().reverse().map((event) => {
      const info = describeEvent(event);
      const row = el("div", "log-row");
      const slot = event.slot ? ` ${event.slot}` : "";
      row.append(
        el("span", "log-time", formatEventTime(event.t)),
        el("span", "log-slot", (event.event === "image_call" ? "生图" : "巡检") + slot),
        el("span", "log-" + info.level, info.text),
      );
      return row;
    }));
  }

  async function loadLogs() {
    try {
      const limit = $("logLimit").value || "100";
      const data = await api("logs?limit=" + encodeURIComponent(limit));
      renderLogs(data.events);
    } catch (err) {
      $("logView").replaceChildren(el("div", "log-empty", "无法读取日志：" + err.message));
    }
  }

  function setup() {
    // Always shown INSIDE Magpie's plugin frame. Choosing a file loads its
    // contents directly into #pasteAccounts so errors can be edited in place.
    document.querySelectorAll(".tab").forEach((button) =>
      button.addEventListener("click", () => tab(button.dataset.tab)));
    $("goImport").addEventListener("click", () => {
      tab("import");
      $("pasteAccounts").focus();
    });
    $("checkPaste").addEventListener("click", async () => {
      if (busy) return;
      await previewText($("pasteAccounts").value, "文本框内容");
    });
    $("clearPaste").addEventListener("click", () => {
      if (busy) return;
      $("pasteAccounts").value = "";
      preview = null;
      previewSource = "";
      jobStates.clear();
      hidden("previewBox", true);
      $("fileName").textContent = "文件内容会直接填入下方文本框；若某行格式不对可直接改好后再导入";
      updateLineCounter();
      setBusy(false);
      notice("已清空输入框");
    });
    $("pasteAccounts").addEventListener("input", () => {
      if (!$("pasteAccounts").value.trim()) {
        preview = null;
        previewSource = "";
        hidden("previewBox", true);
      }
      updateLineCounter();
      setBusy(busy);
    });
    $("skipInvalid").addEventListener("change", () => setBusy(busy));
    $("proxyInput").addEventListener("input", () => {
      const val = $("proxyInput").value;
      $("poolProxyInput").value = val;
      if ($("statsProxyInput")) $("statsProxyInput").value = val;
    });
    $("poolProxyInput").addEventListener("input", () => {
      const val = $("poolProxyInput").value;
      $("proxyInput").value = val;
      if ($("statsProxyInput")) $("statsProxyInput").value = val;
    });
    $("statsProxyInput")?.addEventListener("input", () => {
      const val = $("statsProxyInput").value;
      $("proxyInput").value = val;
      $("poolProxyInput").value = val;
    });
    $("selectFile").addEventListener("click", (event) => {
      event.stopPropagation(); $("fileInput").click();
    });
    $("dropzone").addEventListener("click", (event) => {
      if (!busy && event.target !== $("selectFile")) $("fileInput").click();
    });
    $("dropzone").addEventListener("keydown", (event) => {
      if (!busy && ["Enter", " "].includes(event.key)) { event.preventDefault(); $("fileInput").click(); }
    });
    $("fileInput").addEventListener("change", (event) => {
      loadText(event.target.files?.[0]);
      event.target.value = "";
    });
    $("dropzone").addEventListener("dragover", (event) => {
      event.preventDefault(); $("dropzone").classList.add("dragging");
    });
    $("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
    $("dropzone").addEventListener("drop", (event) => {
      event.preventDefault(); $("dropzone").classList.remove("dragging");
      loadText(event.dataTransfer?.files?.[0]);
    });
    $("consent").addEventListener("change", () => setBusy(busy));
    $("startButton").addEventListener("click", begin);
    $("cancelButton").addEventListener("click", cancel);
    $("againButton").addEventListener("click", () => {
      stopPolling(); preview = null; previewSource = ""; jobStates.clear();
      hidden("previewBox", true); hidden("progressBox", true);
      $("fileName").textContent = "文件内容会直接填入下方文本框；若某行格式不对可直接改好后再导入";
      $("pasteAccounts").value = "";
      updateLineCounter();
      $("cancelButton").textContent = "停止导入"; $("cancelButton").disabled = false;
      setBusy(false);
      $("pasteAccounts").focus();
      notice("文本框已清空，可以继续批量追加下一批账号到同一个号池");
    });
    $("refreshAccounts").addEventListener("click", loadPool);
    $("refreshAllPool").addEventListener("click", () => refreshAccounts({ all: true }));
    $("syncProviders")?.addEventListener("click", syncProvidersNow);
    $("refreshStatsQuota")?.addEventListener("click", () => refreshAccounts({ all: true, quotaOnly: true }));
    $("reloadStats")?.addEventListener("click", loadStats);
    $("savePolicy")?.addEventListener("click", savePolicy);
    $("runSweep")?.addEventListener("click", runSweepNow);
    $("reloadLogs")?.addEventListener("click", loadLogs);
    $("logOnlyFailures")?.addEventListener("change", loadLogs);
    $("logLimit")?.addEventListener("change", loadLogs);

    // --- web OAuth sign-in -------------------------------------------------
    let oauthPollTimer = null;
    let lastDoneOAuthId = "";
    function stopOAuthPoll() {
      if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
    }
    function showOAuthResult(kind, text, showPoolBtn = false) {
      const box = $("oauthResult");
      if (!box) return;
      box.className = "oauth-result " + (kind === "ok" ? "ok" : "fail");
      if ($("oauthResultText")) $("oauthResultText").textContent = text;
      hidden("oauthResult", false);
      hidden("oauthViewPool", !showPoolBtn);
    }
    function renderOAuthState(st) {
      if (!st || st.state === "idle" || st.state === "canceled") {
        stopOAuthPoll();
        hidden("oauthBox", true);
        hidden("oauthResult", true);
        hidden("oauthWaitingArea", false);
        if ($("oauthStart")) { $("oauthStart").disabled = false; $("oauthStart").textContent = "生成授权链接"; }
        return;
      }
      hidden("oauthBox", false);
      if (st.url && $("oauthUrlInput")) $("oauthUrlInput").value = st.url;
      const statusEl = $("oauthStatus");
      if (st.state === "waiting") {
        hidden("oauthWaitingArea", false);
        hidden("oauthResult", true);
        if ($("oauthStart")) { $("oauthStart").disabled = false; $("oauthStart").textContent = "重新生成链接"; }
        if (statusEl) {
          statusEl.textContent = st.callbackListening
            ? "等待浏览器完成授权（本地回调 127.0.0.1:1455 已就绪；也可以复制链接到任意浏览器登录）…"
            : "提示：1455 端口被占用或保留。请打开或复制上方链接在浏览器登录后，将跳转后的完整地址粘贴到下方提交。";
        }
      } else if (st.state === "exchanging") {
        hidden("oauthWaitingArea", false);
        hidden("oauthResult", true);
        if (statusEl) statusEl.textContent = "已收到授权回调，正在换取令牌、检测剩余生图额度并入池…";
      } else if (st.state === "done") {
        stopOAuthPoll();
        hidden("oauthWaitingArea", true);
        if ($("oauthStart")) { $("oauthStart").disabled = false; $("oauthStart").textContent = "继续授权下一个号"; }
        if ($("oauthCallbackInput")) $("oauthCallbackInput").value = "";
        const planSeg = st.planType ? ` · ${String(st.planType).toUpperCase()}` : "";
        const quotaSeg = typeof st.imageQuota === "number"
          ? ` · 剩余生图额度 ${st.imageQuota}`
          : (st.quotaChecked ? " · 额度已同步" : "");
        const msg = `✓ 网页授权成功：${st.accountLabel || "新账号"}${planSeg}${quotaSeg}，已入池并同步到 Providers`;
        showOAuthResult("ok", msg, true);
        if (st.id !== lastDoneOAuthId) {
          lastDoneOAuthId = st.id || "done";
          notice(msg);
          void loadPool();
        }
      } else if (st.state === "failed") {
        stopOAuthPoll();
        hidden("oauthWaitingArea", false);
        if ($("oauthStart")) { $("oauthStart").disabled = false; $("oauthStart").textContent = "重新生成链接"; }
        const msg = "授权失败：" + (st.error || "请重新生成授权链接重试");
        if (statusEl) statusEl.textContent = msg;
        showOAuthResult("fail", msg, false);
        notice("网页" + msg, true);
      }
    }
    async function pollOAuthStatus() {
      try {
        const st = await api("oauth/status");
        renderOAuthState(st);
      } catch {}
    }
    async function startWebOAuth() {
      const btn = $("oauthStart");
      if (btn) { btn.disabled = true; btn.textContent = "正在生成…"; }
      hidden("oauthResult", true);
      try {
        const proxy = ($("proxyInput")?.value || $("poolProxyInput")?.value || "").trim();
        const st = await api("oauth/start", { proxy });
        renderOAuthState(st);
        stopOAuthPoll();
        oauthPollTimer = setInterval(() => { void pollOAuthStatus(); }, 1200);
        notice("已生成网页授权链接：可点击「打开网页授权」或「复制链接」到浏览器登录");
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = "生成授权链接"; }
        showOAuthResult("fail", "无法生成授权链接：" + err.message, false);
        notice("无法生成授权链接：" + err.message, true);
      }
    }
    $("oauthStart")?.addEventListener("click", startWebOAuth);
    $("oauthViewPool")?.addEventListener("click", () => {
      tab("pool");
    });
    $("goOAuth")?.addEventListener("click", () => {
      tab("import");
      $("oauthCard")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      void startWebOAuth();
    });
    $("oauthOpen")?.addEventListener("click", async () => {
      try {
        await api("oauth/open", {});
        notice("已在系统浏览器中打开授权页面");
      } catch (err) {
        const url = $("oauthUrlInput")?.value || "";
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        notice("请在新打开的页面授权，或点「复制链接」手动打开：" + err.message, true);
      }
    });
    $("oauthCopy")?.addEventListener("click", async () => {
      const url = $("oauthUrlInput")?.value || "";
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        notice("授权链接已复制到剪贴板，可粘贴到任意浏览器或无痕窗口完成登录");
      } catch {
        $("oauthUrlInput").focus();
        $("oauthUrlInput").select();
        document.execCommand?.("copy");
        notice("已选中授权链接，请按 Ctrl+C 复制到浏览器打开");
      }
    });
    $("oauthSubmitCallback")?.addEventListener("click", async () => {
      const raw = ($("oauthCallbackInput")?.value || "").trim();
      if (!raw) {
        showOAuthResult("fail", "请先粘贴浏览器跳转后的回调链接或授权码", false);
        return;
      }
      const btn = $("oauthSubmitCallback");
      if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
      hidden("oauthResult", true);
      if ($("oauthStatus")) $("oauthStatus").textContent = "正在提交回调、换取令牌并检测剩余生图额度…";
      try {
        const res = await api("oauth/callback", { callbackUrl: raw });
        renderOAuthState(res);
      } catch (err) {
        showOAuthResult("fail", "回调提交失败：" + err.message, false);
        notice("回调提交失败：" + err.message, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "提交回调"; }
      }
    });
    $("oauthCancel")?.addEventListener("click", async () => {
      stopOAuthPoll();
      try { await api("oauth/cancel", {}); } catch {}
      renderOAuthState({ state: "canceled" });
      notice("已取消网页授权");
    });
    $("copyLogs")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("logView").innerText);
        notice("日志已复制到剪贴板。");
      } catch {
        notice("复制失败；请手动选中日志文本。", true);
      }
    });
    function refreshOnReturn() {
      loadPendingDraft();
      if (oauthPollTimer) void pollOAuthStatus();
      if (!busy && !poolBusy && Date.now() - lastPoolRefreshAt > 2500) {
        void loadPool();
      }
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshOnReturn();
    });
    window.addEventListener("message", (ev) => {
      if (ev.data?.magpie !== 1) return;
      if (ev.data?.event === "visibility" && ev.data?.data?.visible === true) {
        refreshOnReturn();
        return;
      }
      if (ev.data?.event === "action") {
        const id = ev.data?.data?.id;
        if (id === "manage-pool") tab("pool");
        else if (id === "stats") tab("stats");
        else if (id === "batch-import") {
          tab("import");
          loadPendingDraft();
          $("pasteAccounts").focus();
        }
      }
    });
    if (location.hash === "#action=manage-pool") tab("pool");
    else if (location.hash === "#action=stats") tab("stats");
    else if (location.hash === "#action=batch-import") $("pasteAccounts").focus();
    updateLineCounter();
    setBusy(false);
    loadPendingDraft();
    loadPool();
    status();
  }
  setup();
})();
