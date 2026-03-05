const DEBUGGER_PROTOCOL_VERSION = "1.3";
const STORAGE_KEY = "ajax_proxy_config_v1";
const MAX_LOGS_PER_TAB = 2000;

const state = {
  config: {
    httpRules: [],
    wsRules: []
  },
  enabledTabs: new Set(),
  attachedTabs: new Set(),
  logsByTab: new Map(),
  requestIndexByTab: new Map()
};

void loadConfig();

chrome.runtime.onInstalled.addListener(() => {
  void loadConfig();
});

chrome.runtime.onStartup.addListener(() => {
  void loadConfig();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((data) => {
      sendResponse({ ok: true, data });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") {
    return;
  }

  if (method === "Fetch.requestPaused") {
    void handleFetchPaused(source, params);
    return;
  }

  if (!state.attachedTabs.has(tabId)) {
    return;
  }

  switch (method) {
    case "Network.requestWillBeSent":
      onRequestWillBeSent(tabId, params);
      break;
    case "Network.responseReceived":
      onResponseReceived(tabId, params);
      break;
    case "Network.loadingFailed":
      onLoadingFailed(tabId, params);
      break;
    case "Network.loadingFinished":
      onLoadingFinished(tabId, params);
      break;
    case "Network.webSocketCreated":
      onWebSocketCreated(tabId, params);
      break;
    case "Network.webSocketClosed":
      onWebSocketClosed(tabId, params);
      break;
    case "Network.webSocketFrameSent":
      onWebSocketFrame(tabId, params, "sent");
      break;
    case "Network.webSocketFrameReceived":
      onWebSocketFrame(tabId, params, "received");
      break;
    case "Network.webSocketHandshakeResponseReceived":
      onWebSocketHandshake(tabId, params);
      break;
    default:
      break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") {
    return;
  }

  state.attachedTabs.delete(tabId);
  state.enabledTabs.delete(tabId);
  state.requestIndexByTab.delete(tabId);
  void updateBadge(tabId, false);

  pushLog(tabId, {
    kind: "system",
    phase: "detach",
    message: `Debugger detached: ${reason || "unknown"}`
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.enabledTabs.delete(tabId);
  state.attachedTabs.delete(tabId);
  state.logsByTab.delete(tabId);
  state.requestIndexByTab.delete(tabId);
});

async function handleMessage(message, sender) {
  const action = message?.action;

  switch (action) {
    case "getTabStatus": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      return {
        tabId,
        enabled: state.enabledTabs.has(tabId),
        attached: state.attachedTabs.has(tabId)
      };
    }

    case "setTabEnabled": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      const enabled = Boolean(message.enabled);
      if (enabled) {
        await enableTab(tabId);
      } else {
        await disableTab(tabId);
      }
      return {
        tabId,
        enabled: state.enabledTabs.has(tabId),
        attached: state.attachedTabs.has(tabId)
      };
    }

    case "getLogs": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      const search = String(message.search || "");
      const limit = clampNumber(Number(message.limit) || 400, 1, 2000);
      const logs = queryLogs(tabId, search, limit);
      return { tabId, logs };
    }

    case "clearLogs": {
      const tabId = Number(message.tabId);
      validateTabId(tabId);
      state.logsByTab.set(tabId, []);
      state.requestIndexByTab.delete(tabId);
      return { tabId, cleared: true };
    }

    case "listRules": {
      return {
        httpRules: [...state.config.httpRules],
        wsRules: [...state.config.wsRules]
      };
    }

    case "addHttpRule": {
      const rule = normalizeHttpRule(message.rule || {});
      state.config.httpRules.unshift(rule);
      await saveConfig();
      return { rule };
    }

    case "updateHttpRule": {
      const rule = normalizeHttpRule(message.rule || {});
      const idx = state.config.httpRules.findIndex((item) => item.id === rule.id);
      if (idx < 0) {
        throw new Error("HTTP rule not found");
      }
      state.config.httpRules[idx] = rule;
      await saveConfig();
      return { rule };
    }

    case "toggleHttpRule": {
      const id = String(message.id || "");
      const enabled = Boolean(message.enabled);
      const rule = state.config.httpRules.find((item) => item.id === id);
      if (!rule) {
        throw new Error("HTTP rule not found");
      }
      rule.enabled = enabled;
      await saveConfig();
      return { rule };
    }

    case "deleteHttpRule": {
      const id = String(message.id || "");
      const sizeBefore = state.config.httpRules.length;
      state.config.httpRules = state.config.httpRules.filter((item) => item.id !== id);
      await saveConfig();
      return { deleted: sizeBefore !== state.config.httpRules.length };
    }

    case "addWsRule": {
      const rule = normalizeWsRule(message.rule || {});
      state.config.wsRules.unshift(rule);
      await saveConfig();
      await broadcastWsRules();
      return { rule };
    }

    case "updateWsRule": {
      const rule = normalizeWsRule(message.rule || {});
      const idx = state.config.wsRules.findIndex((item) => item.id === rule.id);
      if (idx < 0) {
        throw new Error("WS rule not found");
      }
      state.config.wsRules[idx] = rule;
      await saveConfig();
      await broadcastWsRules();
      return { rule };
    }

    case "toggleWsRule": {
      const id = String(message.id || "");
      const enabled = Boolean(message.enabled);
      const rule = state.config.wsRules.find((item) => item.id === id);
      if (!rule) {
        throw new Error("WS rule not found");
      }
      rule.enabled = enabled;
      await saveConfig();
      await broadcastWsRules();
      return { rule };
    }

    case "deleteWsRule": {
      const id = String(message.id || "");
      const sizeBefore = state.config.wsRules.length;
      state.config.wsRules = state.config.wsRules.filter((item) => item.id !== id);
      await saveConfig();
      await broadcastWsRules();
      return { deleted: sizeBefore !== state.config.wsRules.length };
    }

    case "getWsRulesForTab": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number") {
        return { rules: [] };
      }
      return {
        tabId,
        rules: state.config.wsRules.filter((item) => item.enabled)
      };
    }

    case "wsEvent": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number") {
        return { accepted: false };
      }
      const payload = message.payload || {};
      pushLog(tabId, {
        kind: "ws-proxy",
        phase: payload.direction || "unknown",
        url: String(payload.url || ""),
        method: payload.direction === "outgoing" ? "SEND" : "RECV",
        resourceType: "WebSocket",
        status: payload.ruleName || "proxy",
        message: payload.message || "",
        payload: summarizeText(String(payload.data || ""), 600)
      });
      return { accepted: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function enableTab(tabId) {
  state.enabledTabs.add(tabId);
  await attachDebugger(tabId);
  await pushWsRulesToTab(tabId);
  await updateBadge(tabId, true);

  pushLog(tabId, {
    kind: "system",
    phase: "toggle",
    message: "Proxy enabled"
  });
}

async function disableTab(tabId) {
  state.enabledTabs.delete(tabId);
  await detachDebugger(tabId);
  await updateBadge(tabId, false);

  pushLog(tabId, {
    kind: "system",
    phase: "toggle",
    message: "Proxy disabled"
  });
}

async function attachDebugger(tabId) {
  if (state.attachedTabs.has(tabId)) {
    return;
  }

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
  if (!state.attachedTabs.has(tabId)) {
    return;
  }

  const target = { tabId };

  await debuggerSendCommand(target, "Fetch.disable", {}).catch(() => {});
  await debuggerSendCommand(target, "Network.disable", {}).catch(() => {});
  await debuggerDetach(target).catch(() => {});

  state.attachedTabs.delete(tabId);
  state.requestIndexByTab.delete(tabId);
}

async function handleFetchPaused(source, params) {
  const tabId = source.tabId;
  if (typeof tabId !== "number") {
    return;
  }

  if (!state.enabledTabs.has(tabId)) {
    await continueFetchRequest(source, params.requestId);
    return;
  }

  const isResponseStage = typeof params.responseStatusCode === "number";
  const stage = isResponseStage ? "response" : "request";
  const url = String(params.request?.url || "");
  const resourceType = String(params.resourceType || "Other");

  const rule = findMatchingHttpRule(url, resourceType, stage);
  if (!rule) {
    await continueFetchRequest(source, params.requestId);
    return;
  }

  try {
    if (stage === "request") {
      if (rule.operation !== "fulfill") {
        await continueFetchRequest(source, params.requestId);
        return;
      }

      const body = String(rule.responseBody || "");
      await debuggerSendCommand(source, "Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: getResponseCode(rule.statusCode, 200),
        responseHeaders: buildResponseHeaders([], rule.contentType),
        body: utf8ToBase64(body)
      });

      pushLog(tabId, {
        kind: "proxy",
        phase: "mock-request",
        url,
        method: params.request?.method || "GET",
        resourceType,
        status: getResponseCode(rule.statusCode, 200),
        message: `Matched HTTP rule: ${rule.name || rule.id}`
      });
      return;
    }

    let patchedBody = String(rule.responseBody || "");

    if (rule.operation === "replace") {
      const bodyResult = await debuggerSendCommand(source, "Fetch.getResponseBody", {
        requestId: params.requestId
      });
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
      kind: "proxy",
      phase: "mock-response",
      url,
      method: params.request?.method || "GET",
      resourceType,
      status: getResponseCode(rule.statusCode, params.responseStatusCode || 200),
      message: `Matched HTTP rule: ${rule.name || rule.id}`
    });
  } catch (error) {
    pushLog(tabId, {
      kind: "error",
      phase: "proxy",
      url,
      resourceType,
      message: `Proxy failed: ${error.message || String(error)}`
    });
    await continueFetchRequest(source, params.requestId);
  }
}

