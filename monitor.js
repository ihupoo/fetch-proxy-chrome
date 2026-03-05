/* ───── DOM References ───── */
const $ = (id) => document.getElementById(id);

const tabIdTextEl = $("tabIdText");
const tabHostTextEl = $("tabHostText");
const toggleEnabledEl = $("toggleEnabled");
const proxyStatusEl = $("proxyStatus");
const proxyLabelEl = $("proxyLabel");
const modeQuickBtn = $("modeQuickBtn");
const modeFullBtn = $("modeFullBtn");
const searchInputEl = $("searchInput");
const logListEl = $("logList");
const logCountEl = $("logCount");
const clearLogsBtnEl = $("clearLogsBtn");
const refreshBtnEl = $("refreshBtn");
const flashContainerEl = $("flashContainer");

const tabHttpBtn = $("tabHttpBtn");
const tabWsBtn = $("tabWsBtn");
const tabDetailBtn = $("tabDetailBtn");
const panelHttp = $("panelHttp");
const panelWs = $("panelWs");
const panelDetail = $("panelDetail");
const detailTitleEl = $("detailTitle");
const detailBodyEl = $("detailBody");

const httpRuleFormCard = $("httpRuleFormCard");
const httpRuleFormEl = $("httpRuleForm");
const httpFormTitle = $("httpFormTitle");
const httpFormCloseBtn = $("httpFormCloseBtn");
const httpFormCancelBtn = $("httpFormCancelBtn");
const addHttpRuleBtnEl = $("addHttpRuleBtn");
const httpRulesListEl = $("httpRulesList");
const httpStageSelectEl = $("httpStageSelect");
const httpOperationSelectEl = $("httpOperationSelect");
const httpOperationLabelEl = $("httpOperationLabel");
const httpReplaceRowEl = $("httpReplaceRow");
const httpResponseBodyLabelEl = $("httpResponseBodyLabel");
const httpStatusRowEl = $("httpStatusRow");
const httpResponseModeRowEl = $("httpResponseModeRow");
const httpResponseModeSelectEl = $("httpResponseModeSelect");
const mockSyntaxHelpBtnEl = $("mockSyntaxHelpBtn");
const mockSyntaxModalEl = $("mockSyntaxModal");
const mockSyntaxModalCloseBtnEl = $("mockSyntaxModalCloseBtn");
const replaceHelpBtnEl = $("replaceHelpBtn");
const replaceHelpModalEl = $("replaceHelpModal");
const replaceHelpModalCloseBtnEl = $("replaceHelpModalCloseBtn");
const wsRuleHelpBtnEl = $("wsRuleHelpBtn");
const wsRuleHelpModalEl = $("wsRuleHelpModal");
const wsRuleHelpModalCloseBtnEl = $("wsRuleHelpModalCloseBtn");

const wsRuleFormCard = $("wsRuleFormCard");
const wsRuleFormEl = $("wsRuleForm");
const wsFormTitle = $("wsFormTitle");
const wsFormCloseBtn = $("wsFormCloseBtn");
const wsFormCancelBtn = $("wsFormCancelBtn");
const addWsRuleBtnEl = $("addWsRuleBtn");
const wsRulesListEl = $("wsRulesList");
const wsSendFormEl = $("wsSendForm");
const wsSendUrlPatternEl = $("wsSendUrlPattern");
const wsSendPayloadEl = $("wsSendPayload");
const wsSendCardEl = $("wsSendCard");

const statusDotEl = $("statusDot");
const footerStatusEl = $("footerStatus");
const footerStatsEl = $("footerStats");

const filterPills = document.querySelectorAll(".filter-pill");

/* ───── State ───── */
const queryTabId = Number(new URLSearchParams(window.location.search).get("tabId"));
let tabId = Number.isInteger(queryTabId) && queryTabId > 0 ? queryTabId : null;
let selectedMode = "quick";
let currentStatus = { mode: "off", enabled: false, preferredMode: "quick", quickSummary: null };
let searchKeyword = "";
let activeFilter = "all";
let activeTab = "http";
let httpRules = [];
let wsRules = [];
let selectedLogId = null;
let editingHttpRuleId = null;
let editingWsRuleId = null;
let expandedWsMsgIdx = null; /* index of expanded message in WS detail */

const logMap = new Map();
let displayLogs = [];
let displayMap = new Map();
let logsTimer = null;
let statusTimer = null;

/* ───── Init ───── */
init().catch((error) => flash(error.message || String(error), "error"));

async function init() {
  if (!tabId) throw new Error("缺少 tabId，请从插件 popup 点击「打开监控面板」");

  tabIdTextEl.textContent = String(tabId);
  bindEvents();

  await refreshAll();

  logsTimer = setInterval(() => void refreshLogs(), 1200);
  statusTimer = setInterval(() => void refreshStatus(), 2600);
  window.addEventListener("beforeunload", () => { clearInterval(logsTimer); clearInterval(statusTimer); });
}

