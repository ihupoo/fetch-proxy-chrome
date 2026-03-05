const DEBUGGER_PROTOCOL_VERSION = "1.3";
const STORAGE_KEY = "ajax_proxy_config_v2";
const MAX_LOGS_PER_TAB = 2000;
const MODE_OFF = "off";
const MODE_QUICK = "quick";
const MODE_FULL = "full";
const mockSequenceState = new Map();

const state = {
  config: { httpRules: [], wsRules: [] },
  enabledTabs: new Set(),
  attachedTabs: new Set(),
  tabModeById: new Map(),
  tabPreferredModeById: new Map(),
  quickRuleIdsByTab: new Map(),
  logsByTab: new Map(),
  requestIndexByTab: new Map()
};

void loadConfig();

chrome.runtime.onInstalled.addListener(() => { void loadConfig(); });
chrome.runtime.onStartup.addListener(() => { void loadConfig(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((data) => { sendResponse({ ok: true, data }); })
    .catch((error) => { sendResponse({ ok: false, error: error.message || String(error) }); });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;

  if (method === "Fetch.requestPaused") {
    void handleFetchPaused(source, params);
    return;
  }

  if (!state.attachedTabs.has(tabId)) return;

  switch (method) {
    case "Network.requestWillBeSent": onRequestWillBeSent(tabId, params); break;
    case "Network.responseReceived": onResponseReceived(tabId, params); break;
    case "Network.loadingFailed": onLoadingFailed(tabId, params); break;
    case "Network.loadingFinished": onLoadingFinished(tabId, params); break;
    case "Network.webSocketCreated": onWebSocketCreated(tabId, params); break;
    case "Network.webSocketClosed": onWebSocketClosed(tabId, params); break;
    case "Network.webSocketFrameSent": onWebSocketFrame(tabId, params, "sent"); break;
    case "Network.webSocketFrameReceived": onWebSocketFrame(tabId, params, "received"); break;
    case "Network.webSocketHandshakeResponseReceived": onWebSocketHandshake(tabId, params); break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;

  state.attachedTabs.delete(tabId);
  state.enabledTabs.delete(tabId);
  state.tabModeById.delete(tabId);
  state.requestIndexByTab.delete(tabId);
  void pushBridgeStateToTab(tabId);
  void updateBadge(tabId, MODE_OFF);

  pushLog(tabId, { kind: "system", phase: "detach", message: `Debugger detached: ${reason || "unknown"}` });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.enabledTabs.delete(tabId);
  state.attachedTabs.delete(tabId);
  state.tabModeById.delete(tabId);
  state.tabPreferredModeById.delete(tabId);
  state.logsByTab.delete(tabId);
  state.requestIndexByTab.delete(tabId);
  void removeQuickModeRules(tabId);
});

/* ───── Message Handler ───── */

async function handleMessage(message, sender) {
  const action = message?.action;

  switch (action) {
    case "getTabStatus": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      return buildTabStatus(tabId);
    }

    case "getTabInfo": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      return await fetchTabInfo(tabId);
    }

    case "setTabEnabled": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      const enabled = Boolean(message.enabled);
      const nextMode = normalizeMode(message.mode || getPreferredMode(tabId));
      await setTabMode(tabId, enabled ? nextMode : MODE_OFF);
      return buildTabStatus(tabId);
    }

    case "setTabMode": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      await setTabMode(tabId, normalizeMode(message.mode));
      return buildTabStatus(tabId);
    }

    case "getBridgeStateForTab": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number") return { mode: MODE_OFF, wsRules: [] };
      return buildBridgeState(tabId);
    }

    case "getLogs": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      const search = String(message.search || "");
      const limit = clampNumber(Number(message.limit) || 400, 1, 2000);
      return { tabId, logs: queryLogs(tabId, search, limit) };
    }

    case "clearLogs": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      state.logsByTab.set(tabId, []);
      state.requestIndexByTab.delete(tabId);
      return { tabId, cleared: true };
    }

    case "listRules":
      return { httpRules: [...state.config.httpRules], wsRules: [...state.config.wsRules] };

    case "addHttpRule": {
      const rule = normalizeHttpRule(message.rule || {});
      state.config.httpRules.unshift(rule);
      await saveConfig();
      await syncQuickModeTabs();
      return { rule };
    }

    case "updateHttpRule": {
      const rule = normalizeHttpRule(message.rule || {});
      const idx = state.config.httpRules.findIndex((r) => r.id === rule.id);
      if (idx < 0) throw new Error("HTTP rule not found");
      state.config.httpRules[idx] = rule;
      await saveConfig();
      await syncQuickModeTabs();
      return { rule };
    }

    case "toggleHttpRule": {
      const id = String(message.id || "");
      const enabled = Boolean(message.enabled);
      const rule = state.config.httpRules.find((r) => r.id === id);
      if (!rule) throw new Error("HTTP rule not found");
      rule.enabled = enabled;
      await saveConfig();
      await syncQuickModeTabs();
      return { rule };
    }

    case "deleteHttpRule": {
      const id = String(message.id || "");
      const before = state.config.httpRules.length;
      state.config.httpRules = state.config.httpRules.filter((r) => r.id !== id);
      await saveConfig();
      await syncQuickModeTabs();
      return { deleted: before !== state.config.httpRules.length };
    }

    case "addWsRule": {
      const rule = normalizeWsRule(message.rule || {});
      state.config.wsRules.unshift(rule);
      await saveConfig();
      await broadcastBridgeStateToFullTabs();
      return { rule };
    }

    case "updateWsRule": {
      const rule = normalizeWsRule(message.rule || {});
      const idx = state.config.wsRules.findIndex((r) => r.id === rule.id);
      if (idx < 0) throw new Error("WS rule not found");
      state.config.wsRules[idx] = rule;
      await saveConfig();
      await broadcastBridgeStateToFullTabs();
      return { rule };
    }

    case "toggleWsRule": {
      const id = String(message.id || "");
      const enabled = Boolean(message.enabled);
      const rule = state.config.wsRules.find((r) => r.id === id);
      if (!rule) throw new Error("WS rule not found");
      rule.enabled = enabled;
      await saveConfig();
      await broadcastBridgeStateToFullTabs();
      return { rule };
    }

    case "deleteWsRule": {
      const id = String(message.id || "");
      const before = state.config.wsRules.length;
      state.config.wsRules = state.config.wsRules.filter((r) => r.id !== id);
      await saveConfig();
      await broadcastBridgeStateToFullTabs();
      return { deleted: before !== state.config.wsRules.length };
    }

    case "getWsRulesForTab": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number") return { rules: [] };
      return { tabId, rules: getTabMode(tabId) === MODE_FULL ? getEnabledWsRules() : [] };
    }

    case "pageHttpEvent": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number" || getTabMode(tabId) !== MODE_QUICK) return { accepted: false };
      const p = message.payload || {};
      pushLog(tabId, {
        kind: String(p.kind || "quick-http"),
        phase: String(p.phase || "request"),
        requestId: String(p.requestId || ""),
        url: String(p.url || ""),
        method: String(p.method || "GET"),
        resourceType: String(p.resourceType || "Fetch"),
        status: p.status ?? "-",
        message: String(p.message || ""),
        payload: summarizeText(String(p.payload || ""), 1200),
        details: toSerializable(p.details || {})
      });
      return { accepted: true };
    }

    case "wsEvent": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number" || getTabMode(tabId) !== MODE_FULL) return { accepted: false };
      const p = message.payload || {};
      const eventType = String(p.eventType || "ws-message");

      if (eventType === "ws-lifecycle") {
        pushLog(tabId, {
          kind: "ws-live", phase: String(p.phase || "lifecycle"),
          url: String(p.url || ""), method: "WS", resourceType: "WebSocket",
          status: String(p.status || "-"), message: String(p.message || ""),
          details: { socketId: String(p.socketId || ""), readyState: p.readyState ?? null }
        });
        return { accepted: true };
      }

      const direction = p.direction === "incoming" ? "incoming" : "outgoing";
      const replaced = Boolean(p.replaced);
      const ruleName = String(p.ruleName || "");
      const status = replaced ? `replaced${ruleName ? ` (${ruleName})` : ""}` : "pass-through";

      pushLog(tabId, {
        kind: "ws-live", phase: direction,
        url: String(p.url || ""), method: direction === "outgoing" ? "SEND" : "RECV",
        resourceType: "WebSocket", status, message: String(p.message || ""),
        payload: summarizeText(String(p.data || ""), 1200),
        details: {
          socketId: String(p.socketId || ""),
          originalPayload: summarizeText(String(p.originalData || ""), 1200),
          replaced, ruleName
        }
      });
      return { accepted: true };
    }

    case "wsSendMessage": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      if (getTabMode(tabId) !== MODE_FULL) throw new Error("当前标签页未开启全量模式");
      const data = String(message.data || "");
      if (!data) throw new Error("WS 发送内容不能为空");

      const response = await sendMessageToTabWithResponse(tabId, {
        action: "wsControlSend",
        urlPattern: String(message.urlPattern || ""),
        data
      });
      if (!response?.ok) throw new Error(response?.error || "WS 发送失败");
      return response.data || { sent: true };
    }

    case "wsMockIncomingMessage": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      if (getTabMode(tabId) !== MODE_FULL) throw new Error("当前标签页未开启全量模式");
      const data = String(message.data || "");
      if (!data) throw new Error("WS 模拟下发内容不能为空");

      const response = await sendMessageToTabWithResponse(tabId, {
        action: "wsControlMockIncoming",
        urlPattern: String(message.urlPattern || ""),
        data
      });
      if (!response?.ok) throw new Error(response?.error || "WS 模拟下发失败");
      return response.data || { sent: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/* ───── Debugger: Fetch Interception ───── */

async function handleFetchPaused(source, params) {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;

  const isResponseStage = typeof params.responseStatusCode === "number";

  if (!state.enabledTabs.has(tabId)) {
    await continuePaused(source, params.requestId, isResponseStage);
    return;
  }

  const stage = isResponseStage ? "response" : "request";
  const url = String(params.request?.url || "");
  const resourceType = String(params.resourceType || "Other");

  const rule = findMatchingHttpRule(url, resourceType, stage);
  if (!rule) {
    await continuePaused(source, params.requestId, isResponseStage);
    return;
  }

  try {
    if (stage === "request") {
      if (rule.operation !== "fulfill") {
        await continuePaused(source, params.requestId, false);
        return;
      }

      const body = resolveRuleResponseBody(rule);
      await debuggerSendCommand(source, "Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: getResponseCode(rule.statusCode, 200),
        responseHeaders: buildResponseHeaders([], rule.contentType),
        body: utf8ToBase64(body)
      });

      pushLog(tabId, {
        kind: "proxy", phase: "mock-request", url,
        method: params.request?.method || "GET", resourceType,
        status: getResponseCode(rule.statusCode, 200),
        message: `Matched HTTP rule: ${rule.name || rule.id}`
      });
      return;
    }

    /* response stage */
    let patchedBody = resolveRuleResponseBody(rule);

    if (rule.operation === "replace") {
      const bodyResult = await debuggerSendCommand(source, "Fetch.getResponseBody", { requestId: params.requestId });
      const originalBody = bodyResult?.base64Encoded
        ? base64ToUtf8(String(bodyResult.body || ""))
        : String(bodyResult?.body || "");
      patchedBody = applyBodyReplace(originalBody, rule);
    }

    const headers = buildResponseHeaders(params.responseHeaders || [], rule.contentType);

    await debuggerSendCommand(source, "Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: getResponseCode(rule.statusCode, params.responseStatusCode || 200),
      responseHeaders: headers,
      body: utf8ToBase64(patchedBody)
    });

    pushLog(tabId, {
      kind: "proxy", phase: "mock-response", url,
      method: params.request?.method || "GET", resourceType,
      status: getResponseCode(rule.statusCode, params.responseStatusCode || 200),
      message: `Matched HTTP rule: ${rule.name || rule.id}`
    });
  } catch (error) {
    pushLog(tabId, {
      kind: "error", phase: "proxy", url, resourceType,
      message: `Proxy failed: ${error.message || String(error)}`
    });
    await continuePaused(source, params.requestId, isResponseStage);
  }
}

