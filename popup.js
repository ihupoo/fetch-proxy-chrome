let currentTabId = null;

const tabInfoEl = document.getElementById("tabInfo");
const statusTextEl = document.getElementById("statusText");
const toggleEl = document.getElementById("toggleEnabled");
const openMonitorEl = document.getElementById("openMonitor");

init().catch((error) => {
  statusTextEl.textContent = error.message || String(error);
});

async function init() {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    throw new Error("未找到当前标签页");
  }

  currentTabId = tab.id;
  tabInfoEl.textContent = `Tab #${currentTabId}`;

  const status = await sendMessage({ action: "getTabStatus", tabId: currentTabId });
  toggleEl.checked = Boolean(status.enabled);
  statusTextEl.textContent = status.enabled ? "代理已开启" : "代理已关闭";

  toggleEl.addEventListener("change", async () => {
    toggleEl.disabled = true;
    try {
      const next = await sendMessage({
        action: "setTabEnabled",
        tabId: currentTabId,
        enabled: toggleEl.checked
      });
      statusTextEl.textContent = next.enabled ? "代理已开启" : "代理已关闭";
    } catch (error) {
      statusTextEl.textContent = error.message || String(error);
      toggleEl.checked = !toggleEl.checked;
    } finally {
      toggleEl.disabled = false;
    }
  });

  openMonitorEl.addEventListener("click", async () => {
    const url = chrome.runtime.getURL(`monitor.html?tabId=${currentTabId}`);
    await createTab(url);
  });
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

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs?.[0] || null);
    });
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}