/* ───── Events ───── */
function bindEvents() {
  toggleEnabledEl.addEventListener("change", async () => {
    toggleEnabledEl.disabled = true;
    try {
      const result = await sendMessage({ action: "setTabMode", tabId, mode: toggleEnabledEl.checked ? selectedMode : "off" });
      applyStatus(result);
      flash(result.enabled ? `${getModeLabel(result.mode)}已开启` : "代理已关闭", "success");
    } catch (error) {
      toggleEnabledEl.checked = !toggleEnabledEl.checked;
      flash(error.message || String(error), "error");
    } finally {
      toggleEnabledEl.disabled = false;
    }
  });

  modeQuickBtn.addEventListener("click", () => switchMode("quick"));
  modeFullBtn.addEventListener("click", () => switchMode("full"));

  searchInputEl.addEventListener("input", () => { searchKeyword = searchInputEl.value.trim(); void refreshLogs(); });

  filterPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      filterPills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      activeFilter = pill.dataset.filter;
      renderLogList();
    });
  });

  clearLogsBtnEl.addEventListener("click", async () => {
    try {
      await sendMessage({ action: "clearLogs", tabId });
      logMap.clear(); selectedLogId = null;
      renderLogList(); showDetail(null);
      flash("日志已清空", "success");
    } catch (error) { flash(error.message, "error"); }
  });

  refreshBtnEl.addEventListener("click", () => void refreshAll());

  tabHttpBtn.addEventListener("click", () => switchTab("http"));
  tabWsBtn.addEventListener("click", () => switchTab("ws"));
  tabDetailBtn.addEventListener("click", () => switchTab("detail"));

  logListEl.addEventListener("click", (e) => {
    const fillBtn = e.target.closest("[data-action='fill-rule']");
    if (fillBtn) {
      e.stopPropagation();
      const log = displayMap.get(fillBtn.dataset.logId || "");
      if (log) fillRuleFromLog(log);
      return;
    }

    const item = e.target.closest(".log-item");
    if (!item) return;
    selectedLogId = item.dataset.logId;
    renderLogList();
    const log = displayMap.get(selectedLogId);
    if (log) { showDetail(log); switchTab("detail"); }
  });

  /* HTTP Rule Form */
  addHttpRuleBtnEl.addEventListener("click", () => showHttpRuleForm(null));
  httpFormCloseBtn.addEventListener("click", hideHttpRuleForm);
  httpFormCancelBtn.addEventListener("click", hideHttpRuleForm);
  httpStageSelectEl.addEventListener("change", syncHttpFormVisibility);
  httpOperationSelectEl.addEventListener("change", syncHttpFormVisibility);
  httpResponseModeSelectEl?.addEventListener("change", syncHttpFormVisibility);
  httpRuleFormEl?.elements?.namedItem("contentType")?.addEventListener?.("input", syncHttpFormVisibility);
  mockSyntaxHelpBtnEl?.addEventListener("click", openMockSyntaxModal);
  mockSyntaxModalCloseBtnEl?.addEventListener("click", closeMockSyntaxModal);
  mockSyntaxModalEl?.addEventListener("click", (e) => {
    if (e.target === mockSyntaxModalEl) closeMockSyntaxModal();
  });
  replaceHelpBtnEl?.addEventListener("click", openReplaceHelpModal);
  replaceHelpModalCloseBtnEl?.addEventListener("click", closeReplaceHelpModal);
  replaceHelpModalEl?.addEventListener("click", (e) => {
    if (e.target === replaceHelpModalEl) closeReplaceHelpModal();
  });
  wsRuleHelpBtnEl?.addEventListener("click", openWsRuleHelpModal);
  wsRuleHelpModalCloseBtnEl?.addEventListener("click", closeWsRuleHelpModal);
  wsRuleHelpModalEl?.addEventListener("click", (e) => {
    if (e.target === wsRuleHelpModalEl) closeWsRuleHelpModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !mockSyntaxModalEl?.classList.contains("hidden")) {
      closeMockSyntaxModal();
      return;
    }
    if (e.key === "Escape" && !replaceHelpModalEl?.classList.contains("hidden")) {
      closeReplaceHelpModal();
      return;
    }
    if (e.key === "Escape" && !wsRuleHelpModalEl?.classList.contains("hidden")) {
      closeWsRuleHelpModal();
    }
  });

  httpRuleFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(httpRuleFormEl);
    const stage = String(fd.get("stage") || "request");
    const operation = stage === "request" ? "fulfill" : String(fd.get("operation") || "fulfill");
    const rule = {
      id: fd.get("id") || undefined,
      name: String(fd.get("name") || "http-rule").trim(),
      urlPattern: String(fd.get("urlPattern") || "").trim(),
      stage,
      operation,
      statusCode: Number(fd.get("statusCode") || 200),
      contentType: String(fd.get("contentType") || "application/json; charset=utf-8"),
      responseMode: String(fd.get("responseMode") || "plain") === "mock" ? "mock" : "plain",
      responseBody: String(fd.get("responseBody") || ""),
      replaceFrom: String(fd.get("replaceFrom") || ""),
      replaceTo: String(fd.get("replaceTo") || "")
    };

    try {
      const action = editingHttpRuleId ? "updateHttpRule" : "addHttpRule";
      await sendMessage({ action, rule });
      await refreshRules();
      hideHttpRuleForm();
      flash(editingHttpRuleId ? "HTTP 规则已更新" : "HTTP 规则已添加", "success");
    } catch (error) { flash(error.message, "error"); }
  });

  httpRulesListEl.addEventListener("click", handleHttpRuleAction);

  /* WS Rule Form */
  addWsRuleBtnEl.addEventListener("click", () => showWsRuleForm(null));
  wsFormCloseBtn.addEventListener("click", hideWsRuleForm);
  wsFormCancelBtn.addEventListener("click", hideWsRuleForm);

  wsRuleFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(wsRuleFormEl);
    const rule = {
      id: fd.get("id") || undefined,
      name: String(fd.get("name") || "ws-rule").trim(),
      urlPattern: String(fd.get("urlPattern") || "").trim(),
      outgoingFind: String(fd.get("outgoingFind") || ""),
      outgoingReplace: String(fd.get("outgoingReplace") || ""),
      incomingFind: String(fd.get("incomingFind") || ""),
      incomingReplace: String(fd.get("incomingReplace") || "")
    };

    try {
      const action = editingWsRuleId ? "updateWsRule" : "addWsRule";
      await sendMessage({ action, rule });
      await refreshRules();
      hideWsRuleForm();
      flash(editingWsRuleId ? "WS 规则已更新" : "WS 规则已添加", "success");
    } catch (error) { flash(error.message, "error"); }
  });

  wsRulesListEl.addEventListener("click", handleWsRuleAction);

  /* WS Send */
  wsSendFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitMode = e.submitter?.dataset?.wsSubmitMode === "mock-incoming" ? "mock-incoming" : "send";
    const data = String(wsSendPayloadEl.value || "").trim();
    if (!data) { flash("请输入要发送的内容", "error"); return; }
    try {
      const result = await sendMessage({
        action: submitMode === "mock-incoming" ? "wsMockIncomingMessage" : "wsSendMessage", tabId,
        urlPattern: String(wsSendUrlPatternEl.value || "").trim(), data
      });
      flash(
        `${submitMode === "mock-incoming" ? "已模拟服务端下发" : "WS 已发送"}${result?.url ? ` -> ${result.url}` : ""}`,
        "success"
      );
      wsSendPayloadEl.value = "";
      await refreshLogs();
    } catch (error) { flash(error.message, "error"); }
  });

  /* Detail section collapse */
  detailBodyEl.addEventListener("click", (e) => {
    /* WS 消息行点击展开/收起 */
    const msgRow = e.target.closest(".ws-msg-row");
    if (msgRow) {
      const idx = Number(msgRow.dataset.wsMsgIdx);
      expandedWsMsgIdx = expandedWsMsgIdx === idx ? null : idx;
      /* 刷新当前选中的 WS 详情 */
      if (selectedLogId) {
        const selectedItem = displayMap.get(selectedLogId);
        if (selectedItem && selectedItem._wsMerged) {
          refreshWsDetail(selectedItem);
        }
      }
      return;
    }

    const title = e.target.closest(".detail-section-title");
    if (!title) return;
    const section = title.closest(".detail-section");
    if (section) section.classList.toggle("collapsed");
  });
}

/* ───── Mode Switching ───── */
async function switchMode(mode) {
  selectedMode = mode;
  renderModeButtons();
  if (!toggleEnabledEl.checked) {
    /* 代理关闭时也更新 WS tab 可见性 */
    const isQuick = selectedMode === "quick";
    tabWsBtn.style.display = isQuick ? "none" : "";
    if (isQuick && activeTab === "ws") switchTab("http");
    return;
  }
  try {
    const result = await sendMessage({ action: "setTabMode", tabId, mode: selectedMode });
    applyStatus(result);
    flash(`${getModeLabel(result.mode)}已开启`, "success");
  } catch (error) { flash(error.message, "error"); }
}

function renderModeButtons() {
  modeQuickBtn.classList.toggle("active", selectedMode === "quick");
  modeFullBtn.classList.toggle("active", selectedMode === "full");
}

/* ───── Tab Switching ───── */
function switchTab(tab) {
  activeTab = tab;
  [tabHttpBtn, tabWsBtn, tabDetailBtn].forEach((btn) => btn.classList.remove("active"));
  [panelHttp, panelWs, panelDetail].forEach((p) => p.classList.remove("active"));
  if (tab === "http") { tabHttpBtn.classList.add("active"); panelHttp.classList.add("active"); }
  else if (tab === "ws") { tabWsBtn.classList.add("active"); panelWs.classList.add("active"); }
  else { tabDetailBtn.classList.add("active"); panelDetail.classList.add("active"); }
}

/* ───── Data Refresh ───── */
async function refreshAll() {
  await refreshTabInfo();
  await refreshStatus();
  await refreshRules();
  await refreshLogs();
}

async function refreshTabInfo() {
  try {
    const data = await sendMessage({ action: "getTabInfo", tabId });
    tabHostTextEl.textContent = data.host || "(无域名)";
  } catch {}
}

async function refreshStatus() {
  try {
    const data = await sendMessage({ action: "getTabStatus", tabId });
    applyStatus(data);
  } catch {}
}

async function refreshLogs() {
  try {
    const data = await sendMessage({ action: "getLogs", tabId, search: searchKeyword, limit: 900 });
    const logs = Array.isArray(data.logs) ? data.logs : [];
    logMap.clear();
    for (const item of logs) logMap.set(String(item.id || ""), item);
    renderLogList();
  } catch {}
}

async function refreshRules() {
  try {
    const data = await sendMessage({ action: "listRules" });
    httpRules = Array.isArray(data.httpRules) ? data.httpRules : [];
    wsRules = Array.isArray(data.wsRules) ? data.wsRules : [];
    renderHttpRules();
    renderWsRules();
  } catch {}
}