function onRequestWillBeSent(tabId, params) {
  const requestId = String(params.requestId || "");
  const url = String(params.request?.url || "");
  const method = String(params.request?.method || "GET");
  const resourceType = String(params.type || "Other");

  const logEntry = pushLog(tabId, {
    kind: "http",
    phase: "request",
    requestId,
    url,
    method,
    resourceType,
    status: "-"
  });

  const index = ensureRequestIndex(tabId);
  index.set(requestId, { logId: logEntry.id, startedAt: Date.now() });
}

function onResponseReceived(tabId, params) {
  const requestId = String(params.requestId || "");
  const status = Number(params.response?.status || 0);
  const url = String(params.response?.url || "");
  const mimeType = String(params.response?.mimeType || "");
  const resourceType = String(params.type || "Other");

  pushLog(tabId, {
    kind: "http",
    phase: "response",
    requestId,
    url,
    method: params.response?.requestHeadersText ? "-" : "",
    resourceType,
    status,
    message: mimeType
  });
}

function onLoadingFailed(tabId, params) {
  const requestId = String(params.requestId || "");
  const resourceType = String(params.type || "Other");

  pushLog(tabId, {
    kind: "http",
    phase: "failed",
    requestId,
    url: "",
    resourceType,
    status: "ERR",
    message: String(params.errorText || "request failed")
  });
}

