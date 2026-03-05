(() => {
  if (window.__ajaxProxyWebSocketInstalled) {
    return;
  }
  window.__ajaxProxyWebSocketInstalled = true;

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== "function") {
    return;
  }

  let wsBridgeState = { enabled: false, rules: [] };
  let socketSeq = 0;
  const sockets = new Map();
  const incomingEventCache = new WeakMap();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.source !== "ajax-proxy-ext") return;

    if (payload.type === "WS_BRIDGE_STATE") {
      wsBridgeState = {
        enabled: Boolean(payload.payload?.enabled),
        rules: Array.isArray(payload.payload?.rules) ? payload.payload.rules : []
      };
      return;
    }

    if (payload.type === "WS_CONTROL_SEND") {
      handleControlSend(payload.payload || {});
      return;
    }

    if (payload.type === "WS_CONTROL_MOCK_INCOMING") {
      handleControlMockIncoming(payload.payload || {});
    }
  });

  class ProxyWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      if (typeof protocols === "undefined") {
        super(url);
      } else {
        super(url, protocols);
      }

      this.__listenerMap = new Map();
      this.__rawOnMessage = null;
      this.__socketId = makeSocketId();
      sockets.set(this.__socketId, this);

      emitLifecycle(this, "created", "socket created");

      super.addEventListener("open", () => {
        emitLifecycle(this, "open", "socket open");
      });
      super.addEventListener("close", (closeEvent) => {
        sockets.delete(this.__socketId);
        emitLifecycle(this, "close", `socket closed code=${closeEvent.code}`);
      });
      super.addEventListener("error", () => {
        emitLifecycle(this, "error", "socket error");
      });
    }

    send(data) {
      if (!wsBridgeState.enabled) return super.send(data);

      const rule = findRule(this.url);
      let transformed = data;
      if (rule) {
        transformed = replaceSocketData(data, rule.outgoingFind, rule.outgoingReplace);
      }
      const replaced = transformed !== data;

      emitMessage({
        socketId: this.__socketId,
        url: this.url,
        direction: "outgoing",
        ruleName: replaced ? rule?.name || rule?.id || "" : "",
        replaced,
        message: replaced ? "outgoing frame replaced" : "outgoing frame",
        data: summarizeData(transformed),
        originalData: summarizeData(data)
      });

      return super.send(transformed);
    }

    addEventListener(type, listener, options) {
      if (type !== "message" || typeof listener !== "function") {
        return super.addEventListener(type, listener, options);
      }
      const wrapped = (event) => {
        const nextEvent = processIncoming(this, event);
        return listener.call(this, nextEvent);
      };
      this.__listenerMap.set(listener, wrapped);
      return super.addEventListener(type, wrapped, options);
    }

    removeEventListener(type, listener, options) {
      if (type === "message" && typeof listener === "function") {
        const wrapped = this.__listenerMap.get(listener);
        if (wrapped) {
          this.__listenerMap.delete(listener);
          return super.removeEventListener(type, wrapped, options);
        }
      }
      return super.removeEventListener(type, listener, options);
    }

    set onmessage(handler) {
      this.__rawOnMessage = handler;
      if (typeof handler !== "function") { super.onmessage = handler; return; }
      super.onmessage = (event) => {
        const nextEvent = processIncoming(this, event);
        return handler.call(this, nextEvent);
      };
    }

    get onmessage() {
      return this.__rawOnMessage;
    }
  }

  Object.setPrototypeOf(ProxyWebSocket, NativeWebSocket);
  defineConst(ProxyWebSocket, "CONNECTING", NativeWebSocket.CONNECTING);
  defineConst(ProxyWebSocket, "OPEN", NativeWebSocket.OPEN);
  defineConst(ProxyWebSocket, "CLOSING", NativeWebSocket.CLOSING);
  defineConst(ProxyWebSocket, "CLOSED", NativeWebSocket.CLOSED);
  window.WebSocket = ProxyWebSocket;

  function processIncoming(socket, event) {
    if (!wsBridgeState.enabled) return event;

    const cached = incomingEventCache.get(event);
    if (cached) return cached;

    const rule = findRule(socket.url);
    const originalData = event.data;
    let transformed = originalData;
    if (rule) {
      transformed = replaceSocketData(originalData, rule.incomingFind, rule.incomingReplace);
    }

    const replaced = transformed !== originalData;
    emitMessage({
      socketId: socket.__socketId,
      url: socket.url,
      direction: "incoming",
      ruleName: replaced ? rule?.name || rule?.id || "" : "",
      replaced,
      message: replaced ? "incoming frame replaced" : "incoming frame",
      data: summarizeData(transformed),
      originalData: summarizeData(originalData)
    });

    const nextEvent = replaced ? cloneMessageEvent(event, transformed) : event;
    incomingEventCache.set(event, nextEvent);
    return nextEvent;
  }

  function handleControlSend(rawPayload) {
    if (!wsBridgeState.enabled) {
      emitControlResult({ requestId: String(rawPayload.requestId || ""), ok: false, error: "当前未开启全量模式" });
      return;
    }
    const requestId = String(rawPayload.requestId || "");
    const urlPattern = String(rawPayload.urlPattern || "").trim();
    const data = String(rawPayload.data || "");
    if (!requestId) return;
    if (!data) { emitControlResult({ requestId, ok: false, error: "发送内容不能为空" }); return; }

    const socket = pickSocket(urlPattern);
    if (!socket) { emitControlResult({ requestId, ok: false, error: "未找到可用 WebSocket 连接" }); return; }
    if (socket.readyState !== NativeWebSocket.OPEN) { emitControlResult({ requestId, ok: false, error: "目标连接未处于 OPEN 状态" }); return; }

    try {
      socket.send(data);
      emitControlResult({ requestId, ok: true, socketId: socket.__socketId, url: String(socket.url || "") });
    } catch (error) {
      emitControlResult({ requestId, ok: false, error: error?.message || String(error) });
    }
  }

  function handleControlMockIncoming(rawPayload) {
    if (!wsBridgeState.enabled) {
      emitControlResult({ requestId: String(rawPayload.requestId || ""), ok: false, error: "当前未开启全量模式" });
      return;
    }
    const requestId = String(rawPayload.requestId || "");
    const urlPattern = String(rawPayload.urlPattern || "").trim();
    const data = String(rawPayload.data || "");
    if (!requestId) return;
    if (!data) { emitControlResult({ requestId, ok: false, error: "模拟下发内容不能为空" }); return; }

    const socket = pickSocket(urlPattern);
    if (!socket) { emitControlResult({ requestId, ok: false, error: "未找到可用 WebSocket 连接" }); return; }
    if (socket.readyState !== NativeWebSocket.OPEN) { emitControlResult({ requestId, ok: false, error: "目标连接未处于 OPEN 状态" }); return; }

    try {
      const mockEvent = new MessageEvent("message", { data });
      socket.dispatchEvent(mockEvent);
      emitControlResult({ requestId, ok: true, socketId: socket.__socketId, url: String(socket.url || "") });
    } catch (error) {
      emitControlResult({ requestId, ok: false, error: error?.message || String(error) });
    }
  }

  function pickSocket(urlPattern) {
    for (const socket of sockets.values()) {
      if (socket.readyState !== NativeWebSocket.OPEN) continue;
      if (!urlPattern || matchUrl(urlPattern, String(socket.url || ""))) return socket;
    }
    return null;
  }

  function emitLifecycle(socket, phase, message) {
    if (!wsBridgeState.enabled) return;
    emitEvent({ eventType: "ws-lifecycle", phase, socketId: socket.__socketId, url: String(socket.url || ""), readyState: socket.readyState, status: phase.toUpperCase(), message });
  }

  function emitMessage(payload) {
    if (!wsBridgeState.enabled) return;
    emitEvent({ eventType: "ws-message", ...payload });
  }

  function emitControlResult(payload) {
    window.postMessage({ source: "ajax-proxy-page", type: "WS_CONTROL_RESULT", payload }, "*");
  }

  function defineConst(target, key, value) {
    try { Object.defineProperty(target, key, { value, configurable: false, enumerable: true, writable: false }); } catch { void 0; }
  }

  function findRule(url) {
    const value = String(url || "");
    return wsBridgeState.rules.find((rule) => {
      if (rule.enabled === false) return false;
      return matchUrl(rule.urlPattern, value);
    });
  }

  function matchUrl(pattern, url) {
    const text = String(pattern || "").trim();
    if (!text) return true;
    const regexLiteral = parseRegexLiteral(text);
    if (regexLiteral) return regexLiteral.test(url);
    if (text.includes("*")) {
      const escaped = text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`, "i").test(url);
    }
    return url.includes(text);
  }

  function replaceSocketData(data, findText, replaceText) {
    if (typeof data !== "string" || !findText) return data;
    return data.split(findText).join(replaceText || "");
  }

  function cloneMessageEvent(event, data) {
    return new MessageEvent("message", { data, origin: event.origin, lastEventId: event.lastEventId, source: event.source, ports: event.ports });
  }

  function summarizeData(data) {
    if (typeof data === "string") return data.length > 1600 ? `${data.slice(0, 1600)}...(truncated)` : data;
    if (data instanceof ArrayBuffer) return `[ArrayBuffer ${data.byteLength}]`;
    if (ArrayBuffer.isView(data)) return `[TypedArray ${data.byteLength}]`;
    if (typeof Blob !== "undefined" && data instanceof Blob) return `[Blob ${data.size}]`;
    return String(data);
  }

  function emitEvent(payload) {
    window.postMessage({ source: "ajax-proxy-page", type: "WS_EVENT", payload }, "*");
  }

  function makeSocketId() {
    socketSeq += 1;
    return `ws_${Date.now().toString(36)}_${socketSeq.toString(36)}`;
  }
})();
