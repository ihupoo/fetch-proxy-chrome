(() => {
  if (window.__ajaxProxyHttpInstalled) {
    return;
  }
  window.__ajaxProxyHttpInstalled = true;

  const NativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const NativeXhr = window.XMLHttpRequest;
  const nativeXhrOpen = NativeXhr?.prototype?.open;
  const nativeXhrSend = NativeXhr?.prototype?.send;
  const nativeSetRequestHeader = NativeXhr?.prototype?.setRequestHeader;

  let quickEnabled = false;
  let quickRules = [];

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const payload = event.data;
    if (!payload || payload.source !== "ajax-proxy-ext") {
      return;
    }
    if (payload.type === "HTTP_BRIDGE_STATE") {
      quickEnabled = Boolean(payload.payload?.enabled);
      quickRules = Array.isArray(payload.payload?.rules) ? payload.payload.rules : [];
    }
  });

  if (NativeFetch) {
    window.fetch = async function ajaxProxyQuickFetch(input, init) {
      if (!quickEnabled) {
        return NativeFetch(input, init);
      }

      const meta = describeFetchRequest(input, init);
      const startedAt = Date.now();

      emitHttpEvent({
        kind: "quick-http",
        phase: "request",
        requestId: meta.requestId,
        url: meta.url,
        method: meta.method,
        resourceType: "Fetch",
        status: "-",
        message: "quick fetch request",
        details: { requestHeaders: meta.headers, requestBody: summarizeValue(meta.body) }
      });

      const matchedRule = findMatchingRule(meta.url);
      if (matchedRule) {
        const body = resolveRuleResponseBody(matchedRule);
        const headers = buildMockHeaders(matchedRule.contentType);
        const duration = Date.now() - startedAt;
        emitHttpEvent({
          kind: "quick-http",
          phase: "response",
          requestId: meta.requestId,
          url: meta.url,
          method: meta.method,
          resourceType: "Fetch",
          status: normalizeStatusCode(matchedRule.statusCode),
          message: matchedRule.contentType || "mock fetch response",
          payload: summarizeText(body, 2000),
          details: {
            duration,
            proxied: true,
            mocked: true,
            ruleName: matchedRule.name || matchedRule.id || "",
            responseHeaders: headersToObject(headers)
          }
        });
        return new Response(body, {
          status: normalizeStatusCode(matchedRule.statusCode),
          headers
        });
      }

      try {
        const response = await NativeFetch(input, init);
        void reportFetchResponse(meta, response, startedAt);
        return response;
      } catch (error) {
        emitHttpEvent({
          kind: "quick-http",
          phase: "failed",
          requestId: meta.requestId,
          url: meta.url,
          method: meta.method,
          resourceType: "Fetch",
          status: "ERR",
          message: error?.message || String(error),
          details: { duration: Date.now() - startedAt }
        });
        throw error;
      }
    };
  }

  if (NativeXhr && nativeXhrOpen && nativeXhrSend && nativeSetRequestHeader) {
    NativeXhr.prototype.open = function ajaxProxyQuickOpen(method, url) {
      this.__ajaxProxyMeta = {
        requestId: makeId("xhr"),
        method: String(method || "GET").toUpperCase(),
        url: resolveUrl(url),
        headers: {},
        mocked: false,
        mockRuleName: "",
        mockContentType: "",
        mockUrl: ""
      };
      return nativeXhrOpen.apply(this, arguments);
    };

    NativeXhr.prototype.setRequestHeader = function ajaxProxyQuickSetRequestHeader(name, value) {
      const meta = ensureXhrMeta(this);
      meta.headers[String(name || "")] = String(value || "");
      return nativeSetRequestHeader.apply(this, arguments);
    };

    NativeXhr.prototype.send = function ajaxProxyQuickSend(body) {
      if (!quickEnabled) {
        return nativeXhrSend.apply(this, arguments);
      }

      const meta = ensureXhrMeta(this);
      const startedAt = Date.now();

      emitHttpEvent({
        kind: "quick-http",
        phase: "request",
        requestId: meta.requestId,
        url: meta.url,
        method: meta.method,
        resourceType: "XHR",
        status: "-",
        message: "quick xhr request",
        details: { requestHeaders: meta.headers, requestBody: summarizeValue(body) }
      });

      const matchedRule = findMatchingRule(meta.url);
      if (matchedRule) {
        meta.mocked = true;
        meta.mockRuleName = matchedRule.name || matchedRule.id || "";
        meta.mockContentType = matchedRule.contentType || "application/json; charset=utf-8";
        meta.mockUrl = meta.url;
        const dataUrl = makeDataUrl(meta.mockContentType, resolveRuleResponseBody(matchedRule));
        nativeXhrOpen.call(this, "GET", dataUrl, true);
      }

      this.addEventListener(
        "loadend",
        () => {
          if (!quickEnabled) {
            return;
          }
          const duration = Date.now() - startedAt;
          const responseHeaders = meta.mocked
            ? buildMockResponseHeaders(meta.mockContentType)
            : parseResponseHeaders(this.getAllResponseHeaders?.() || "");
          const contentType = meta.mocked
            ? meta.mockContentType
            : (this.getResponseHeader?.("content-type") || "");
          const responseUrl = meta.mocked ? meta.mockUrl : String(this.responseURL || meta.url || "");

          emitHttpEvent({
            kind: "quick-http",
            phase: this.status ? "response" : "failed",
            requestId: meta.requestId,
            url: responseUrl,
            method: meta.method,
            resourceType: "XHR",
            status: this.status || "ERR",
            message: contentType || (this.status ? `duration=${duration}ms` : "xhr request failed"),
            payload: summarizeXhrResponse(this),
            details: {
              duration,
              responseHeaders,
              proxied: Boolean(meta.mocked) || responseUrl.startsWith("data:"),
              mocked: Boolean(meta.mocked),
              ruleName: meta.mockRuleName || "",
              responseType: String(this.responseType || "text")
            }
          });
        },
        { once: true }
      );

      return meta.mocked ? nativeXhrSend.call(this) : nativeXhrSend.apply(this, arguments);
    };
  }

  async function reportFetchResponse(meta, response, startedAt) {
    const duration = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") || "";
    const payload = await summarizeFetchResponse(response.clone(), contentType);

    emitHttpEvent({
      kind: "quick-http",
      phase: "response",
      requestId: meta.requestId,
      url: String(response.url || meta.url || ""),
      method: meta.method,
      resourceType: "Fetch",
      status: response.status,
      message: contentType || `duration=${duration}ms`,
      payload,
      details: {
        duration,
        redirected: Boolean(response.redirected),
        proxied: String(response.url || "").startsWith("data:"),
        responseHeaders: Object.fromEntries(response.headers.entries())
      }
    });
  }

  function ensureXhrMeta(xhr) {
    if (!xhr.__ajaxProxyMeta) {
      xhr.__ajaxProxyMeta = { requestId: makeId("xhr"), method: "GET", url: "", headers: {}, mocked: false };
    }
    return xhr.__ajaxProxyMeta;
  }

  function describeFetchRequest(input, init) {
    const request = input instanceof Request ? input : null;
    const method = String(init?.method || request?.method || "GET").toUpperCase();
    const url = resolveUrl(request?.url || input);
    return { requestId: makeId("fetch"), method, url, headers: headersToObject(init?.headers || request?.headers), body: init?.body };
  }

  function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [String(k), String(v)]));
    if (typeof headers === "object") return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
    return {};
  }

  function resolveUrl(input) {
    const raw = String(input || "");
    if (!raw) return "";
    try { return new URL(raw, window.location.href).href; } catch { return raw; }
  }

  async function summarizeFetchResponse(response, contentType) {
    if (!isTextLikeContent(contentType)) return `[${contentType || "binary"} response]`;
    try { const text = await response.text(); return summarizeText(text, 2000); } catch { return "[unreadable response body]"; }
  }

  function summarizeXhrResponse(xhr) {
    try {
      if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "") return `[${xhr.responseType} response]`;
      return summarizeText(String(xhr.responseText || ""), 2000);
    } catch { return "[unreadable response body]"; }
  }

  function parseResponseHeaders(rawHeaders) {
    return String(rawHeaders || "").trim().split(/\r?\n/).filter(Boolean).reduce((result, line) => {
      const idx = line.indexOf(":");
      if (idx > 0) { result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
      return result;
    }, {});
  }

  function findMatchingRule(url) {
    for (const rule of quickRules) {
      if (!rule) continue;
      if (urlMatches(rule.urlPattern, url)) return rule;
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
    return String(url || "").includes(text);
  }

  function tryParseRegex(rawPattern) {
    const text = String(rawPattern || "");
    if (!text.startsWith("/") || text.lastIndexOf("/") <= 0) return null;
    const lastSlash = text.lastIndexOf("/");
    try { return new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1)); } catch { return null; }
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
      return bodyOrEmpty(templateText);
    }

    const result = generateMockValue(template, { now: new Date() });
    if (typeof result === "string" && !/json/i.test(String(contentType || ""))) return result;
    return JSON.stringify(result, null, 2);
  }

  function generateMockValue(template, context, path = "$") {
    if (Array.isArray(template)) return template.map((item, index) => generateMockValue(item, context, `${path}[${index}]`));
    if (template && typeof template === "object") {
      const output = {};
      for (const [rawKey, rawValue] of Object.entries(template)) {
        const parsed = parseMockPropertyKey(rawKey);
        output[parsed.name] = generateMockPropertyValue(parsed.rule, rawValue, context, `${path}.${parsed.name}`);
      }
      return output;
    }
    return generatePrimitiveValue(template, null, context, path);
  }

  function generateMockPropertyValue(rule, template, context, path) {
    if (Array.isArray(template)) return generateMockArray(template, rule, context, path);
    if (typeof template === "number") return generateMockNumber(template, rule, path);
    if (typeof template === "boolean") return generateMockBoolean(template, rule);
    if (typeof template === "string") return generatePrimitiveValue(template, rule, context, path);
    if (template && typeof template === "object") return generateMockValue(template, context, path);
    return template;
  }

  function generatePrimitiveValue(value, rule, context, path) {
    if (typeof value !== "string") return value;
    if (rule?.kind === "range") return value.repeat(clampNumber(randomInt(rule.min, rule.max), 0, 1000));
    if (value.startsWith("@") && isSinglePlaceholder(value)) return evaluatePlaceholder(value.slice(1), context, path);
    return value.replace(/@([A-Za-z_]\w*(?:\([^@]*?\))?)/g, (_match, expr, offset) => {
      const resolved = evaluatePlaceholder(expr, context, `${path}@${offset}`);
      return resolved == null ? "" : String(resolved);
    });
  }

  function generateMockArray(template, rule, context, path) {
    if (!template.length) return [];
    if (!rule) return template.map((item, index) => generateMockValue(item, context, `${path}[${index}]`));
    if (rule.kind === "pick") return generateMockValue(template[randomInt(0, template.length - 1)], context, `${path}[pick]`);
    if (rule.kind === "step") {
      const index = nextSequenceValue(path, rule.step) % template.length;
      return generateMockValue(template[index], context, `${path}[${index}]`);
    }
    if (rule.kind === "range") {
      const count = randomInt(rule.min, rule.max);
      const list = [];
      for (let i = 0; i < count; i += 1) {
        list.push(generateMockValue(template[randomInt(0, template.length - 1)], context, `${path}[${i}]`));
      }
      return list;
    }
    return template.map((item, index) => generateMockValue(item, context, `${path}[${index}]`));
  }

  function generateMockNumber(template, rule, path) {
    if (!rule) return template;
    if (rule.kind === "step") return template + (nextSequenceValue(path, rule.step) * rule.step);
    if (rule.kind === "range") {
      if (rule.decimalMin != null && rule.decimalMax != null) {
        return randomFloat(rule.min, rule.max, randomInt(rule.decimalMin, rule.decimalMax));
      }
      return randomInt(rule.min, rule.max);
    }
    return template;
  }

  function generateMockBoolean(template, rule) {
    if (!rule) return template;
    if (rule.kind === "pick") return Math.random() >= 0.5;
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
    if (floatMatch) return { name, rule: { kind: "range", min: Number(floatMatch[1]), max: Number(floatMatch[2]), decimalMin: Number(floatMatch[3]), decimalMax: Number(floatMatch[4]) } };
    const rangeMatch = rawRule.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) return { name, rule: { kind: "range", min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) } };
    const stepMatch = rawRule.match(/^\+(\d+)$/);
    if (stepMatch) return { name, rule: { kind: "step", step: Number(stepMatch[1]) } };
    const pickMatch = rawRule.match(/^(\d+)$/);
    if (pickMatch) return { name, rule: { kind: "pick", min: Number(pickMatch[1]) } };
    return { name, rule: null };
  }

  function evaluatePlaceholder(expr, context) {
    const match = String(expr || "").trim().match(/^([A-Za-z_]\w*)(?:\((.*)\))?$/);
    if (!match) return `@${expr}`;
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
      case "float":
        return randomFloat(Number(args[0] || 0), Number(args[1] || 100), randomInt(Number(args[2] || 0), Number(args[3] || args[2] || 2)));
      case "pick":
        return args.length ? args[randomInt(0, args.length - 1)] : "";
      case "word":
        return randomWord(Number(args[0] || 3), Number(args[1] || args[0] || 10));
      case "sentence":
        return `${randomWords(Number(args[0] || 6), Number(args[1] || args[0] || 12), false)}.`;
      case "paragraph":
        return Array.from({ length: randomInt(Number(args[0] || 2), Number(args[1] || args[0] || 4)) }, () => `${randomWords(6, 12, true)}.`).join(" ");
      case "name":
        return randomEnglishName();
      case "cname":
        return randomChineseName();
      case "date":
        return formatDate(context.now);
      case "time":
        return formatTime(context.now);
      case "datetime":
        return `${formatDate(context.now)} ${formatTime(context.now)}`;
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
        return `@${expr}`;
    }
  }

  function splitPlaceholderArgs(rawArgs) {
    const text = String(rawArgs || "").trim();
    if (!text) return [];
    const result = [];
    let current = "";
    let quote = "";
    for (const char of text) {
      if ((char === "'" || char === "\"") && !quote) { quote = char; current += char; continue; }
      if (char === quote) { quote = ""; current += char; continue; }
      if (char === "," && !quote) { result.push(current.trim()); current = ""; continue; }
      current += char;
    }
    if (current.trim()) result.push(current.trim());
    return result;
  }

  function stripQuotedString(value) {
    const text = String(value || "").trim();
    if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\""))) return text.slice(1, -1);
    return text;
  }

  function isSinglePlaceholder(value) {
    return /^@[A-Za-z_]\w*(?:\([^@]*\))?$/.test(value);
  }

  const mockSequenceState = new Map();
  function nextSequenceValue(path, step) {
    const key = `${path}:${step}`;
    const current = mockSequenceState.get(key) || 0;
    mockSequenceState.set(key, current + 1);
    return current;
  }

  function buildMockHeaders(contentType) {
    return new Headers(buildMockResponseHeaders(contentType));
  }

  function buildMockResponseHeaders(contentType) {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": "true"
    };
    if (contentType) headers["Content-Type"] = String(contentType);
    return headers;
  }

  function makeDataUrl(contentType, body) {
    const type = String(contentType || "text/plain; charset=utf-8").trim() || "text/plain; charset=utf-8";
    return `data:${type};base64,${utf8ToBase64(String(body || ""))}`;
  }

  function utf8ToBase64(text) {
    const encoded = unescape(encodeURIComponent(String(text || "")));
    return btoa(encoded);
  }

  function normalizeStatusCode(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(599, Math.max(100, Math.trunc(numeric))) : 200;
  }

  function bodyOrEmpty(value) {
    return String(value || "");
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let output = "";
    for (let i = 0, length = randomInt(min, max); i < length; i += 1) output += alphabet[randomInt(0, alphabet.length - 1)];
    return output;
  }

  function randomWords(min, max, capitalize) {
    const count = randomInt(min, max);
    const words = Array.from({ length: count }, () => randomWord(3, 10));
    if (capitalize && words.length) words[0] = `${words[0][0].toUpperCase()}${words[0].slice(1)}`;
    return words.join(" ");
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
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  function formatTime(date) {
    return [String(date.getHours()).padStart(2, "0"), String(date.getMinutes()).padStart(2, "0"), String(date.getSeconds()).padStart(2, "0")].join(":");
  }

  function isTextLikeContent(contentType) {
    const v = String(contentType || "").toLowerCase();
    if (!v) return true;
    return v.includes("json") || v.includes("text/") || v.includes("javascript") || v.includes("xml") || v.includes("html");
  }

  function summarizeValue(value) {
    if (typeof value === "string") return summarizeText(value, 1200);
    if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return summarizeText(value.toString(), 1200);
    if (typeof FormData !== "undefined" && value instanceof FormData) return "[FormData]";
    if (typeof Blob !== "undefined" && value instanceof Blob) return `[Blob ${value.size}]`;
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}]`;
    if (ArrayBuffer.isView(value)) return `[TypedArray ${value.byteLength}]`;
    if (value == null) return "";
    return summarizeText(String(value), 1200);
  }

  function summarizeText(text, maxLength) {
    const v = String(text || "");
    return v.length <= maxLength ? v : `${v.slice(0, maxLength)}...(truncated)`;
  }

  function emitHttpEvent(payload) {
    window.postMessage({ source: "ajax-proxy-page", type: "HTTP_EVENT", payload }, "*");
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
})();