function onLoadingFinished(tabId, params) {
  const requestId = String(params.requestId || "");
  const index = ensureRequestIndex(tabId);
  const meta = index.get(requestId);
  if (!meta) {
    return;
  }

  const duration = Date.now() - meta.startedAt;
  pushLog(tabId, {
    kind: "http",
    phase: "finished",
    requestId,
    status: "OK",
    message: `duration=${duration}ms size=${Number(params.encodedDataLength || 0)}B`
  });
}

function onWebSocketCreated(tabId, params) {
  pushLog(tabId, {
    kind: "ws",
    phase: "created",
    requestId: String(params.requestId || ""),
    url: String(params.url || ""),
    resourceType: "WebSocket",
    status: "OPEN"
  });
}

function onWebSocketClosed(tabId, params) {
  pushLog(tabId, {
    kind: "ws",
    phase: "closed",
    requestId: String(params.requestId || ""),
    resourceType: "WebSocket",
    status: "CLOSED"
  });
}

function onWebSocketHandshake(tabId, params) {
  pushLog(tabId, {
    kind: "ws",
    phase: "handshake",
    requestId: String(params.requestId || ""),
    resourceType: "WebSocket",
    status: Number(params.response?.status || 0),
    message: String(params.response?.statusText || "")
  });
}

