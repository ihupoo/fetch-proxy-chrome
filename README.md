# Ajax Proxy Chrome 插件

一个基于 Manifest V3 的调试插件，可对页面请求做代理拦截与响应改写。

## 功能

- 一键开启/关闭当前标签页代理
- 展示当前标签页请求日志，支持搜索
- HTTP 拦截规则：
  - `request` 阶段直接返回自定义 response（mock）
  - `response` 阶段替换原始响应内容
- 支持资源类型：`XHR`、`Fetch`、`Script`、`Stylesheet`、`Document`、`WebSocket` 等（按规则配置）
- 支持 WebSocket 入站/出站消息替换（页面上下文代理）

## 安装

1. 打开 Chrome `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录：
   - `/mnt/d/work/kd_gitlab/ajax`

## 使用

1. 在目标网页打开插件 popup
2. 开启「当前标签页代理」
3. 点击「打开监控面板」
4. 在监控页：
   - 顶部搜索框可过滤日志
   - 新增 HTTP 规则后会按顺序匹配（先命中先执行）
   - 新增 WS 规则后会自动广播到页面

## 规则说明

### HTTP 规则

- `URL 匹配`：支持 `*` 通配，或 `/regex/flags`
- `资源类型`：逗号分隔，例如 `XHR,Fetch`
- `阶段`：
  - `request`：请求发出前拦截，直接返回自定义响应
  - `response`：拿到响应后替换内容再返回给页面
- `操作方式`：
  - `fulfill`：整包返回 `responseBody`
  - `replace`：对原响应执行替换（`replaceFrom -> replaceTo`）

### WS 规则

- 匹配 URL 后可分别配置：
  - `outgoingFind/outgoingReplace`
  - `incomingFind/incomingReplace`
- 支持普通文本替换或正则替换

## 注意事项

- 插件使用 `chrome.debugger`，会与 DevTools 的调试会话互斥
- `response` 阶段替换文本时更适用于文本响应（JSON/JS/CSS 等）
- WebSocket 代理基于页面上下文覆写 `WebSocket`，对极端框架封装场景可能需要额外适配