/* ───── Apply Status ───── */
function applyStatus(status) {
  currentStatus = { ...currentStatus, ...status };
  const activeMode = status.mode === "quick" ? "quick" : status.mode === "full" ? "full" : "off";
  /* Fix: when enabled, use actual mode; when off, keep user's last selection */
  if (status.enabled && activeMode !== "off") {
    selectedMode = activeMode;
  } else if (!status.enabled) {
    /* 保留用户在前端的选择，不被后端 preferredMode 覆盖 */
  }

  toggleEnabledEl.checked = Boolean(status.enabled);
  renderModeButtons();

  proxyStatusEl.textContent = status.enabled ? "ON" : "OFF";
  proxyStatusEl.className = `proxy-status ${status.enabled ? "on" : "off"}`;
  statusDotEl.className = `status-dot ${status.enabled ? "" : "off"}`;
  footerStatusEl.textContent = status.enabled ? `${getModeLabel(activeMode)}运行中` : "代理已关闭";

  const isQuick = (status.enabled ? status.mode : selectedMode) === "quick";
  tabWsBtn.style.display = isQuick ? "none" : "";
  if (isQuick && activeTab === "ws") switchTab("http");
}

/* ═════════════════════════════════════════════════
   Log Merging - 将同一请求的多条日志合并为一条
   ═════════════════════════════════════════════════ */

function buildMergedLogs() {
  const allLogs = [...logMap.values()]; // newest first

  /* 1. 分组：有 requestId 且属于 HTTP 类的日志按 requestId 合并 */
  const httpGroups = new Map();
  /* WS 日志按连接维度合并：debugger ws 用 requestId，inpage ws-live 用 url+socketId */
  const wsGroups = new Map();
  const result = [];
  const seenRequestIds = new Set();
  const seenWsKeys = new Set();

  for (const log of allLogs) {
    const rid = log.requestId;
    const kind = String(log.kind || "");

    /* WS 合并分组 */
    if (isWsLog(log)) {
      const key = getWsGroupKey(log);
      if (key) {
        if (!wsGroups.has(key)) wsGroups.set(key, []);
        wsGroups.get(key).push(log);
      }
      continue;
    }

    /* HTTP 合并分组 */
    if (rid && isMergeableLog(log)) {
      if (!httpGroups.has(rid)) httpGroups.set(rid, []);
      httpGroups.get(rid).push(log);
    }
  }

  /* 合并 HTTP groups */
  const mergedHttpMap = new Map();
  for (const [rid, phases] of httpGroups) {
    mergedHttpMap.set(rid, createMergedEntry(rid, phases));
  }

  /* 合并 WS groups */
  const mergedWsMap = new Map();
  for (const [key, phases] of wsGroups) {
    mergedWsMap.set(key, createWsMergedEntry(key, phases));
  }

  /* 2. 按原始顺序重建列表 */
  for (const log of allLogs) {
    const kind = String(log.kind || "");
    const rid = log.requestId;

    if (isWsLog(log)) {
      const key = getWsGroupKey(log);
      if (key && !seenWsKeys.has(key)) {
        seenWsKeys.add(key);
        result.push(mergedWsMap.get(key));
      }
      continue;
    }

    if (rid && isMergeableLog(log)) {
      if (seenRequestIds.has(rid)) continue;
      seenRequestIds.add(rid);
      result.push(mergedHttpMap.get(rid));
    } else {
      result.push(log);
    }
  }

  return result;
}

function isWsLog(log) {
  const kind = String(log.kind || "");
  return kind === "ws" || kind === "ws-live";
}

function getWsGroupKey(log) {
  const kind = String(log.kind || "");
  /* debugger ws: use requestId */
  if (kind === "ws" && log.requestId) return `ws:${log.requestId}`;
  /* inpage ws-live: use socketId from details, or fall back to url */
  if (kind === "ws-live") {
    const sid = log.details?.socketId;
    if (sid) return `wslive:${sid}`;
    if (log.url) return `wslive:${log.url}`;
  }
  return null;
}

function isMergeableLog(log) {
  const kind = String(log.kind || "");
  /* HTTP / quick-http 且有 requestId 的属于可合并类型 */
  if (kind === "http" || kind === "quick-http") return true;
  /* proxy 类型通常没有 requestId，但如果有也合并 */
  if (kind === "proxy" && log.requestId) return true;
  return false;
}

function createMergedEntry(requestId, phases) {
  const entry = {
    _merged: true,
    id: null,
    requestId,
    url: "",
    method: "-",
    resourceType: "",
    status: "-",
    statusText: "",
    duration: null,
    size: null,
    kind: "",
    time: 0,
    isoTime: "",
    message: "",
    _requestHeaders: null,
    _responseHeaders: null,
    _postData: "",
    _payload: "",
    _initiator: null,
    _referrerPolicy: "",
    _protocol: "",
    _remoteIP: "",
    _proxyMessage: "",
  };

  /* 按时间正序处理各阶段，确保后续阶段覆盖前面的 */
  const sorted = [...phases].sort((a, b) => (a.time || 0) - (b.time || 0));

  for (const log of sorted) {
    if (!entry.kind) entry.kind = log.kind;
    const phase = String(log.phase || "");

    if (phase === "request") {
      entry.id = entry.id || log.id;
      entry.url = log.url || entry.url;
      entry.method = log.method || entry.method;
      entry.resourceType = log.resourceType || entry.resourceType;
      entry.time = log.time || entry.time;
      entry.isoTime = log.isoTime || entry.isoTime;
      if (log.details) {
        entry._requestHeaders = log.details.requestHeaders || entry._requestHeaders;
        entry._postData = log.details.postData || log.details.requestBody || entry._postData;
        entry._initiator = log.details.initiator || entry._initiator;
        entry._referrerPolicy = log.details.referrerPolicy || entry._referrerPolicy;
      }
    }

    if (phase === "response") {
      entry.status = log.status ?? entry.status;
      entry.url = log.url || entry.url;
      entry.message = log.message || entry.message;
      if (log.details) {
        entry.statusText = log.details.statusText || entry.statusText;
        entry._responseHeaders = log.details.responseHeaders || entry._responseHeaders;
        entry._protocol = log.details.protocol || entry._protocol;
        entry._remoteIP = log.details.remoteIPAddress || entry._remoteIP;
        if (log.details.duration != null && entry.duration == null) entry.duration = log.details.duration;
      }
      if (log.payload) entry._payload = log.payload;
    }

    if (phase === "finished") {
      if (log.details) {
        entry.duration = log.details.duration;
        entry.size = log.details.encodedDataLength;
      }
      if (entry.status === "-") entry.status = "OK";
    }

    if (phase === "failed") {
      entry.status = "ERR";
      entry.message = log.message || "request failed";
    }

    if (phase === "mock-request" || phase === "mock-response") {
      entry.id = entry.id || log.id;
      entry.url = log.url || entry.url;
      entry.method = log.method || entry.method;
      entry.resourceType = log.resourceType || entry.resourceType;
      entry.status = log.status || entry.status;
      entry._proxyMessage = log.message || "";
      entry.kind = "proxy";
      entry.time = entry.time || log.time;
      entry.isoTime = entry.isoTime || log.isoTime;
    }
  }

  if (!entry.id && sorted.length) entry.id = sorted[0].id;
  if (!entry.time && sorted.length) { entry.time = sorted[0].time; entry.isoTime = sorted[0].isoTime; }

  return entry;
}

/* ═════════════════════════════════════════════════
   WS Log Merging - 按连接维度合并 WS 日志
   ═════════════════════════════════════════════════ */

