let currentTabId = null;

const tabInfoEl = document.getElementById("tabInfo");
const tabUrlEl = document.getElementById("tabUrl");
const statusTextEl = document.getElementById("statusText");
const statusBadgeEl = document.getElementById("statusBadge");
const modeHintEl = document.getElementById("modeHint");
const toggleEl = document.getElementById("toggleEnabled");
const openMonitorEl = document.getElementById("openMonitor");
const modeInputs = Array.from(document.querySelectorAll('input[name="runMode"]'));

let selectedMode = "quick";

init().catch((error) => {
  statusTextEl.textContent = error.message || String(error);
});

async function init() {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") throw new Error("未找到当前标签页");

  currentTabId = tab.id;
  const parsed = parseTabUrl(tab.url);
  tabInfoEl.textContent = `Tab #${currentTabId} · ${parsed.host || "(无域名)"}`;
  tabUrlEl.textContent = parsed.url || "当前页面地址不可读";
  tabUrlEl.title = parsed.url || "";

  const status = await sendMessage({ action: "getTabStatus", tabId: currentTabId });
  applyStatus(status);

  toggleEl.addEventListener("change", async () => {
    toggleEl.disabled = true;
    try {
      const next = await sendMessage({
        action: "setTabMode", tabId: currentTabId,
        mode: toggleEl.checked ? getSelectedMode() : "off"
      });
      applyStatus(next);
    } catch (error) {
      statusTextEl.textContent = error.message || String(error);
      toggleEl.checked = !toggleEl.checked;
    } finally {
      toggleEl.disabled = false;
    }
  });

  for (const input of modeInputs) {
    input.addEventListener("change", async () => {
      selectedMode = input.value === "quick" ? "quick" : "full";
      syncModeCards();
      renderModeHint(selectedMode, toggleEl.checked, null);

      if (!toggleEl.checked) return;

      try {
        const next = await sendMessage({ action: "setTabMode", tabId: currentTabId, mode: selectedMode });
        applyStatus(next);
      } catch (error) {
        statusTextEl.textContent = error.message || String(error);
      }
    });
  }

  openMonitorEl.addEventListener("click", async () => {
    const url = chrome.runtime.getURL(`monitor.html?tabId=${currentTabId}`);
    await createTab(url);
  });
}

function applyStatus(status) {
  const activeMode = status.mode === "quick" ? "quick" : status.mode === "full" ? "full" : "off";
  /* Fix: when enabled, use actual mode; when off, keep user's last selection */
  if (status.enabled && activeMode !== "off") {
    selectedMode = activeMode;
  } else if (!status.enabled) {
    selectedMode = status.preferredMode || selectedMode || "quick";
  }

  setSelectedMode(selectedMode);
  toggleEl.checked = Boolean(status.enabled);
  renderBadge(activeMode);
  renderModeHint(selectedMode, Boolean(status.enabled), status.quickSummary || null);

  if (activeMode === "quick") {
    statusTextEl.textContent = "快捷模式已开启";
  } else if (activeMode === "full") {
    statusTextEl.textContent = "全量模式已开启";
  } else {
    statusTextEl.textContent = "代理已关闭";
  }
}

function renderBadge(mode) {
  statusBadgeEl.className = "badge";
  if (mode === "quick") { statusBadgeEl.textContent = "QK"; statusBadgeEl.classList.add("quick"); }
  else if (mode === "full") { statusBadgeEl.textContent = "ON"; statusBadgeEl.classList.add("full"); }
  else { statusBadgeEl.textContent = "OFF"; statusBadgeEl.classList.add("off"); }
}

function renderModeHint(mode, enabled, quickSummary) {
  if (mode === "quick") {
    const skipped = Number(quickSummary?.skipped || 0);
    modeHintEl.textContent = enabled
      ? `快捷模式: DNR + 页面注入${skipped ? `，${skipped} 条规则被跳过` : ""}`
      : "快捷模式: 仅支持接口列表、接口/静态资源代理";
    return;
  }
  modeHintEl.textContent = enabled
    ? "全量模式: chrome.debugger，浏览器顶部会显示调试提示"
    : "全量模式: 完整请求日志、响应改写、WebSocket 调试";
}

function getSelectedMode() { return selectedMode === "quick" ? "quick" : "full"; }

function setSelectedMode(mode) {
  selectedMode = mode === "quick" ? "quick" : "full";
  for (const input of modeInputs) input.checked = input.value === selectedMode;
  syncModeCards();
}

function syncModeCards() {
  for (const input of modeInputs) {
    const card = input.closest("[data-mode-card]");
    if (card) card.classList.toggle("active", input.checked);
  }
}

function parseTabUrl(rawUrl) {
  const url = String(rawUrl || "");
  if (!url) return { url: "", host: "" };
  try { const p = new URL(url); return { url, host: p.host || p.hostname || "" }; }
  catch { return { url, host: "" }; }
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

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const e = chrome.runtime.lastError;
      if (e) { reject(new Error(e.message)); return; }
      resolve(tabs?.[0] || null);
    });
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      const e = chrome.runtime.lastError;
      if (e) { reject(new Error(e.message)); return; }
      resolve(tab);
    });
  });
}
