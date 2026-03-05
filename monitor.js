const tabIdTextEl = document.getElementById("tabIdText");
const statusBadgeEl = document.getElementById("statusBadge");
const toggleEnabledEl = document.getElementById("toggleEnabled");
const searchInputEl = document.getElementById("searchInput");
const refreshBtnEl = document.getElementById("refreshBtn");
const clearLogsBtnEl = document.getElementById("clearLogsBtn");
const logsBodyEl = document.getElementById("logsBody");
const flashTextEl = document.getElementById("flashText");

const httpRuleFormEl = document.getElementById("httpRuleForm");
const wsRuleFormEl = document.getElementById("wsRuleForm");
const httpRulesListEl = document.getElementById("httpRulesList");
const wsRulesListEl = document.getElementById("wsRulesList");

const queryTabId = Number(new URLSearchParams(window.location.search).get("tabId"));
let tabId = Number.isInteger(queryTabId) ? queryTabId : null;
let searchKeyword = "";
let logsTimer = null;
let statusTimer = null;

init().catch((error) => {
  flash(error.message || String(error), true);
});

async function init() {
  if (!tabId) {
    throw new Error("缺少 tabId，请从插件 popup 点击“打开监控面板”");
  }

  tabIdTextEl.textContent = String(tabId);
  bindEvents();

  await refreshAll();

  logsTimer = setInterval(() => {
    void refreshLogs();
  }, 1200);

  statusTimer = setInterval(() => {
    void refreshStatus();
  }, 2600);

  window.addEventListener("beforeunload", () => {
    clearInterval(logsTimer);
    clearInterval(statusTimer);
  });
}

function bindEvents() {
  toggleEnabledEl.addEventListener("change", async () => {
    toggleEnabledEl.disabled = true;
    try {
      const result = await sendMessage({
        action: "setTabEnabled",
        tabId,
        enabled: toggleEnabledEl.checked
      });
      renderStatus(result.enabled);
      flash(result.enabled ? "代理已开启" : "代理已关闭");
    } catch (error) {
      toggleEnabledEl.checked = !toggleEnabledEl.checked;
      flash(error.message || String(error), true);
    } finally {
      toggleEnabledEl.disabled = false;
    }
  });

  searchInputEl.addEventListener("input", () => {
    searchKeyword = searchInputEl.value.trim();
    void refreshLogs();
  });

  refreshBtnEl.addEventListener("click", () => {
    void refreshAll();
  });

  clearLogsBtnEl.addEventListener("click", async () => {
    const ok = window.confirm("确认清空当前 Tab 的所有日志？");
    if (!ok) {
      return;
    }

    try {
      await sendMessage({ action: "clearLogs", tabId });
      await refreshLogs();
      flash("日志已清空");
    } catch (error) {
      flash(error.message || String(error), true);
    }
  });

  httpRuleFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(httpRuleFormEl);
    const rule = {
      name: String(formData.get("name") || "http-rule").trim(),
      urlPattern: String(formData.get("urlPattern") || "").trim(),
      resourceTypes: String(formData.get("resourceTypes") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      stage: String(formData.get("stage") || "request"),
      operation: String(formData.get("operation") || "fulfill"),
      statusCode: Number(formData.get("statusCode") || 200),
      contentType: String(formData.get("contentType") || "application/json; charset=utf-8"),
      responseBody: String(formData.get("responseBody") || ""),
      replaceFrom: String(formData.get("replaceFrom") || ""),
      replaceTo: String(formData.get("replaceTo") || ""),
      useRegex: formData.get("useRegex") === "on"
    };

    try {
      await sendMessage({ action: "addHttpRule", rule });
      await refreshRules();
      flash("HTTP 规则已新增");
    } catch (error) {
      flash(error.message || String(error), true);
    }
  });

  wsRuleFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(wsRuleFormEl);
    const rule = {
      name: String(formData.get("name") || "ws-rule").trim(),
      urlPattern: String(formData.get("urlPattern") || "").trim(),
      useRegex: formData.get("useRegex") === "on",
      outgoingFind: String(formData.get("outgoingFind") || ""),
      outgoingReplace: String(formData.get("outgoingReplace") || ""),
      incomingFind: String(formData.get("incomingFind") || ""),
      incomingReplace: String(formData.get("incomingReplace") || "")
    };

    try {
      await sendMessage({ action: "addWsRule", rule });
      await refreshRules();
      flash("WS 规则已新增");
    } catch (error) {
      flash(error.message || String(error), true);
    }
  });

  httpRulesListEl.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.dataset.kind !== "http-toggle") {
      return;
    }

    try {
      await sendMessage({
        action: "toggleHttpRule",
        id: target.dataset.id,
        enabled: target.checked
      });
      flash(`HTTP 规则已${target.checked ? "启用" : "禁用"}`);
    } catch (error) {
      target.checked = !target.checked;
      flash(error.message || String(error), true);
    }
  });

  httpRulesListEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-kind='http-delete']");
    if (!button) {
      return;
    }

    try {
      await sendMessage({
        action: "deleteHttpRule",
        id: button.dataset.id
      });
      await refreshRules();
      flash("HTTP 规则已删除");
    } catch (error) {
      flash(error.message || String(error), true);
    }
  });

  wsRulesListEl.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.dataset.kind !== "ws-toggle") {
      return;
    }

    try {
      await sendMessage({
        action: "toggleWsRule",
        id: target.dataset.id,
        enabled: target.checked
      });
      flash(`WS 规则已${target.checked ? "启用" : "禁用"}`);
    } catch (error) {
      target.checked = !target.checked;
      flash(error.message || String(error), true);
    }
  });

  wsRulesListEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-kind='ws-delete']");
    if (!button) {
      return;
    }

    try {
      await sendMessage({
        action: "deleteWsRule",
        id: button.dataset.id
      });
      await refreshRules();
      flash("WS 规则已删除");
    } catch (error) {
      flash(error.message || String(error), true);
    }
  });
}