function createWsMergedEntry(groupKey, phases) {
  const sorted = [...phases].sort((a, b) => (a.time || 0) - (b.time || 0));
  const messages = [];
  let url = "";
  let status = "OPEN";
  let socketId = "";
  let handshakeHeaders = null;
  let firstTime = 0;
  let firstIsoTime = "";
  let firstId = null;
  let sentCount = 0;
  let recvCount = 0;

  for (const log of sorted) {
    const phase = String(log.phase || "");
    if (!url) url = log.url || "";
    if (!firstTime) { firstTime = log.time; firstIsoTime = log.isoTime || ""; firstId = log.id; }
    if (!socketId && log.details?.socketId) socketId = log.details.socketId;

    if (phase === "created" || phase === "open") {
      status = "OPEN";
    } else if (phase === "closed" || phase === "close") {
      status = "CLOSED";
    } else if (phase === "error") {
      status = "ERR";
    } else if (phase === "handshake") {
      if (log.details?.responseHeaders) handshakeHeaders = log.details.responseHeaders;
    } else if (phase === "sent" || phase === "outgoing") {
      sentCount++;
      messages.push({
        direction: "outgoing",
        time: log.time,
        isoTime: log.isoTime || "",
        payload: log.payload || "",
        size: log.details?.payloadLength ?? (log.payload || "").length,
        replaced: Boolean(log.details?.replaced),
        ruleName: log.details?.ruleName || "",
        originalPayload: log.details?.originalPayload || "",
        status: log.status || "",
      });
    } else if (phase === "received" || phase === "incoming") {
      recvCount++;
      messages.push({
        direction: "incoming",
        time: log.time,
        isoTime: log.isoTime || "",
        payload: log.payload || "",
        size: log.details?.payloadLength ?? (log.payload || "").length,
        replaced: Boolean(log.details?.replaced),
        ruleName: log.details?.ruleName || "",
        originalPayload: log.details?.originalPayload || "",
        status: log.status || "",
      });
    }
  }

  return {
    _merged: true,
    _wsMerged: true,
    _wsGroupKey: groupKey,
    _wsMessages: messages,
    _wsHandshakeHeaders: handshakeHeaders,
    _wsSentCount: sentCount,
    _wsRecvCount: recvCount,
    id: firstId,
    url,
    method: "WS",
    resourceType: "WebSocket",
    kind: sorted[0]?.kind || "ws",
    status,
    time: firstTime,
    isoTime: firstIsoTime,
    message: `↑${sentCount} ↓${recvCount}`,
    details: { socketId },
  };
}

/* ───── Render Log List ───── */
function renderLogList() {
  displayLogs = filterLogs(buildMergedLogs());
  displayMap.clear();
  for (const item of displayLogs) displayMap.set(String(item.id), item);

  logCountEl.textContent = `${displayLogs.length} 条`;
  footerStatsEl.textContent = `原始: ${logMap.size} | 合并: ${displayLogs.length}`;

  if (!displayLogs.length) {
    logListEl.innerHTML = '<p class="empty-text">暂无日志</p>';
    return;
  }

  logListEl.innerHTML = displayLogs.map((item) => {
    const id = esc(item.id || "");
    const method = esc(item.method || item.kind || "-");
    const methodClass = getMethodClass(method, item);
    const time = formatTime(item.time);
    const url = esc(truncateUrl(item.url || item.message || "-"));
    const selected = id === selectedLogId ? " selected" : "";

    /* 状态 + 耗时 + 大小 合并到一行 */
    const statusParts = [];
    const s = formatStatus(item);
    if (s && s !== "-") statusParts.push(s);
    if (item.statusText) statusParts.push(item.statusText);
    const statusStr = esc(statusParts.join(" ") || "-");

    const metaParts = [];
    if (item.duration != null) metaParts.push(`${item.duration}ms`);
    if (item.size != null) metaParts.push(formatSize(item.size));
    if (item.resourceType) metaParts.push(item.resourceType);
    /* WS 合并条目：显示消息计数 */
    if (item._wsMerged) {
      metaParts.push(`↑${item._wsSentCount} ↓${item._wsRecvCount}`);
    }
    const metaStr = esc(metaParts.join(" · "));
    const canFill = canCreateRuleFromLog(item);
    const fillBtn = canFill
      ? `<button type="button" class="log-fill-btn" data-action="fill-rule" data-log-id="${id}">填充规则</button>`
      : "";

    return `<div class="log-item${selected}" data-log-id="${id}">
      <div class="log-item-top">
        <span class="log-method ${methodClass}">${method}</span>
        <div class="log-item-actions">
          ${fillBtn}
          <span class="log-time">${time}</span>
        </div>
      </div>
      <div class="log-url">${url}</div>
      <div class="log-meta">
        <span class="log-status ${getStatusClass(item)}">${statusStr}</span>
        <span class="log-type">${metaStr}</span>
      </div>
    </div>`;
  }).join("");

  /* 如果当前选中的是 WS 合并条目，实时刷新详情 */
  if (selectedLogId) {
    const selectedItem = displayMap.get(selectedLogId);
    if (selectedItem && selectedItem._wsMerged) {
      refreshWsDetail(selectedItem);
    }
  }
}

function filterLogs(logs) {
  if (activeFilter === "all") return logs;
  return logs.filter((item) => {
    const kind = String(item.kind || "").toLowerCase();
    const rt = String(item.resourceType || "").toLowerCase();
    if (activeFilter === "http") return kind.includes("http") || kind === "proxy" || (!kind.includes("ws") && !kind.includes("system") && !kind.includes("error"));
    if (activeFilter === "ws") return kind.includes("ws") || rt === "websocket";
    if (activeFilter === "proxy") return kind === "proxy" || kind === "error";
    return true;
  });
}

function getMethodClass(method, item) {
  const m = method.toUpperCase();
  const kind = String(item.kind || "").toLowerCase();
  if (kind.includes("ws") || String(item.resourceType || "").toLowerCase() === "websocket") return "ws";
  if (m === "GET") return "get";
  if (m === "POST") return "post";
  if (m === "PUT" || m === "PATCH") return "put";
  if (m === "DELETE") return "delete";
  return "other";
}

function formatStatus(item) {
  const s = item.status;
  if (s == null || s === "-") return "-";
  return String(s);
}

function getStatusClass(item) {
  const s = item.status;
  if (s === "ERR" || s === "CLOSED" || (typeof s === "number" && s >= 400)) return "err";
  if (typeof s === "number" && s >= 200 && s < 400) return "ok";
  if (s === "OK" || s === "OPEN" || s === "pass-through") return "ok";
  if (typeof s === "string" && s.startsWith("replaced")) return "ok";
  return "info";
}

/* ═════════════════════════════════════════════════
   Detail Panel - 类 Network 面板的结构化展示
   ═════════════════════════════════════════════════ */

function showDetail(item) {
  if (!item) {
    detailTitleEl.textContent = "日志详情";
    detailBodyEl.innerHTML = '<p class="empty-text">点击左侧日志查看详情</p>';
    expandedWsMsgIdx = null;
    return;
  }

  const kind = String(item.kind || "").toLowerCase();

  /* WS 合并条目 → 连接级详情 + 消息列表 */
  if (item._wsMerged) {
    expandedWsMsgIdx = null;
    detailTitleEl.textContent = `WS ${truncate(item.url || "", 60)}`;
    detailBodyEl.innerHTML = renderWsMergedDetail(item);
    /* 滚动消息列表到底部 */
    const msgList = detailBodyEl.querySelector('.ws-messages-list');
    if (msgList) msgList.scrollTop = msgList.scrollHeight;
    return;
  }

  const isHttp = item._merged || kind === "http" || kind === "quick-http" || kind === "proxy";

  if (isHttp) {
    const normalized = item._merged ? item : normalizeHttpItem(item);
    detailTitleEl.textContent = `${normalized.method || "-"} ${truncate(normalized.url || "", 60)}`;
    detailBodyEl.innerHTML = renderHttpDetail(normalized);
  } else if (kind.includes("ws") || String(item.resourceType || "").toLowerCase() === "websocket") {
    detailTitleEl.textContent = `WS ${item.phase || ""}`;
    detailBodyEl.innerHTML = renderWsDetail(item);
  } else {
    detailTitleEl.textContent = `${item.kind || "log"}`;
    detailBodyEl.innerHTML = renderGenericDetail(item);
  }
}

