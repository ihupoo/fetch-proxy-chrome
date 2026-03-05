(() => {
  if (window.__ajaxProxyWebSocketInstalled) {
    return;
  }
  window.__ajaxProxyWebSocketInstalled = true;

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== "function") {
    return;
  }

  let wsRules = [];

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const payload = event.data;
    if (!payload || payload.source !== "ajax-proxy-ext" || payload.type !== "WS_RULES") {
      return;
    }

    wsRules = Array.isArray(payload.rules) ? payload.rules : [];
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
    }

    send(data) {
      const rule = findRule(this.url);
      let transformed = data;

      if (rule) {
        transformed = replaceSocketData(data, rule.outgoingFind, rule.outgoingReplace, rule.useRegex);
        if (transformed !== data) {
          emitEvent({
            url: this.url,
            direction: "outgoing",
            ruleName: rule.name || rule.id,
            message: "outgoing frame replaced",
            data: summarizeData(transformed)
          });
        }
      }

      return super.send(transformed);
    }

    addEventListener(type, listener, options) {
      if (type !== "message" || typeof listener !== "function") {
        return super.addEventListener(type, listener, options);
      }

      const wrapped = (event) => {
        const rule = findRule(this.url);
        if (!rule) {
          return listener.call(this, event);
        }

        const transformed = replaceSocketData(event.data, rule.incomingFind, rule.incomingReplace, rule.useRegex);
        if (transformed === event.data) {
          return listener.call(this, event);
        }

        emitEvent({
          url: this.url,
          direction: "incoming",
          ruleName: rule.name || rule.id,
          message: "incoming frame replaced",
          data: summarizeData(transformed)
        });

        const clonedEvent = cloneMessageEvent(event, transformed);
        return listener.call(this, clonedEvent);
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

      if (typeof handler !== "function") {
        super.onmessage = handler;
        return;
      }

      super.onmessage = (event) => {
        const rule = findRule(this.url);
        if (!rule) {
          return handler.call(this, event);
        }

        const transformed = replaceSocketData(event.data, rule.incomingFind, rule.incomingReplace, rule.useRegex);
        if (transformed === event.data) {
          return handler.call(this, event);
        }

        emitEvent({
          url: this.url,
          direction: "incoming",
          ruleName: rule.name || rule.id,
          message: "incoming frame replaced",
          data: summarizeData(transformed)
        });

        const clonedEvent = cloneMessageEvent(event, transformed);
        return handler.call(this, clonedEvent);
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

  function defineConst(target, key, value) {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: false,
        enumerable: true,
        writable: false
      });
    } catch {
      void 0;
    }
  }

  function findRule(url) {
    const value = String(url || "");
    return wsRules.find((rule) => {
      if (rule.enabled === false) {
        return false;
      }
      return matchUrl(rule.urlPattern, value, Boolean(rule.useRegex));
    });
  }

  function matchUrl(pattern, url, useRegex) {
    const text = String(pattern || "").trim();
    if (!text) {
      return true;
    }

    if (useRegex) {
      try {
        return new RegExp(text).test(url);
      } catch {
        return false;
      }
    }

    const regexLiteral = parseRegexLiteral(text);
    if (regexLiteral) {
      return regexLiteral.test(url);
    }

    if (text.includes("*")) {
      const escaped = text
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`, "i").test(url);
    }

    return url.includes(text);
  }

  function replaceSocketData(data, findText, replaceText, useRegex) {
    if (typeof data !== "string") {
      return data;
    }

    if (!findText) {
      return data;
    }

    if (useRegex) {
      try {
        const literal = parseRegexLiteral(findText);
        const regex = literal || new RegExp(findText, "g");
        return data.replace(regex, replaceText || "");
      } catch {
        return data;
      }
    }

    return data.split(findText).join(replaceText || "");
  }

  function parseRegexLiteral(text) {
    if (!text.startsWith("/") || text.lastIndexOf("/") <= 0) {
      return null;
    }

    const lastSlash = text.lastIndexOf("/");
    const body = text.slice(1, lastSlash);
    const flags = text.slice(lastSlash + 1);

    try {
      return new RegExp(body, flags);
    } catch {
      return null;
    }
  }

  function cloneMessageEvent(event, data) {
    return new MessageEvent("message", {
      data,
      origin: event.origin,
      lastEventId: event.lastEventId,
      source: event.source,
      ports: event.ports
    });
  }

  function summarizeData(data) {
    if (typeof data === "string") {
      return data.length > 800 ? `${data.slice(0, 800)}...(truncated)` : data;
    }
    if (data instanceof ArrayBuffer) {
      return `[ArrayBuffer ${data.byteLength}]`;
    }
    if (ArrayBuffer.isView(data)) {
      return `[TypedArray ${data.byteLength}]`;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return `[Blob ${data.size}]`;
    }
    return String(data);
  }

  function emitEvent(payload) {
    window.postMessage(
      {
        source: "ajax-proxy-page",
        type: "WS_EVENT",
        payload
      },
      "*"
    );
  }
})();