function onWebSocketFrame(tabId, params, direction) {
  pushLog(tabId, {
    kind: "ws",
    phase: direction,
    requestId: String(params.requestId || ""),
    resourceType: "WebSocket",
    status: direction.toUpperCase(),
    payload: summarizeText(String(params.response?.payloadData || ""), 500)
  });
}

function findMatchingHttpRule(url, resourceType, stage) {
  for (const rule of state.config.httpRules) {
    if (!rule.enabled) {
      continue;
    }
    if (rule.stage !== stage) {
      continue;
    }
    if (!resourceTypeMatches(rule.resourceTypes, resourceType)) {
      continue;
    }
    if (!urlMatches(rule.urlPattern, url)) {
      continue;
    }
    return rule;
  }
  return null;
}

function resourceTypeMatches(ruleResourceTypes, resourceType) {
  if (!Array.isArray(ruleResourceTypes) || ruleResourceTypes.length === 0) {
    return true;
  }

  const set = new Set(ruleResourceTypes.map((item) => String(item).toLowerCase()));
  if (set.has("all")) {
    return true;
  }

  return set.has(String(resourceType || "").toLowerCase());
}

function urlMatches(pattern, url) {
  const text = String(pattern || "").trim();
  if (!text) {
    return true;
  }

  const regex = tryParseRegex(text);
  if (regex) {
    return regex.test(url);
  }

  if (text.includes("*")) {
    const escaped = text
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(url);
  }

  return url.includes(text);
}

function applyBodyReplace(origin, rule) {
  if (rule.replaceFrom) {
    if (rule.useRegex) {
      const regex = tryParseRegex(rule.replaceFrom) || new RegExp(rule.replaceFrom, "g");
      return origin.replace(regex, rule.replaceTo || "");
    }
    return origin.split(rule.replaceFrom).join(rule.replaceTo || "");
  }

  if (typeof rule.responseBody === "string" && rule.responseBody.length > 0) {
    return rule.responseBody;
  }

  return origin;
}

function buildResponseHeaders(currentHeaders, contentType) {
  const headers = Array.isArray(currentHeaders)
    ? currentHeaders
        .filter((item) => {
          const key = String(item.name || "").toLowerCase();
          return key !== "content-length" && key !== "content-encoding";
        })
        .map((item) => ({ name: String(item.name || ""), value: String(item.value || "") }))
    : [];

  upsertHeader(headers, "Access-Control-Allow-Origin", "*");
  upsertHeader(headers, "Access-Control-Allow-Credentials", "true");
  if (contentType) {
    upsertHeader(headers, "Content-Type", contentType);
  }
  return headers;
}

function upsertHeader(headers, name, value) {
  const idx = headers.findIndex((item) => String(item.name || "").toLowerCase() === name.toLowerCase());
  if (idx >= 0) {
    headers[idx] = { name, value };
    return;
  }
  headers.push({ name, value });
}

async function continueFetchRequest(source, requestId) {
  await debuggerSendCommand(source, "Fetch.continueRequest", { requestId }).catch(() => {});
}

function queryLogs(tabId, search, limit) {
  const list = state.logsByTab.get(tabId) || [];
  const term = search.trim().toLowerCase();

  const filtered = term
    ? list.filter((item) => {
        const blob = `${item.kind || ""} ${item.phase || ""} ${item.url || ""} ${item.method || ""} ${item.resourceType || ""} ${item.status || ""} ${item.message || ""} ${item.payload || ""}`.toLowerCase();
        return blob.includes(term);
      })
    : list;

  const sliced = filtered.slice(-limit);
  return [...sliced].reverse();
}

function pushLog(tabId, log) {
  const logs = ensureLogList(tabId);
  const entry = {
    id: makeId("log"),
    time: Date.now(),
    isoTime: new Date().toISOString(),
    ...log
  };

  logs.push(entry);
  if (logs.length > MAX_LOGS_PER_TAB) {
    logs.splice(0, logs.length - MAX_LOGS_PER_TAB);
  }
  return entry;
}