function canCreateRuleFromLog(item) {
  return isWsRuleSource(item) || isHttpRuleSource(item);
}

function isHttpRuleSource(item) {
  const kind = String(item?.kind || "").toLowerCase();
  if (!item || isWsRuleSource(item)) return false;
  return Boolean(item._merged || kind === "http" || kind === "quick-http" || kind === "proxy");
}

function isWsRuleSource(item) {
  const kind = String(item?.kind || "").toLowerCase();
  return Boolean(item && (item._wsMerged || kind.includes("ws") || String(item.resourceType || "").toLowerCase() === "websocket"));
}

function fillRuleFromLog(item) {
  if (isWsRuleSource(item)) {
    openWsRuleFormWithDraft(buildWsRuleDraftFromLog(item));
    flash("已根据请求日志填充 WS 规则", "success");
    return;
  }
  if (isHttpRuleSource(item)) {
    openHttpRuleFormWithDraft(buildHttpRuleDraftFromLog(item));
    flash("已根据请求日志填充 HTTP 规则", "success");
  }
}

function openHttpRuleFormWithDraft(draft) {
  switchTab("http");
  showHttpRuleForm(null);
  const form = httpRuleFormEl;
  setField(form, "name", draft.name || "http-rule");
  setField(form, "urlPattern", draft.urlPattern || "");
  setField(form, "stage", draft.stage || "response");
  setField(form, "operation", draft.operation || "fulfill");
  setField(form, "statusCode", draft.statusCode ?? 200);
  setField(form, "contentType", draft.contentType || "application/json; charset=utf-8");
  setField(form, "responseMode", draft.responseMode || "plain");
  setField(form, "responseBody", draft.responseBody || "");
  setField(form, "replaceFrom", draft.replaceFrom || "");
  setField(form, "replaceTo", draft.replaceTo || "");
  syncHttpFormVisibility();
}

function openWsRuleFormWithDraft(draft) {
  switchTab("ws");
  showWsRuleForm(null);
  const form = wsRuleFormEl;
  setField(form, "name", draft.name || "ws-rule");
  setField(form, "urlPattern", draft.urlPattern || "");
  setField(form, "outgoingFind", draft.outgoingFind || "");
  setField(form, "outgoingReplace", draft.outgoingReplace || "");
  setField(form, "incomingFind", draft.incomingFind || "");
  setField(form, "incomingReplace", draft.incomingReplace || "");
}

function buildHttpRuleDraftFromLog(item) {
  const normalized = item._merged ? item : normalizeHttpItem(item);
  return {
    name: buildRuleName("http", normalized.method, normalized.url),
    urlPattern: buildUrlPattern(normalized.url),
    stage: "response",
    operation: "fulfill",
    statusCode: typeof normalized.status === "number" ? normalized.status : 200,
    contentType: firstHeaderValue(normalized._responseHeaders, "content-type") || normalized.message || "application/json; charset=utf-8",
    responseMode: "plain",
    responseBody: normalized._payload || "",
    replaceFrom: "",
    replaceTo: ""
  };
}

function buildWsRuleDraftFromLog(item) {
  const messages = item._wsMerged
    ? item._wsMessages || []
    : [{
      direction: normalizeWsDirection(item.phase),
      payload: item.payload || item.message || ""
    }];
  const lastOutgoing = [...messages].reverse().find((msg) => msg.direction === "outgoing" && msg.payload);
  const lastIncoming = [...messages].reverse().find((msg) => msg.direction === "incoming" && msg.payload);

  return {
    name: buildRuleName("ws", "ws", item.url),
    urlPattern: buildUrlPattern(item.url),
    outgoingFind: lastOutgoing?.payload || "",
    outgoingReplace: "",
    incomingFind: lastIncoming?.payload || "",
    incomingReplace: ""
  };
}

function normalizeWsDirection(phase) {
  const value = String(phase || "").toLowerCase();
  if (value === "sent" || value === "outgoing") return "outgoing";
  if (value === "received" || value === "incoming") return "incoming";
  return "";
}

function buildRuleName(prefix, method, rawUrl) {
  const normalizedMethod = String(method || prefix).toLowerCase();
  const slug = buildUrlSlug(rawUrl);
  return `${prefix}-${normalizedMethod}-${slug}`;
}

function buildUrlSlug(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const parts = url.pathname.split("/").filter(Boolean);
    return sanitizeSlug(parts.pop() || url.hostname || "rule");
  } catch {
    const text = String(rawUrl || "").trim();
    if (!text) return "rule";
    const parts = text.split(/[/?#]/).filter(Boolean);
    return sanitizeSlug(parts.pop() || "rule");
  }
}

function sanitizeSlug(text) {
  return String(text || "rule").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rule";
}

function buildUrlPattern(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    const pathname = `${url.origin}${url.pathname || "/"}`;
    return url.search ? `${pathname}*` : pathname;
  } catch {
    return input;
  }
}

function firstHeaderValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return String(value || "");
  }
  return "";
}

function normalizeHttpItem(item) {
  const d = item.details || {};
  return {
    ...item,
    _merged: true,
    _requestHeaders: d.requestHeaders || null,
    _responseHeaders: d.responseHeaders || null,
    _postData: d.postData || d.requestBody || "",
    _payload: item.payload || "",
    _initiator: d.initiator || null,
    _referrerPolicy: d.referrerPolicy || "",
    _protocol: d.protocol || "",
    _remoteIP: d.remoteIPAddress || "",
    _proxyMessage: item.kind === "proxy" ? item.message : "",
    duration: d.duration ?? item.duration ?? null,
    size: d.encodedDataLength ?? item.size ?? null,
  };
}

function renderHttpDetail(item) {
  let html = "";

  /* General */
  html += section("General", [
    kv("Request URL", item.url),
    kv("Request Method", item.method),
    kvStatus("Status Code", formatStatusDisplay(item)),
    kv("Resource Type", item.resourceType),
    item._protocol ? kv("Protocol", item._protocol) : "",
    item._remoteIP ? kv("Remote Address", item._remoteIP) : "",
    item.duration != null ? kv("Duration", `${item.duration} ms`) : "",
    item.size != null ? kv("Transfer Size", formatSize(item.size)) : "",
    item.message ? kv("Content Type", item.message) : "",
    item._proxyMessage ? kv("Proxy", item._proxyMessage) : "",
    item._referrerPolicy ? kv("Referrer Policy", item._referrerPolicy) : "",
  ]);

  /* Response Headers */
  if (item._responseHeaders && typeof item._responseHeaders === "object") {
    html += headersSection("Response Headers", item._responseHeaders);
  }

  /* Request Headers */
  if (item._requestHeaders && typeof item._requestHeaders === "object") {
    html += headersSection("Request Headers", item._requestHeaders);
  }

  /* Initiator */
  if (item._initiator) {
    const initiatorText = formatInitiator(item._initiator);
    if (initiatorText) {
      html += section("Initiator", [kv("Type", item._initiator.type || "-"), kv("Source", initiatorText)]);
    }
  }

  /* Request Payload */
  if (item._postData) {
    html += codeSection("Request Payload", item._postData);
  }

  /* Response Body */
  if (item._payload) {
    html += codeSection("Response Body", item._payload);
  }

  return html;
}

/* ───── WS 合并条目详情：连接信息 + 消息列表 ───── */

