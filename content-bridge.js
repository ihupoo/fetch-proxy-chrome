(() => {
  if (window.__ajaxProxyBridgeInstalled) {
    return;
  }
  window.__ajaxProxyBridgeInstalled = true;

  injectInpageScript();
  syncWsRules();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "wsRulesUpdated") {
      postRulesToPage(Array.isArray(message.rules) ? message.rules : []);
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const payload = event.data;
    if (!payload || payload.source !== "ajax-proxy-page") {
      return;
    }

    if (payload.type === "WS_EVENT") {
      chrome.runtime.sendMessage(
        {
          action: "wsEvent",
          payload: payload.payload || {}
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  });

  function injectInpageScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inpage-ws.js");
    script.async = false;

    const root = document.documentElement || document.head;
    if (root) {
      root.appendChild(script);
      script.remove();
      return;
    }

    window.addEventListener(
      "DOMContentLoaded",
      () => {
        const fallbackRoot = document.documentElement || document.head;
        if (!fallbackRoot) {
          return;
        }
        fallbackRoot.appendChild(script);
        script.remove();
      },
      { once: true }
    );
  }

  function syncWsRules() {
    chrome.runtime.sendMessage({ action: "getWsRulesForTab" }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response?.ok) {
        return;
      }
      postRulesToPage(response.data?.rules || []);
    });
  }

  function postRulesToPage(rules) {
    window.postMessage(
      {
        source: "ajax-proxy-ext",
        type: "WS_RULES",
        rules
      },
      "*"
    );
  }
})();