async function continuePaused(source, requestId, isResponseStage) {
  const method = isResponseStage ? "Fetch.continueResponse" : "Fetch.continueRequest";
  await debuggerSendCommand(source, method, { requestId }).catch(() => {});
}

/* ───── Network Events ───── */

function onRequestWillBeSent(tabId, params) {
  const requestId = String(params.requestId || "");
  const url = String(params.request?.url || "");
  const method = String(params.request?.method || "GET");
  const resourceType = String(params.type || "Other");
  const postData = String(params.request?.postData || "");

  const logEntry = pushLog(tabId, {
    kind: "http", phase: "request", requestId, url, method, resourceType, status: "-",
    details: {
      initiator: toSerializable(params.initiator),
      requestHeaders: toSerializable(params.request?.headers || {}),
      postData: postData ? summarizeText(postData, 3000) : "",
      referrerPolicy: String(params.request?.referrerPolicy || "")
    }
  });

  const index = ensureRequestIndex(tabId);
  index.set(requestId, { logId: logEntry.id, startedAt: Date.now(), url, method, resourceType });
}

function onResponseReceived(tabId, params) {
  const requestId = String(params.requestId || "");
  const index = ensureRequestIndex(tabId);
  const meta = index.get(requestId);
  const status = Number(params.response?.status || 0);
  const url = String(params.response?.url || meta?.url || "");

  pushLog(tabId, {
    kind: "http", phase: "response", requestId, url,
    method: String(meta?.method || "-"),
    resourceType: String(params.type || "Other"),
    status,
    message: String(params.response?.mimeType || ""),
    details: {
      statusText: String(params.response?.statusText || ""),
      protocol: String(params.response?.protocol || ""),
      remoteIPAddress: String(params.response?.remoteIPAddress || ""),
      responseHeaders: toSerializable(params.response?.headers || {})
    }
  });
}

