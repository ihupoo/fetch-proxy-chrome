(() => {
  if (window.__ajaxProxyBridgeInstalled) {
    return;
  }
  window.__ajaxProxyBridgeInstalled = true;

  const pendingControlMap = new Map();
  const injectedFiles = new Set();
  let bridgeState = {
    mode: "off",
    httpRules: [],
    wsRules: []
  };

  void syncBridgeState();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "bridgeStateUpdated") {
      void applyBridgeState(message.state || {});
      return;
    }

    if (message?.action === "wsControlSend") {
      return handleWsControlRequest("WS_CONTROL_SEND", message, sendResponse);
    }

    if (message?.action === "wsControlMockIncoming") {
      return handleWsControlRequest("WS_CONTROL_MOCK_INCOMING", message, sendResponse);
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
        { action: "wsEvent", payload: payload.payload || {} },
        () => { void chrome.runtime.lastError; }
      );
      return;
    }

    if (payload.type === "HTTP_EVENT") {
      chrome.runtime.sendMessage(
        { action: "pageHttpEvent", payload: payload.payload || {} },
        () => { void chrome.runtime.lastError; }
      );
      return;
    }

    if (payload.type === "WS_CONTROL_RESULT") {
      const result = payload.payload || {};
      const requestId = String(result.requestId || "");
      if (!requestId) {
        return;
      }

      const pending = pendingControlMap.get(requestId);
      if (!pending) {
        return;
      }

      pendingControlMap.delete(requestId);
      clearTimeout(pending.timeout);
      pending.sendResponse({
        ok: Boolean(result.ok),
        error: String(result.error || ""),
        data: {
          requestId,
          url: String(result.url || ""),
          sent: Boolean(result.ok),
          socketId: String(result.socketId || "")
        }
      });
    }
  });

  function syncBridgeState() {
    chrome.runtime.sendMessage({ action: "getBridgeStateForTab" }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response?.ok) {
        return;
      }
      void applyBridgeState(response.data || {});
    });
  }

  async function applyBridgeState(nextState) {
    bridgeState = {
      mode: nextState?.mode === "quick" ? "quick" : nextState?.mode === "full" ? "full" : "off",
      httpRules: Array.isArray(nextState?.httpRules) ? nextState.httpRules : [],
      wsRules: Array.isArray(nextState?.wsRules) ? nextState.wsRules : []
    };

    if (bridgeState.mode === "quick") {
      await injectInpageScript("inpage-http.js");
      postQuickState(true, bridgeState.httpRules);
      postWsState(false, []);
      return;
    }

    if (bridgeState.mode === "full") {
      await injectInpageScript("inpage-ws.js");
      postQuickState(false, []);
      postWsState(true, bridgeState.wsRules);
      return;
    }

    postQuickState(false, []);
    postWsState(false, []);
  }

  function injectInpageScript(fileName) {
    if (injectedFiles.has(fileName)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(fileName);
      script.async = false;
      script.onload = () => {
        injectedFiles.add(fileName);
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        resolve();
      };

      const appendScript = () => {
        const root = document.documentElement || document.head || document.body;
        if (!root) {
          window.requestAnimationFrame(appendScript);
          return;
        }
        root.appendChild(script);
      };

      appendScript();
    });
  }

  function postQuickState(enabled, rules) {
    window.postMessage(
      { source: "ajax-proxy-ext", type: "HTTP_BRIDGE_STATE", payload: { enabled: Boolean(enabled), rules: Array.isArray(rules) ? rules : [] } },
      "*"
    );
  }

  function postWsState(enabled, rules) {
    window.postMessage(
      { source: "ajax-proxy-ext", type: "WS_BRIDGE_STATE", payload: { enabled: Boolean(enabled), rules: Array.isArray(rules) ? rules : [] } },
      "*"
    );
  }

  function handleWsControlRequest(type, message, sendResponse) {
    if (bridgeState.mode !== "full") {
      sendResponse({ ok: false, error: "当前未开启全量模式" });
      return;
    }

    const requestId = makeId("ctrl");
    const timeout = window.setTimeout(() => {
      if (!pendingControlMap.has(requestId)) {
        return;
      }
      pendingControlMap.delete(requestId);
      sendResponse({ ok: false, error: "页面未响应，发送超时" });
    }, 3500);

    pendingControlMap.set(requestId, { sendResponse, timeout });
    window.postMessage(
      {
        source: "ajax-proxy-ext",
        type,
        payload: {
          requestId,
          urlPattern: String(message.urlPattern || ""),
          data: String(message.data || "")
        }
      },
      "*"
    );
    return true;
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
})();