async function refreshAll() {
  await refreshStatus();
  await refreshRules();
  await refreshLogs();
}

async function refreshStatus() {
  const data = await sendMessage({ action: "getTabStatus", tabId });
  toggleEnabledEl.checked = Boolean(data.enabled);
  renderStatus(Boolean(data.enabled));
}

async function refreshLogs() {
  const data = await sendMessage({
    action: "getLogs",
    tabId,
    search: searchKeyword,
    limit: 700
  });
  renderLogs(data.logs || []);
}

async function refreshRules() {
  const data = await sendMessage({ action: "listRules" });
  renderHttpRules(Array.isArray(data.httpRules) ? data.httpRules : []);
  renderWsRules(Array.isArray(data.wsRules) ? data.wsRules : []);
}

function renderStatus(enabled) {
  statusBadgeEl.textContent = enabled ? "ON" : "OFF";
  statusBadgeEl.classList.toggle("on", enabled);
  statusBadgeEl.classList.toggle("off", !enabled);
}

function renderLogs(logs) {
  if (!logs.length) {
    logsBodyEl.innerHTML = "<tr><td colspan='6'>暂无日志</td></tr>";
    return;
  }

  logsBodyEl.innerHTML = logs
    .map((item) => {
      const time = formatTime(item.time);
      const type = escapeHtml(item.resourceType || item.kind || "-");
      const phase = escapeHtml(item.phase || "-");
      const method = escapeHtml(item.method || "-");
      const status = escapeHtml(String(item.status ?? "-"));
      const details = [item.url, item.message, item.payload].filter(Boolean).join(" | ");

      return `<tr>
        <td>${time}</td>
        <td>${type}</td>
        <td>${phase}</td>
        <td>${method}</td>
        <td>${status}</td>
        <td class="url-cell">${escapeHtml(details || "-")}</td>
      </tr>`;
    })
    .join("");
}

function renderHttpRules(rules) {
  if (!rules.length) {
    httpRulesListEl.innerHTML = "<p class='empty'>暂无 HTTP 规则</p>";
    return;
  }

  httpRulesListEl.innerHTML = rules
    .map((rule) => {
      const resourceTypes = Array.isArray(rule.resourceTypes) ? rule.resourceTypes.join(",") : "ALL";
      return `<article class="rule-card">
        <div class="rule-row">
          <strong>${escapeHtml(rule.name || rule.id)}</strong>
          <label>
            <input
              type="checkbox"
              data-kind="http-toggle"
              data-id="${escapeAttr(rule.id)}"
              ${rule.enabled ? "checked" : ""}
            /> 启用
          </label>
        </div>
        <p class="rule-meta">${escapeHtml(rule.urlPattern || "*")}</p>
        <p class="rule-meta">${escapeHtml(resourceTypes)} | ${escapeHtml(rule.stage)} | ${escapeHtml(
          rule.operation
        )}</p>
        <div class="rule-actions">
          <button class="remove" type="button" data-kind="http-delete" data-id="${escapeAttr(rule.id)}">删除</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderWsRules(rules) {
  if (!rules.length) {
    wsRulesListEl.innerHTML = "<p class='empty'>暂无 WS 规则</p>";
    return;
  }

  wsRulesListEl.innerHTML = rules
    .map((rule) => {
      return `<article class="rule-card">
        <div class="rule-row">
          <strong>${escapeHtml(rule.name || rule.id)}</strong>
          <label>
            <input
              type="checkbox"
              data-kind="ws-toggle"
              data-id="${escapeAttr(rule.id)}"
              ${rule.enabled ? "checked" : ""}
            /> 启用
          </label>
        </div>
        <p class="rule-meta">${escapeHtml(rule.urlPattern || "*")}</p>
        <p class="rule-meta">out: ${escapeHtml(rule.outgoingFind || "(空)")} => ${escapeHtml(
          rule.outgoingReplace || "(空)"
        )}</p>
        <p class="rule-meta">in: ${escapeHtml(rule.incomingFind || "(空)")} => ${escapeHtml(
          rule.incomingReplace || "(空)"
        )}</p>
        <div class="rule-actions">
          <button class="remove" type="button" data-kind="ws-delete" data-id="${escapeAttr(rule.id)}">删除</button>
        </div>
      </article>`;
    })
    .join("");
}

function flash(text, isError = false) {
  flashTextEl.textContent = text;
  flashTextEl.style.color = isError ? "#fecaca" : "#cbd5e1";
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "-";
  }
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return "-";
  }
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "unknown error"));
        return;
      }
      resolve(response.data);
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\s/g, "");
}