function onLoadingFailed(tabId, params) {
  const requestId = String(params.requestId || "");
  const meta = ensureRequestIndex(tabId).get(requestId);

  pushLog(tabId, {
    kind: "http", phase: "failed", requestId,
    url: String(meta?.url || ""), method: String(meta?.method || "-"),
    resourceType: String(params.type || "Other"), status: "ERR",
    message: String(params.errorText || "request failed"),
    details: { canceled: Boolean(params.canceled), blockedReason: String(params.blockedReason || "") }
  });
}

function onLoadingFinished(tabId, params) {
  const requestId = String(params.requestId || "");
  const meta = ensureRequestIndex(tabId).get(requestId);
  if (!meta) return;

  const duration = Date.now() - meta.startedAt;
  pushLog(tabId, {
    kind: "http", phase: "finished", requestId,
    url: String(meta.url || ""), method: String(meta.method || "-"),
    resourceType: String(meta.resourceType || "HTTP"), status: "OK",
    message: `duration=${duration}ms size=${Number(params.encodedDataLength || 0)}B`,
    details: { duration, encodedDataLength: Number(params.encodedDataLength || 0) }
  });
}

function onWebSocketCreated(tabId, params) {
  const requestId = String(params.requestId || "");
  const url = String(params.url || "");
  const index = ensureRequestIndex(tabId);
  index.set(requestId, { ...(index.get(requestId) || {}), wsUrl: url });
  pushLog(tabId, { kind: "ws", phase: "created", requestId, url, resourceType: "WebSocket", status: "OPEN" });
}

function onWebSocketClosed(tabId, params) {
  const requestId = String(params.requestId || "");
  const meta = ensureRequestIndex(tabId).get(requestId);
  pushLog(tabId, { kind: "ws", phase: "closed", requestId, url: String(meta?.wsUrl || ""), resourceType: "WebSocket", status: "CLOSED" });
}

function onWebSocketHandshake(tabId, params) {
  const requestId = String(params.requestId || "");
  const meta = ensureRequestIndex(tabId).get(requestId);
  pushLog(tabId, {
    kind: "ws", phase: "handshake", requestId, url: String(meta?.wsUrl || ""),
    resourceType: "WebSocket", status: Number(params.response?.status || 0),
    message: String(params.response?.statusText || ""),
    details: { responseHeaders: toSerializable(params.response?.headers || {}) }
  });
}