function renderWsMergedDetail(item) {
  let html = "";

  /* General */
  html += section("General", [
    kv("URL", item.url || "-"),
    kv("Status", item.status || "-"),
    kv("Kind", item.kind || "-"),
    item.details?.socketId ? kv("Socket ID", item.details.socketId) : "",
    kv("Time", item.isoTime || formatTime(item.time)),
    kv("Messages", `↑ ${item._wsSentCount}  ↓ ${item._wsRecvCount}  (共 ${item._wsMessages.length})`),
  ]);

  /* Handshake Headers */
  if (item._wsHandshakeHeaders && typeof item._wsHandshakeHeaders === "object") {
    html += headersSection("Handshake Headers", item._wsHandshakeHeaders);
  }

  /* Messages List */
  html += renderWsMessagesList(item._wsMessages);

  return html;
}

function renderWsMessagesList(messages) {
  if (!messages || !messages.length) {
    return `<div class="detail-section">
      <h4 class="detail-section-title">Messages</h4>
      <div class="detail-section-body"><p class="empty-text">暂无消息</p></div>
    </div>`;
  }

  /* 表头 */
  let html = `<div class="detail-section">
    <h4 class="detail-section-title">Messages (${messages.length})</h4>
    <div class="detail-section-body">
      <div class="ws-messages-header">
        <span class="ws-msg-col-dir"></span>
        <span class="ws-msg-col-data">Data</span>
        <span class="ws-msg-col-size">Length</span>
        <span class="ws-msg-col-time">Time</span>
      </div>
      <div class="ws-messages-list">`;

  messages.forEach((msg, idx) => {
    const isOut = msg.direction === "outgoing";
    const arrow = isOut ? "↑" : "↓";
    const dirClass = isOut ? "outgoing" : "incoming";
    const preview = esc(truncate(msg.payload || "(empty)", 120));
    const sizeStr = typeof msg.size === "number" ? msg.size : (msg.payload || "").length;
    const timeStr = formatTime(msg.time);
    const expanded = expandedWsMsgIdx === idx ? " expanded" : "";
    const replacedBadge = msg.replaced ? `<span class="ws-msg-replaced">replaced</span>` : "";

    html += `<div class="ws-msg-row ${dirClass}${expanded}" data-ws-msg-idx="${idx}">
      <span class="ws-msg-arrow ${dirClass}">${arrow}</span>
      <span class="ws-msg-preview">${preview}${replacedBadge}</span>
      <span class="ws-msg-size">${sizeStr}</span>
      <span class="ws-msg-time">${timeStr}</span>
    </div>`;

    if (expandedWsMsgIdx === idx) {
      html += `<div class="ws-msg-detail">`;
      html += `<pre class="detail-code">${esc(formatBody(msg.payload || ""))}</pre>`;
      if (msg.replaced && msg.originalPayload) {
        html += `<div class="ws-msg-original-label">Original:</div>`;
        html += `<pre class="detail-code">${esc(formatBody(msg.originalPayload))}</pre>`;
      }
      html += `</div>`;
    }
  });

  html += `</div></div></div>`;
  return html;
}

/* 实时刷新选中的 WS 条目详情（仅更新消息列表区域） */
function refreshWsDetail(item) {
  if (!item || !item._wsMerged) return;
  const msgSection = detailBodyEl.querySelector('.ws-messages-list');
  if (!msgSection) {
    /* 完整重绘 */
    detailBodyEl.innerHTML = renderWsMergedDetail(item);
    return;
  }

  /* 检查标题中的消息数是否同步 */
  const titleEl = detailBodyEl.querySelector('.detail-section:last-child .detail-section-title');
  if (titleEl) titleEl.textContent = `Messages (${item._wsMessages.length})`;

  /* 重新渲染消息列表内容 */
  const messages = item._wsMessages;
  let listHtml = "";
  messages.forEach((msg, idx) => {
    const isOut = msg.direction === "outgoing";
    const arrow = isOut ? "↑" : "↓";
    const dirClass = isOut ? "outgoing" : "incoming";
    const preview = esc(truncate(msg.payload || "(empty)", 120));
    const sizeStr = typeof msg.size === "number" ? msg.size : (msg.payload || "").length;
    const timeStr = formatTime(msg.time);
    const expanded = expandedWsMsgIdx === idx ? " expanded" : "";
    const replacedBadge = msg.replaced ? `<span class="ws-msg-replaced">replaced</span>` : "";

    listHtml += `<div class="ws-msg-row ${dirClass}${expanded}" data-ws-msg-idx="${idx}">
      <span class="ws-msg-arrow ${dirClass}">${arrow}</span>
      <span class="ws-msg-preview">${preview}${replacedBadge}</span>
      <span class="ws-msg-size">${sizeStr}</span>
      <span class="ws-msg-time">${timeStr}</span>
    </div>`;

    if (expandedWsMsgIdx === idx) {
      listHtml += `<div class="ws-msg-detail">`;
      listHtml += `<pre class="detail-code">${esc(formatBody(msg.payload || ""))}</pre>`;
      if (msg.replaced && msg.originalPayload) {
        listHtml += `<div class="ws-msg-original-label">Original:</div>`;
        listHtml += `<pre class="detail-code">${esc(formatBody(msg.originalPayload))}</pre>`;
      }
      listHtml += `</div>`;
    }
  });

  const wasAtBottom = msgSection.scrollHeight - msgSection.scrollTop - msgSection.clientHeight < 30;
  msgSection.innerHTML = listHtml;
  if (wasAtBottom) msgSection.scrollTop = msgSection.scrollHeight;
}

function renderWsDetail(item) {
  let html = "";
  const phase = String(item.phase || "");
  const dir = phase === "sent" || phase === "outgoing" ? "Outgoing" : phase === "received" || phase === "incoming" ? "Incoming" : phase;

  html += section("General", [
    kv("URL", item.url || "-"),
    kv("Direction", dir),
    kv("Kind", item.kind || "-"),
    kv("Status", String(item.status ?? "-")),
    kv("Time", item.isoTime || formatTime(item.time)),
    item.message ? kv("Message", item.message) : "",
    item.details?.socketId ? kv("Socket ID", item.details.socketId) : "",
    item.details?.replaced ? kv("Replaced", `Yes (${item.details.ruleName || ""})`) : "",
  ]);

  if (item.payload) {
    html += codeSection("Payload", item.payload);
  }

  if (item.details?.originalPayload && item.details.replaced) {
    html += codeSection("Original Payload", item.details.originalPayload);
  }

  return html;
}

function renderGenericDetail(item) {
  let html = "";

  const rows = [
    kv("Kind", item.kind || "-"),
    kv("Phase", item.phase || "-"),
    item.url ? kv("URL", item.url) : "",
    item.method ? kv("Method", item.method) : "",
    kv("Status", String(item.status ?? "-")),
    item.resourceType ? kv("Resource Type", item.resourceType) : "",
    kv("Time", item.isoTime || formatTime(item.time)),
    item.message ? kv("Message", item.message) : "",
  ];
  html += section("General", rows);

  if (item.payload) {
    html += codeSection("Payload", item.payload);
  }

  if (item.details && Object.keys(item.details).length) {
    html += codeSection("Details", JSON.stringify(item.details, null, 2));
  }

  return html;
}

/* ───── Detail HTML Builders ───── */

function section(title, rows) {
  const filtered = rows.filter(Boolean).join("");
  if (!filtered) return "";
  return `<div class="detail-section">
    <h4 class="detail-section-title">${esc(title)}</h4>
    <div class="detail-section-body"><div class="detail-kv-list">${filtered}</div></div>
  </div>`;
}

function headersSection(title, headers) {
  const entries = Object.entries(headers);
  if (!entries.length) return "";
  const rows = entries.map(([k, v]) => kv(k, String(v))).join("");
  return `<div class="detail-section collapsed">
    <h4 class="detail-section-title">${esc(title)} (${entries.length})</h4>
    <div class="detail-section-body"><div class="detail-kv-list">${rows}</div></div>
  </div>`;
}