function ensureLogList(tabId) {
  if (!state.logsByTab.has(tabId)) {
    state.logsByTab.set(tabId, []);
  }
  return state.logsByTab.get(tabId);
}

function ensureRequestIndex(tabId) {
  if (!state.requestIndexByTab.has(tabId)) {
    state.requestIndexByTab.set(tabId, new Map());
  }
  return state.requestIndexByTab.get(tabId);
}

async function loadConfig() {
  const loaded = await storageGet(STORAGE_KEY);
  const data = loaded?.[STORAGE_KEY] || {};
  const httpRules = Array.isArray(data.httpRules) ? data.httpRules.map(normalizeHttpRule) : [];
  const wsRules = Array.isArray(data.wsRules) ? data.wsRules.map(normalizeWsRule) : [];

  state.config = {
    httpRules,
    wsRules
  };
}

async function saveConfig() {
  await storageSet({
    [STORAGE_KEY]: {
      httpRules: state.config.httpRules,
      wsRules: state.config.wsRules
    }
  });
}

function normalizeHttpRule(input) {
  const resourceTypes = Array.isArray(input.resourceTypes)
    ? input.resourceTypes.map((item) => String(item).trim()).filter(Boolean)
    : String(input.resourceTypes || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    id: String(input.id || makeId("http")),
    name: String(input.name || "http-rule"),
    enabled: input.enabled !== false,
    urlPattern: String(input.urlPattern || ""),
    resourceTypes,
    stage: input.stage === "response" ? "response" : "request",
    operation: input.operation === "replace" ? "replace" : "fulfill",
    statusCode: Number.isFinite(Number(input.statusCode)) ? Number(input.statusCode) : 200,
    contentType: String(input.contentType || "application/json; charset=utf-8"),
    responseBody: String(input.responseBody || ""),
    replaceFrom: String(input.replaceFrom || ""),
    replaceTo: String(input.replaceTo || ""),
    useRegex: Boolean(input.useRegex)
  };
}

function normalizeWsRule(input) {
  return {
    id: String(input.id || makeId("ws")),
    name: String(input.name || "ws-rule"),
    enabled: input.enabled !== false,
    urlPattern: String(input.urlPattern || ""),
    useRegex: Boolean(input.useRegex),
    incomingFind: String(input.incomingFind || ""),
    incomingReplace: String(input.incomingReplace || ""),
    outgoingFind: String(input.outgoingFind || ""),
    outgoingReplace: String(input.outgoingReplace || "")
  };
}

async function broadcastWsRules() {
  const tabs = await tabsQuery({});
  const rules = state.config.wsRules.filter((item) => item.enabled);

  for (const tab of tabs) {
    if (typeof tab.id !== "number") {
      continue;
    }
    await sendMessageToTab(tab.id, {
      action: "wsRulesUpdated",
      rules
    });
  }
}

async function pushWsRulesToTab(tabId) {
  const rules = state.config.wsRules.filter((item) => item.enabled);
  await sendMessageToTab(tabId, {
    action: "wsRulesUpdated",
    rules
  });
}

async function updateBadge(tabId, enabled) {
  const text = enabled ? "ON" : "";
  await actionSetBadgeText({ tabId, text }).catch(() => {});
  await actionSetBadgeBackgroundColor({ tabId, color: enabled ? "#0b8457" : "#555" }).catch(() => {});
}

function tryParseRegex(rawPattern) {
  const text = String(rawPattern || "");
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

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function summarizeText(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...(truncated)`;
}

function getResponseCode(rawValue, fallback) {
  const code = Number(rawValue);
  if (Number.isInteger(code) && code >= 100 && code <= 599) {
    return code;
  }
  return fallback;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validateTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("Invalid tabId");
  }
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      resolve();
    });
  });
}

function actionSetBadgeText(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeText(details, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function actionSetBadgeBackgroundColor(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeBackgroundColor(details, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}