function onWebSocketFrame(tabId, params, direction) {
  const requestId = String(params.requestId || "");
  const meta = ensureRequestIndex(tabId).get(requestId);
  const payload = String(params.response?.payloadData || "");

  pushLog(tabId, {
    kind: "ws", phase: direction, requestId, url: String(meta?.wsUrl || ""),
    resourceType: "WebSocket", status: direction.toUpperCase(),
    payload: summarizeText(payload, 1200),
    details: { opcode: Number(params.response?.opcode ?? -1), mask: Boolean(params.response?.mask), payloadLength: payload.length }
  });
}

/* ───── HTTP Rule Matching ───── */

function findMatchingHttpRule(url, resourceType, stage) {
  for (const rule of state.config.httpRules) {
    if (!rule.enabled) continue;
    if (rule.stage !== stage) continue;
    if (!urlMatches(rule.urlPattern, url)) continue;
    return rule;
  }
  return null;
}


function urlMatches(pattern, url) {
  const text = String(pattern || "").trim();
  if (!text) return true;
  const regex = tryParseRegex(text);
  if (regex) return regex.test(url);
  if (text.includes("*")) {
    const escaped = text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(url);
  }
  return url.includes(text);
}

function applyBodyReplace(origin, rule) {
  if (rule.replaceFrom) {
    return origin.split(rule.replaceFrom).join(rule.replaceTo || "");
  }
  const body = resolveRuleResponseBody(rule);
  if (body.length > 0) return body;
  return origin;
}

function resolveRuleResponseBody(rule) {
  const body = String(rule?.responseBody || "");
  if (rule?.responseMode !== "mock") return body;
  return renderMockResponse(body, rule?.contentType || "");
}

function renderMockResponse(templateText, contentType) {
  const trimmed = String(templateText || "").trim();
  if (!trimmed) return "";

  let template;
  try {
    template = JSON.parse(trimmed);
  } catch {
    throw new Error("Mock 模板必须是合法 JSON");
  }

  const result = generateMockValue(template, createMockContext());
  if (typeof result === "string" && !looksLikeJsonContentType(contentType)) {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

function createMockContext() {
  return {
    now: new Date()
  };
}

function generateMockValue(template, context, path = "$") {
  if (Array.isArray(template)) {
    return template.map((item, index) => generateMockValue(item, context, `${path}[${index}]`));
  }

  if (template && typeof template === "object") {
    const output = {};
    for (const [rawKey, rawValue] of Object.entries(template)) {
      const parsed = parseMockPropertyKey(rawKey);
      output[parsed.name] = generateMockPropertyValue(parsed, rawValue, context, `${path}.${parsed.name}`);
    }
    return output;
  }

  return generatePrimitiveValue(template, null, context, path);
}

function generateMockPropertyValue(parsedKey, template, context, path) {
  const rule = parsedKey.rule;
  if (Array.isArray(template)) {
    return generateMockArray(template, rule, context, path);
  }
  if (typeof template === "number") {
    return generateMockNumber(template, rule, context, path);
  }
  if (typeof template === "boolean") {
    return generateMockBoolean(template, rule);
  }
  if (typeof template === "string") {
    return generatePrimitiveValue(template, rule, context, path);
  }
  if (template && typeof template === "object") {
    const generated = generateMockValue(template, context, path);
    if (rule?.kind === "range") {
      return pickRandomObjectSubset(generated, rule);
    }
    return generated;
  }
  return template;
}

function generatePrimitiveValue(value, rule, context, path) {
  if (typeof value !== "string") return value;
  if (rule?.kind === "repeat") {
    return value.repeat(clampNumber(rule.min, 0, 1000));
  }
  if (rule?.kind === "range") {
    return value.repeat(clampNumber(randomInt(rule.min, rule.max), 0, 1000));
  }
  if (value.startsWith("@") && isSinglePlaceholder(value)) {
    return evaluatePlaceholder(value.slice(1), context, path);
  }
  return replacePlaceholders(value, context, path);
}

function generateMockArray(template, rule, context, path) {
  if (!template.length) return [];
  if (!rule) return template.map((item, index) => generateMockValue(item, context, `${path}[${index}]`));

  if (rule.kind === "pick") {
    const picked = template[randomInt(0, template.length - 1)];
    return generateMockValue(picked, context, `${path}[pick]`);
  }

  if (rule.kind === "step") {
    const index = nextSequenceValue(path, rule.step) % template.length;
    return generateMockValue(template[index], context, `${path}[${index}]`);
  }

  if (rule.kind === "range") {
    const count = randomInt(rule.min, rule.max);
    const list = [];
    for (let i = 0; i < count; i += 1) {
      const picked = template[randomInt(0, template.length - 1)];
      list.push(generateMockValue(picked, context, `${path}[${i}]`));
    }
    return list;
  }

  return template.map((item, index) => generateMockValue(item, context, `${path}[${index}]`));
}

function generateMockNumber(template, rule, context, path) {
  if (!rule) return template;

  if (rule.kind === "step") {
    return template + (nextSequenceValue(path, rule.step) * rule.step);
  }

  if (rule.kind === "range") {
    if (rule.decimalMin != null && rule.decimalMax != null) {
      const precision = randomInt(rule.decimalMin, rule.decimalMax);
      return randomFloat(rule.min, rule.max, precision);
    }
    return randomInt(rule.min, rule.max);
  }

  return template;
}

function generateMockBoolean(template, rule) {
  if (!rule) return template;
  if (rule.kind === "pick") {
    return Math.random() >= 0.5;
  }
  if (rule.kind === "range") {
    const total = Math.max(1, rule.min + rule.max);
    return Math.random() < (rule.min / total);
  }
  return template;
}

function parseMockPropertyKey(rawKey) {
  const text = String(rawKey || "");
  const index = text.indexOf("|");
  if (index < 0) return { name: text, rule: null };

  const name = text.slice(0, index);
  const rawRule = text.slice(index + 1).trim();
  const floatMatch = rawRule.match(/^(\d+)-(\d+)\.(\d+)-(\d+)$/);
  if (floatMatch) {
    return {
      name,
      rule: {
        kind: "range",
        min: Number(floatMatch[1]),
        max: Number(floatMatch[2]),
        decimalMin: Number(floatMatch[3]),
        decimalMax: Number(floatMatch[4])
      }
    };
  }

  const rangeMatch = rawRule.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    return {
      name,
      rule: { kind: "range", min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) }
    };
  }

  const stepMatch = rawRule.match(/^\+(\d+)$/);
  if (stepMatch) {
    return {
      name,
      rule: { kind: "step", step: Number(stepMatch[1]) }
    };
  }

  const pickMatch = rawRule.match(/^(\d+)$/);
  if (pickMatch) {
    return {
      name,
      rule: { kind: "pick", min: Number(pickMatch[1]) }
    };
  }

  return { name, rule: null };
}