function codeSection(title, content) {
  return `<div class="detail-section">
    <h4 class="detail-section-title">${esc(title)}</h4>
    <div class="detail-section-body"><pre class="detail-code">${esc(formatBody(content))}</pre></div>
  </div>`;
}

function kv(key, value) {
  return `<div class="detail-kv-row"><span class="detail-kv-key">${esc(key)}</span><span class="detail-kv-value">${esc(String(value || "-"))}</span></div>`;
}

function kvStatus(key, value) {
  const cls = String(value || "").startsWith("2") || String(value || "").startsWith("3") ? "status-ok"
    : String(value || "").match(/^[45]|ERR/i) ? "status-err" : "";
  return `<div class="detail-kv-row"><span class="detail-kv-key">${esc(key)}</span><span class="detail-kv-value ${cls}">${esc(String(value || "-"))}</span></div>`;
}

function formatStatusDisplay(item) {
  const parts = [];
  if (item.status != null && item.status !== "-") parts.push(String(item.status));
  if (item.statusText) {
    parts.push(item.statusText);
  } else if (typeof item.status === "number") {
    const text = httpStatusText(item.status);
    if (text) parts.push(text);
  }
  return parts.join(" ") || "-";
}

function httpStatusText(code) {
  const texts = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict",
    413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"
  };
  return texts[code] || "";
}

function formatInitiator(initiator) {
  if (!initiator) return "";
  if (initiator.url) return `${initiator.url}${initiator.lineNumber != null ? `:${initiator.lineNumber}` : ""}`;
  if (initiator.stack?.callFrames?.length) {
    const f = initiator.stack.callFrames[0];
    return `${f.url || ""}:${f.lineNumber ?? ""}`;
  }
  return initiator.type || "";
}

function formatBody(text) {
  if (!text) return "";
  const trimmed = String(text).trim();
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { return trimmed; }
}

function formatSize(bytes) {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ───── Render HTTP Rules ───── */
function renderHttpRules() {
  if (!httpRules.length) {
    httpRulesListEl.innerHTML = '<p class="empty-text">暂无 HTTP 规则，点击上方按钮添加</p>';
    return;
  }

  httpRulesListEl.innerHTML = httpRules.map((rule) => {
    const iconClass = rule.operation === "replace" ? "replace" : "mock";
    const iconText = rule.operation === "replace" ? "R" : "M";

    /* Build operation summary */
    let opSummary = '';
    if (rule.operation === 'replace' && rule.replaceFrom) {
      opSummary = `<span class="rule-meta-tag">"${esc(truncate(rule.replaceFrom, 20))}" → "${esc(truncate(rule.replaceTo, 20))}"</span>`;
    } else if (rule.operation === 'fulfill' && rule.responseBody) {
      opSummary = `<span class="rule-meta-tag rule-meta-body">${esc(truncate(rule.responseBody, 50))}</span>`;
    }
    const responseModeTag = rule.operation === "fulfill" && rule.responseMode === "mock"
      ? '<span class="rule-meta-tag">mockjs</span>'
      : "";

    return `<div class="rule-card" data-rule-id="${esc(rule.id)}">
      <div class="rule-card-top">
        <div class="rule-card-left">
          <div class="rule-icon ${iconClass}">${iconText}</div>
          <div>
            <div class="rule-name">${esc(rule.name || rule.id)}</div>
          </div>
        </div>
        <div class="rule-card-right">
          <span class="rule-badge ${rule.stage}">${esc(rule.stage)}</span>
          <span class="rule-badge ${iconClass}">${esc(rule.operation)}</span>
          <label class="toggle toggle-sm">
            <input type="checkbox" data-action="toggle" data-id="${esc(rule.id)}" ${rule.enabled ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="rule-url-pattern"><span class="rule-url-icon">🔗</span> ${esc(rule.urlPattern || "*")}</div>
      <div class="rule-card-meta">
        <span class="rule-meta-tag">${rule.stage} → ${rule.operation} ${rule.statusCode}</span>
        ${responseModeTag}
        ${opSummary}
      </div>
      <div class="rule-card-actions">
        <button class="btn-edit" data-action="edit" data-id="${esc(rule.id)}">编辑</button>
        <button class="btn-danger" data-action="delete" data-id="${esc(rule.id)}">删除</button>
      </div>
    </div>`;
  }).join("");
}

async function handleHttpRuleAction(e) {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === "toggle") {
    try { await sendMessage({ action: "toggleHttpRule", id, enabled: target.checked }); }
    catch (error) { target.checked = !target.checked; flash(error.message, "error"); }
    return;
  }
  if (action === "edit") {
    const rule = httpRules.find((r) => r.id === id);
    if (rule) showHttpRuleForm(rule);
    return;
  }
  if (action === "delete") {
    try {
      await sendMessage({ action: "deleteHttpRule", id });
      await refreshRules();
      flash("HTTP 规则已删除", "success");
    } catch (error) { flash(error.message, "error"); }
  }
}

/* ───── Render WS Rules ───── */
function renderWsRules() {
  if (!wsRules.length) {
    wsRulesListEl.innerHTML = '<p class="empty-text">暂无 WS 规则</p>';
    return;
  }

  wsRulesListEl.innerHTML = wsRules.map((rule) => {
    const hasOut = Boolean(rule.outgoingFind);
    const hasIn = Boolean(rule.incomingFind);
    const dirLabel = hasOut && hasIn ? "Both" : hasOut ? "Outgoing" : hasIn ? "Incoming" : "-";
    const dirClass = hasOut && !hasIn ? "outgoing" : "incoming";

    return `<div class="rule-card" data-rule-id="${esc(rule.id)}">
      <div class="rule-card-top">
        <div class="rule-card-left">
          <div class="rule-icon ws">WS</div>
          <div>
            <div class="rule-name">${esc(rule.name || rule.id)}</div>
            <div class="rule-pattern">${esc(rule.urlPattern || "*")}</div>
          </div>
        </div>
        <div class="rule-card-right">
          <span class="rule-badge ${dirClass}">${dirLabel}</span>
          <label class="toggle toggle-sm">
            <input type="checkbox" data-action="toggle" data-id="${esc(rule.id)}" ${rule.enabled ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="rule-card-meta">
        ${hasOut ? `<span class="rule-meta-tag">OUT: ${esc(truncate(rule.outgoingFind, 30))} => ${esc(truncate(rule.outgoingReplace, 30))}</span>` : ""}
        ${hasIn ? `<span class="rule-meta-tag">IN: ${esc(truncate(rule.incomingFind, 30))} => ${esc(truncate(rule.incomingReplace, 30))}</span>` : ""}
      </div>
      <div class="rule-card-actions">
        <button class="btn-edit" data-action="edit" data-id="${esc(rule.id)}">编辑</button>
        <button class="btn-danger" data-action="delete" data-id="${esc(rule.id)}">删除</button>
      </div>
    </div>`;
  }).join("");
}

async function handleWsRuleAction(e) {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === "toggle") {
    try { await sendMessage({ action: "toggleWsRule", id, enabled: target.checked }); }
    catch (error) { target.checked = !target.checked; flash(error.message, "error"); }
    return;
  }
  if (action === "edit") {
    const rule = wsRules.find((r) => r.id === id);
    if (rule) showWsRuleForm(rule);
    return;
  }
  if (action === "delete") {
    try {
      await sendMessage({ action: "deleteWsRule", id });
      await refreshRules();
      flash("WS 规则已删除", "success");
    } catch (error) { flash(error.message, "error"); }
  }
}