function replacePlaceholders(value, context, path) {
  return value.replace(/@([A-Za-z_]\w*(?:\([^@]*?\))?)/g, (match, expr, offset) => {
    const resolved = evaluatePlaceholder(expr, context, `${path}@${offset}`);
    return resolved == null ? "" : String(resolved);
  });
}

function isSinglePlaceholder(value) {
  return /^@[A-Za-z_]\w*(?:\([^@]*\))?$/.test(value);
}

function evaluatePlaceholder(expr, context, path) {
  const text = String(expr || "").trim();
  const match = text.match(/^([A-Za-z_]\w*)(?:\((.*)\))?$/);
  if (!match) return `@${text}`;

  const name = match[1].toLowerCase();
  const args = splitPlaceholderArgs(match[2] || "").map(stripQuotedString);
  switch (name) {
    case "guid":
    case "uuid":
      return randomUuid();
    case "id":
      return `${Date.now()}${String(randomInt(1000, 9999))}`;
    case "boolean":
    case "bool":
      return Math.random() >= 0.5;
    case "integer":
    case "int":
      return randomInt(Number(args[0] || 0), Number(args[1] || 100));
    case "float": {
      const precision = randomInt(Number(args[2] || 0), Number(args[3] || args[2] || 2));
      return randomFloat(Number(args[0] || 0), Number(args[1] || 100), precision);
    }
    case "pick":
      return args.length ? args[randomInt(0, args.length - 1)] : "";
    case "word":
      return randomWord(Number(args[0] || 3), Number(args[1] || args[0] || 10));
    case "title":
      return randomWords(Number(args[0] || 3), Number(args[1] || args[0] || 7), true);
    case "sentence":
      return `${randomWords(Number(args[0] || 6), Number(args[1] || args[0] || 12), false)}.`;
    case "paragraph":
      return randomParagraph(Number(args[0] || 2), Number(args[1] || args[0] || 4));
    case "name":
      return randomEnglishName();
    case "cname":
      return randomChineseName();
    case "date":
      return formatDate(context.now);
    case "time":
      return formatTime(context.now);
    case "datetime":
      return formatDateTime(context.now);
    case "now":
      return formatNowByUnit(context.now, args[0] || "");
    case "email":
      return `${randomWord(5, 10)}@${randomDomain()}`;
    case "url":
      return `https://${randomDomain()}/${randomWord(4, 10)}`;
    case "domain":
      return randomDomain();
    case "ip":
      return `${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
    case "color":
      return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
    default:
      return `@${text}`;
  }
}

function splitPlaceholderArgs(rawArgs) {
  const text = String(rawArgs || "").trim();
  if (!text) return [];

  const result = [];
  let current = "";
  let quote = "";
  for (const char of text) {
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = "";
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function stripQuotedString(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\""))) {
    return text.slice(1, -1);
  }
  return text;
}

function nextSequenceValue(path, step) {
  const key = `${path}:${step}`;
  const current = mockSequenceState.get(key) || 0;
  mockSequenceState.set(key, current + 1);
  return current;
}

function pickRandomObjectSubset(objectValue, rule) {
  const entries = Object.entries(objectValue || {});
  if (!entries.length) return {};
  const count = clampNumber(randomInt(rule.min, rule.max), 0, entries.length);
  const shuffled = [...entries].sort(() => Math.random() - 0.5).slice(0, count);
  return Object.fromEntries(shuffled);
}

function randomInt(min, max) {
  const start = Math.min(Number(min), Number(max));
  const end = Math.max(Number(min), Number(max));
  return Math.floor(Math.random() * (end - start + 1)) + start;
}

function randomFloat(min, max, precision) {
  const value = Math.random() * (Math.max(min, max) - Math.min(min, max)) + Math.min(min, max);
  return Number(value.toFixed(clampNumber(precision, 0, 10)));
}

function randomWord(min = 3, max = 10) {
  const length = randomInt(min, max);
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += alphabet[randomInt(0, alphabet.length - 1)];
  }
  return output;
}

function randomWords(min, max, capitalize) {
  const count = randomInt(min, max);
  const words = Array.from({ length: count }, () => randomWord(3, 10));
  if (capitalize && words.length) words[0] = `${words[0][0].toUpperCase()}${words[0].slice(1)}`;
  return words.join(" ");
}

function randomParagraph(min, max) {
  const count = randomInt(min, max);
  return Array.from({ length: count }, () => `${randomWords(6, 12, true)}.`).join(" ");
}

function randomEnglishName() {
  const firstNames = ["Liam", "Olivia", "Noah", "Emma", "Ava", "Mia", "Ethan", "Lucas"];
  const lastNames = ["Smith", "Johnson", "Brown", "Taylor", "Lee", "Martin", "Walker", "Young"];
  return `${firstNames[randomInt(0, firstNames.length - 1)]} ${lastNames[randomInt(0, lastNames.length - 1)]}`;
}

function randomChineseName() {
  const surnames = ["张", "王", "李", "赵", "刘", "陈", "杨", "黄"];
  const names = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "婷", "鑫", "杰"];
  return `${surnames[randomInt(0, surnames.length - 1)]}${names[randomInt(0, names.length - 1)]}${names[randomInt(0, names.length - 1)]}`;
}

function randomDomain() {
  const suffixes = ["com", "cn", "net", "io"];
  return `${randomWord(5, 10)}.${suffixes[randomInt(0, suffixes.length - 1)]}`;
}

function randomUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === "x" ? rand : ((rand & 0x3) | 0x8);
    return value.toString(16);
  });
}

function formatDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatTime(date) {
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join(":");
}

function formatDateTime(date) {
  return `${formatDate(date)} ${formatTime(date)}`;
}

function formatNowByUnit(date, unit) {
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "year") return String(date.getFullYear());
  if (normalized === "month") return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  if (normalized === "day") return formatDate(date);
  if (normalized === "hour") return `${formatDate(date)} ${String(date.getHours()).padStart(2, "0")}:00:00`;
  return formatDateTime(date);
}

function looksLikeJsonContentType(contentType) {
  return /json/i.test(String(contentType || ""));
}

function buildResponseHeaders(currentHeaders, contentType) {
  const headers = Array.isArray(currentHeaders)
    ? currentHeaders
        .filter((h) => { const k = String(h.name || "").toLowerCase(); return k !== "content-length" && k !== "content-encoding"; })
        .map((h) => ({ name: String(h.name || ""), value: String(h.value || "") }))
    : [];
  upsertHeader(headers, "Access-Control-Allow-Origin", "*");
  upsertHeader(headers, "Access-Control-Allow-Credentials", "true");
  if (contentType) upsertHeader(headers, "Content-Type", contentType);
  return headers;
}

function upsertHeader(headers, name, value) {
  const idx = headers.findIndex((h) => String(h.name || "").toLowerCase() === name.toLowerCase());
  if (idx >= 0) { headers[idx] = { name, value }; return; }
  headers.push({ name, value });
}

/* ───── Mode & Tab Management ───── */

function normalizeMode(value) {
  if (value === MODE_QUICK) return MODE_QUICK;
  if (value === MODE_FULL) return MODE_FULL;
  return MODE_OFF;
}

function getTabMode(tabId) { return state.tabModeById.get(tabId) || MODE_OFF; }
function getPreferredMode(tabId) { return state.tabPreferredModeById.get(tabId) || MODE_QUICK; }

function buildTabStatus(tabId) {
  const mode = getTabMode(tabId);
  return {
    tabId, mode, preferredMode: getPreferredMode(tabId),
    enabled: mode !== MODE_OFF, attached: state.attachedTabs.has(tabId),
    quickSummary: getQuickModeSummary()
  };
}

function buildBridgeState(tabId) {
  const mode = getTabMode(tabId);
  return {
    tabId,
    mode,
    httpRules: mode === MODE_QUICK ? getEnabledQuickBridgeHttpRules() : [],
    wsRules: mode === MODE_FULL ? getEnabledWsRules() : []
  };
}

async function setTabMode(tabId, mode) {
  const nextMode = normalizeMode(mode);
  const currentMode = getTabMode(tabId);
  if (nextMode !== MODE_OFF) state.tabPreferredModeById.set(tabId, nextMode);

  if (currentMode === nextMode) {
    if (nextMode === MODE_QUICK) await syncQuickModeRulesForTab(tabId);
    await pushBridgeStateToTab(tabId);
    await updateBadge(tabId, nextMode);
    return;
  }

  if (currentMode === MODE_FULL) await detachDebugger(tabId);
  if (currentMode === MODE_QUICK) await removeQuickModeRules(tabId);
  state.requestIndexByTab.delete(tabId);

  if (nextMode === MODE_OFF) {
    state.enabledTabs.delete(tabId);
    state.tabModeById.delete(tabId);
    await pushBridgeStateToTab(tabId);
    await updateBadge(tabId, MODE_OFF);
    pushLog(tabId, { kind: "system", phase: "toggle", message: "Proxy disabled" });
    return;
  }

  state.enabledTabs.add(tabId);
  state.tabModeById.set(tabId, nextMode);

  try {
    if (nextMode === MODE_QUICK) {
      await syncQuickModeRulesForTab(tabId);
      await pushBridgeStateToTab(tabId);
      await updateBadge(tabId, MODE_QUICK);
      pushLog(tabId, { kind: "system", phase: "toggle", message: "Quick mode enabled" });
      return;
    }

    await removeQuickModeRules(tabId);
    await attachDebugger(tabId);
    await pushBridgeStateToTab(tabId);
    await updateBadge(tabId, MODE_FULL);
    pushLog(tabId, { kind: "system", phase: "toggle", message: "Full mode enabled" });
  } catch (error) {
    state.enabledTabs.delete(tabId);
    state.tabModeById.delete(tabId);
    await pushBridgeStateToTab(tabId);
    await updateBadge(tabId, MODE_OFF);
    throw error;
  }
}

/* ───── Debugger Attach/Detach ───── */

async function attachDebugger(tabId) {
  if (state.attachedTabs.has(tabId)) return;
  const target = { tabId };
  await debuggerAttach(target);
  try {
    await debuggerSendCommand(target, "Network.enable", {});
    await debuggerSendCommand(target, "Fetch.enable", {
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
        { urlPattern: "*", requestStage: "Response" }
      ]
    });
  } catch (error) {
    await debuggerDetach(target).catch(() => {});
    throw error;
  }
  state.attachedTabs.add(tabId);
}

async function detachDebugger(tabId) {
  if (!state.attachedTabs.has(tabId)) return;
  const target = { tabId };
  await debuggerSendCommand(target, "Fetch.disable", {}).catch(() => {});
  await debuggerSendCommand(target, "Network.disable", {}).catch(() => {});
  await debuggerDetach(target).catch(() => {});
  state.attachedTabs.delete(tabId);
  state.requestIndexByTab.delete(tabId);
}

/* ───── Quick Mode (DNR) ───── */

async function syncQuickModeTabs() {
  for (const [tabId, mode] of state.tabModeById.entries()) {
    if (mode !== MODE_QUICK) continue;
    await syncQuickModeRulesForTab(tabId);
    await pushBridgeStateToTab(tabId);
  }
}

async function syncQuickModeRulesForTab(tabId) {
  const { ruleIds, rules } = buildQuickSessionRules(tabId);
  const previousRuleIds = state.quickRuleIdsByTab.get(tabId) || [];
  await updateSessionRules({ removeRuleIds: previousRuleIds, addRules: rules });
  state.quickRuleIdsByTab.set(tabId, ruleIds);
}

async function removeQuickModeRules(tabId) {
  const ruleIds = state.quickRuleIdsByTab.get(tabId) || [];
  if (ruleIds.length) await updateSessionRules({ removeRuleIds: ruleIds, addRules: [] }).catch(() => {});
  state.quickRuleIdsByTab.delete(tabId);
}

function buildQuickSessionRules(tabId) {
  const rules = [];
  const ruleIds = [];
  let index = 0;
  for (const rule of state.config.httpRules) {
    const sessionRule = buildQuickSessionRule(tabId, rule, index);
    if (!sessionRule) continue;
    rules.push(sessionRule);
    ruleIds.push(sessionRule.id);
    index += 1;
  }
  return { rules, ruleIds };
}

function buildQuickSessionRule(tabId, rule, index) {
  if (!isQuickDnrCompatibleHttpRule(rule)) return null;
  const resourceTypes = ["xmlhttprequest"];

  return {
    id: makeQuickRuleId(tabId, index),
    priority: Math.max(1, 10000 - index),
    action: { type: "redirect", redirect: { url: makeQuickDataUrl(rule.contentType, resolveRuleResponseBody(rule)) } },
    condition: { regexFilter: toDnrRegexFilter(rule.urlPattern), resourceTypes, tabIds: [tabId] }
  };
}

function makeQuickRuleId(tabId, index) { return ((tabId % 20000) * 100 + index + 1) | 0; }

function isQuickCompatibleHttpRule(rule) {
  return Boolean(rule?.enabled)
    && rule.stage === "request"
    && rule.operation === "fulfill";
}

function isQuickDnrCompatibleHttpRule(rule) {
  return isQuickCompatibleHttpRule(rule) && rule.responseMode !== "mock";
}

function getEnabledQuickBridgeHttpRules() {
  return state.config.httpRules
    .filter(isQuickCompatibleHttpRule)
    .map((rule) => ({
      id: String(rule.id || ""),
      name: String(rule.name || ""),
      urlPattern: String(rule.urlPattern || ""),
      statusCode: getResponseCode(rule.statusCode, 200),
      contentType: String(rule.contentType || "application/json; charset=utf-8"),
      responseMode: rule.responseMode === "mock" ? "mock" : "plain",
      responseBody: String(rule.responseBody || "")
    }));
}

function getQuickModeSummary() {
  const enabled = state.config.httpRules.filter((r) => r.enabled);
  const supported = enabled.filter(isQuickCompatibleHttpRule);
  return { totalEnabled: enabled.length, supported: supported.length, skipped: enabled.length - supported.length };
}

function toDnrRegexFilter(pattern) {
  const text = String(pattern || "").trim();
  if (!text) return ".*";
  const regex = tryParseRegex(text);
  if (regex) return regex.source;
  if (text.includes("*")) return `^${escapeRegex(text).replace(/\\\*/g, ".*")}$`;
  return escapeRegex(text);
}

function makeQuickDataUrl(contentType, body) {
  const type = String(contentType || "text/plain; charset=utf-8").trim() || "text/plain; charset=utf-8";
  return `data:${type};base64,${utf8ToBase64(String(body || ""))}`;
}

/* ───── Log Management ───── */

function queryLogs(tabId, search, limit) {
  const list = state.logsByTab.get(tabId) || [];
  const term = search.trim().toLowerCase();
  const filtered = term
    ? list.filter((item) => {
        const blob = `${item.kind || ""} ${item.phase || ""} ${item.url || ""} ${item.method || ""} ${item.resourceType || ""} ${item.status || ""} ${item.message || ""} ${item.payload || ""} ${serializeForSearch(item.details)}`.toLowerCase();
        return blob.includes(term);
      })
    : list;
  return [...filtered.slice(-limit)].reverse();
}

function pushLog(tabId, log) {
  const logs = ensureLogList(tabId);
  const entry = { id: makeId("log"), time: Date.now(), isoTime: new Date().toISOString(), ...log };
  logs.push(entry);
  if (logs.length > MAX_LOGS_PER_TAB) logs.splice(0, logs.length - MAX_LOGS_PER_TAB);
  return entry;
}

function ensureLogList(tabId) {
  if (!state.logsByTab.has(tabId)) state.logsByTab.set(tabId, []);
  return state.logsByTab.get(tabId);
}

function ensureRequestIndex(tabId) {
  if (!state.requestIndexByTab.has(tabId)) state.requestIndexByTab.set(tabId, new Map());
  return state.requestIndexByTab.get(tabId);
}

/* ───── Config Persistence ───── */

async function loadConfig() {
  const loaded = await storageGet(STORAGE_KEY);
  const data = loaded?.[STORAGE_KEY] || {};
  state.config = {
    httpRules: Array.isArray(data.httpRules) ? data.httpRules.map(normalizeHttpRule) : [],
    wsRules: Array.isArray(data.wsRules) ? data.wsRules.map(normalizeWsRule) : []
  };
}

async function saveConfig() {
  await storageSet({ [STORAGE_KEY]: { httpRules: state.config.httpRules, wsRules: state.config.wsRules } });
}

function normalizeHttpRule(input) {
  return {
    id: String(input.id || makeId("http")),
    name: String(input.name || "http-rule"),
    enabled: input.enabled !== false,
    urlPattern: String(input.urlPattern || ""),
    stage: input.stage === "response" ? "response" : "request",
    operation: input.operation === "replace" ? "replace" : "fulfill",
    statusCode: Number.isFinite(Number(input.statusCode)) ? Number(input.statusCode) : 200,
    contentType: String(input.contentType || "application/json; charset=utf-8"),
    responseMode: input.responseMode === "mock" ? "mock" : "plain",
    responseBody: String(input.responseBody || ""),
    replaceFrom: String(input.replaceFrom || ""),
    replaceTo: String(input.replaceTo || "")
  };
}

function normalizeWsRule(input) {
  return {
    id: String(input.id || makeId("ws")),
    name: String(input.name || "ws-rule"),
    enabled: input.enabled !== false,
    urlPattern: String(input.urlPattern || ""),
    incomingFind: String(input.incomingFind || ""),
    incomingReplace: String(input.incomingReplace || ""),
    outgoingFind: String(input.outgoingFind || ""),
    outgoingReplace: String(input.outgoingReplace || "")
  };
}

function getEnabledWsRules() { return state.config.wsRules.filter((r) => r.enabled); }

/* ───── Bridge Communication ───── */

async function broadcastBridgeStateToFullTabs() {
  const tabs = await tabsQuery({});
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || getTabMode(tab.id) !== MODE_FULL) continue;
    await pushBridgeStateToTab(tab.id);
  }
}

async function pushBridgeStateToTab(tabId) {
  await sendMessageToTab(tabId, { action: "bridgeStateUpdated", state: buildBridgeState(tabId) });
}

/* ───── Badge ───── */

async function updateBadge(tabId, mode) {
  const m = normalizeMode(mode);
  const text = m === MODE_QUICK ? "QK" : m === MODE_FULL ? "ON" : "";
  const color = m === MODE_QUICK ? "#2563eb" : m === MODE_FULL ? "#11d462" : "#555";
  await actionSetBadgeText({ tabId, text }).catch(() => {});
  await actionSetBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

/* ───── Tab Info ───── */

async function fetchTabInfo(tabId) {
  const tab = await tabsGet(tabId);
  const url = String(tab?.url || "");
  const parsed = safeParseUrl(url);
  return { tabId, title: String(tab?.title || ""), url, origin: parsed?.origin || "", host: parsed?.host || "", hostname: parsed?.hostname || "" };
}

/* ───── Utility Functions ───── */

function safeParseUrl(url) { if (!url) return null; try { return new URL(url); } catch { return null; } }
function tryParseRegex(rawPattern) {
  const text = String(rawPattern || "");
  if (!text.startsWith("/") || text.lastIndexOf("/") <= 0) return null;
  const lastSlash = text.lastIndexOf("/");
  try { return new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1)); } catch { return null; }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function summarizeText(text, maxLength) {
  const v = String(text || "");
  return v.length <= maxLength ? v : `${v.slice(0, maxLength)}...(truncated)`;
}

function getResponseCode(raw, fallback) {
  const code = Number(raw);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : fallback;
}

function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function escapeRegex(text) { return String(text || "").replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); }
function clampNumber(value, min, max) { return Math.min(max, Math.max(min, value)); }
function validateTabId(tabId) { if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Invalid tabId"); }
function serializeForSearch(value) { if (!value) return ""; try { return JSON.stringify(value); } catch { return String(value); } }
function toSerializable(value) { if (value == null) return value; try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } }

/* ───── Chrome API Wrappers ───── */

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve();
    });
  });
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, () => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve();
    });
  });
}

function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve(result || {});
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve(tabs || []);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve(tab || null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => { chrome.tabs.sendMessage(tabId, message, () => { resolve(); }); });
}

function sendMessageToTabWithResponse(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve(response || null);
    });
  });
}

function actionSetBadgeText(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeText(details, () => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve();
    });
  });
}

function actionSetBadgeBackgroundColor(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeBackgroundColor(details, () => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve();
    });
  });
}

function updateSessionRules(options) {
  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.updateSessionRules(options, () => {
      const e = chrome.runtime.lastError; if (e) { reject(new Error(e.message)); return; } resolve();
    });
  });
}