/* ───── HTTP Rule Form ───── */
function showHttpRuleForm(rule) {
  editingHttpRuleId = rule?.id || null;
  httpFormTitle.textContent = rule ? "编辑 HTTP 规则" : "新建 HTTP 规则";
  httpRuleFormCard.classList.remove("hidden");

  /* Inline editing: move form card to after the rule card being edited */
  if (rule?.id) {
    const ruleCard = httpRulesListEl.querySelector(`[data-rule-id="${rule.id}"]`);
    if (ruleCard) {
      ruleCard.insertAdjacentElement('afterend', httpRuleFormCard);
    }
  } else {
    /* New rule: ensure form is in its default position (after panel-header) */
    const panelHeader = panelHttp.querySelector('.panel-header');
    if (panelHeader) {
      panelHeader.insertAdjacentElement('afterend', httpRuleFormCard);
    }
  }

  const form = httpRuleFormEl;
  setField(form, "id", rule?.id || "");
  setField(form, "name", rule?.name || "http-rule");
  setField(form, "urlPattern", rule?.urlPattern || "");
  setField(form, "stage", rule?.stage || "request");
  setField(form, "operation", rule?.operation || "fulfill");
  setField(form, "statusCode", rule?.statusCode ?? 200);
  setField(form, "contentType", rule?.contentType || "application/json; charset=utf-8");
  setField(form, "responseMode", rule?.responseMode || "plain");
  setField(form, "responseBody", rule?.responseBody || "");
  setField(form, "replaceFrom", rule?.replaceFrom || "");
  setField(form, "replaceTo", rule?.replaceTo || "");
  syncHttpFormVisibility();
  httpRuleFormCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideHttpRuleForm() {
  httpRuleFormCard.classList.add("hidden");
  editingHttpRuleId = null;
  httpRuleFormEl.reset();
  /* Move form card back to default position */
  const panelHeader = panelHttp.querySelector('.panel-header');
  if (panelHeader) {
    panelHeader.insertAdjacentElement('afterend', httpRuleFormCard);
  }
}

function openMockSyntaxModal() {
  if (!mockSyntaxModalEl) return;
  mockSyntaxModalEl.classList.remove("hidden");
  mockSyntaxModalEl.setAttribute("aria-hidden", "false");
}

function closeMockSyntaxModal() {
  if (!mockSyntaxModalEl) return;
  mockSyntaxModalEl.classList.add("hidden");
  mockSyntaxModalEl.setAttribute("aria-hidden", "true");
}

function openReplaceHelpModal() {
  if (!replaceHelpModalEl) return;
  replaceHelpModalEl.classList.remove("hidden");
  replaceHelpModalEl.setAttribute("aria-hidden", "false");
}

function closeReplaceHelpModal() {
  if (!replaceHelpModalEl) return;
  replaceHelpModalEl.classList.add("hidden");
  replaceHelpModalEl.setAttribute("aria-hidden", "true");
}

function openWsRuleHelpModal() {
  if (!wsRuleHelpModalEl) return;
  wsRuleHelpModalEl.classList.remove("hidden");
  wsRuleHelpModalEl.setAttribute("aria-hidden", "false");
}

function closeWsRuleHelpModal() {
  if (!wsRuleHelpModalEl) return;
  wsRuleHelpModalEl.classList.add("hidden");
  wsRuleHelpModalEl.setAttribute("aria-hidden", "true");
}

function syncHttpFormVisibility() {
  const stage = httpStageSelectEl.value;
  const isRequest = stage === "request";

  /* Stage-operation linkage: request stage locks to fulfill */
  if (isRequest) {
    httpOperationSelectEl.value = "fulfill";
    httpOperationSelectEl.disabled = true;
    httpOperationLabelEl.style.opacity = "0.5";
  } else {
    httpOperationSelectEl.disabled = false;
    httpOperationLabelEl.style.opacity = "1";
  }

  const operation = httpOperationSelectEl.value;
  const isReplace = operation === "replace";
  const responseMode = httpResponseModeSelectEl?.value === "mock" ? "mock" : "plain";
  const responseTextarea = httpRuleFormEl?.elements?.namedItem("responseBody");
  const contentTypeInput = httpRuleFormEl?.elements?.namedItem("contentType");
  const contentType = String(contentTypeInput?.value || "");
  const isJsonLike = /json/i.test(contentType);

  /* Show/hide fields based on operation */
  httpReplaceRowEl.style.display = isReplace ? "" : "none";
  httpResponseBodyLabelEl.style.display = isReplace ? "none" : "";
  if (httpResponseModeRowEl) httpResponseModeRowEl.style.display = isReplace ? "none" : "";

  if (responseTextarea && "placeholder" in responseTextarea) {
    responseTextarea.placeholder = getResponseBodyPlaceholder({ isReplace, responseMode, isJsonLike });
  }
}

function getResponseBodyPlaceholder({ isReplace, responseMode, isJsonLike }) {
  if (isReplace) return "";
  if (responseMode === "mock") {
    return '{"code":0,"data|2-4":[{"id":"@guid","name":"@cname","age|18-40":1}]}';
  }
  if (isJsonLike) {
    return '{"code":0,"message":"ok","data":{"name":"demo"}}';
  }
  return "mock plain text response";
}

/* ───── WS Rule Form ───── */
function showWsRuleForm(rule) {
  editingWsRuleId = rule?.id || null;
  wsFormTitle.textContent = rule ? "编辑 WS 规则" : "新建 WS 规则";
  wsRuleFormCard.classList.remove("hidden");

  /* Inline editing: move form card to after the rule card being edited */
  if (rule?.id) {
    const ruleCard = wsRulesListEl.querySelector(`[data-rule-id="${rule.id}"]`);
    if (ruleCard) {
      ruleCard.insertAdjacentElement('afterend', wsRuleFormCard);
    }
  } else {
    const panelHeader = panelWs.querySelector('.panel-header');
    if (panelHeader) {
      panelHeader.insertAdjacentElement('afterend', wsRuleFormCard);
    }
  }

  const form = wsRuleFormEl;
  setField(form, "id", rule?.id || "");
  setField(form, "name", rule?.name || "ws-rule");
  setField(form, "urlPattern", rule?.urlPattern || "");
  setField(form, "outgoingFind", rule?.outgoingFind || "");
  setField(form, "outgoingReplace", rule?.outgoingReplace || "");
  setField(form, "incomingFind", rule?.incomingFind || "");
  setField(form, "incomingReplace", rule?.incomingReplace || "");
  wsRuleFormCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideWsRuleForm() {
  wsRuleFormCard.classList.add("hidden");
  editingWsRuleId = null;
  wsRuleFormEl.reset();
  /* Move form card back to default position */
  const panelHeader = panelWs.querySelector('.panel-header');
  if (panelHeader) {
    panelHeader.insertAdjacentElement('afterend', wsRuleFormCard);
  }
}

/* ───── Flash Messages ───── */
function flash(text, type = "info") {
  const el = document.createElement("div");
  el.className = `flash-msg ${type}`;
  el.textContent = text;
  flashContainerEl.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 200); }, 2500);
}

/* ───── Utility ───── */
function getModeLabel(mode) {
  return mode === "quick" ? "快捷模式" : mode === "full" ? "全量模式" : "代理";
}

function formatTime(ts) {
  if (!ts) return "-";
  try { return new Date(ts).toLocaleTimeString(); } catch { return "-"; }
}

function truncate(text, max) {
  const v = String(text || "");
  return v.length <= max ? v : v.slice(0, max) + "...";
}

function truncateUrl(url) {
  const v = String(url || "");
  /* 对于完整 URL，只显示 pathname + search 部分 */
  try {
    const parsed = new URL(v);
    const short = parsed.pathname + parsed.search;
    return short.length > 80 ? short.slice(0, 80) + "..." : short;
  } catch {
    return v.length > 80 ? v.slice(0, 80) + "..." : v;
  }
}

function esc(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function setField(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  if (field instanceof HTMLInputElement && field.type === "checkbox") { field.checked = Boolean(value); return; }
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
    field.value = String(value ?? "");
  }
}

function setCheckbox(form, name, checked) {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) field.checked = checked;
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const e = chrome.runtime.lastError;
      if (e) { reject(new Error(e.message)); return; }
      if (!response?.ok) { reject(new Error(response?.error || "unknown error")); return; }
      resolve(response.data);
    });
  });
}
