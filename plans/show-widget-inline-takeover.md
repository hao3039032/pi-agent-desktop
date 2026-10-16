# show_widget 前端接管：内联常驻渲染 + 按需弹出外部窗口

## 概要

pi-web 以 builtin 内联扩展**接管** `show_widget` / `visualize_read_me` 两个工具（不自动弹窗），前端对 `show_widget` 工具调用做特判渲染：**常驻内联 iframe 卡片（完成后不折叠）** + 「弹出外部窗口」按钮（新 API 经 glimpseui 开窗）。包依赖降级为内容载体（guidelines / html-utils / glimpseui 的 jiti 加载源），不再作为扩展加载。

## 一、Builtin 接管（lib/generative-ui.ts 改造）

- 新增 `createGenerativeUiExtension(): InlineExtension`，name `pi-web-generative-ui`（inline path `<inline:pi-web-generative-ui>`，仿 HOST_SUBAGENT_EXTENSION_PATH 约定），注册：
  - **`visualize_read_me`**：参数 schema 与包一致（`modules` 枚举 = jiti 加载的 `AVAILABLE_MODULES`）；execute 经 jiti 从 `generativeUiPackageDir()` 加载包的 `guidelines.ts` 调 `getGuidelines(modules)`，返回 text + `{ modules }` details；模块级缓存加载结果。
  - **`show_widget`**：参数 schema 与包完全一致（`i_have_seen_read_me`/`title`/`widget_code`/`width`/`height`/`floating`——floating 保留兼容但忽略）；保留 `i_have_seen_read_me` 门禁；execute **不弹窗**，返回 `Widget "<title>" rendered inline in the conversation (W×H). The user can open it in an external window from the chat.`；promptSnippet/promptGuidelines 措辞更新为内联渲染语义（避免模型对用户说"我打开了一个窗口"）。
- `startRpcSession`：删除 `additionalExtensionPaths: generativeUiPaths` 分支；把 factory 加进普通会话的 `extensionFactories`（与 `createArtifactGuideExtension` 同级；chatOnly/subagent 维持不加载）。
- **优先级反转**：`preferUserGenerativeUiExtension` → `preferBuiltinGenerativeUiExtension(base)`——保留 `<inline:pi-web-generative-ui>`，丢弃所有包副本（路径段 `pi-extension-generative-ui` 匹配，含用户全局 `~/.pi/agent` 副本），双向消解 `Tool "..." conflicts with ...` 错误；防御：builtin 缺席时包副本原样保留。override 链：`preferUserBashExtension(preferBuiltinGenerativeUiExtension(preferPiSubagentsExtension(base)))`。
- `generativeUiPackageDir()` 保留（guidelines/html-utils/glimpseui 锚点）；`generativeUiExtensionPaths()` 删除。
- `/widgets` 画廊命令随之消失（聊天记录即画廊，每个卡片带弹出按钮）——接受。

## 二、弹出 API

- `lib/widget-window.ts`：`openWidgetWindow({ code, title, width, height, isSVG? })`
  - glimpseui 主入口解析：createRequire 双锚点（`process.cwd()` + `import.meta.url`），与 `generativeUiPackageDir` 同模式；resolver 可注入（测试）。
  - `wrapHTML(code, isSVG)` 经 jiti 从包 `html-utils.ts` 加载（保持与包版本同步，自带 glimpse 键盘脚本）；isSVG 未传时 `trimStart().startsWith("<svg")` 自动判定。
  - 尺寸钳制（宽 240–2200、高 160–1600，默认 800×600）；title 下划线转空格（同包行为）。
  - 窗口注册表 `globalThis.__piWidgetWindows: Set`（热重载存活），`closed` 事件移除；glimpse 解析/打开失败抛带平台提示的错误（`ensureBinary` 的报错已含修复指引）。
- `app/api/widgets/open/route.ts`：POST JSON `{ code, title?, width?, height?, isSVG? }`；`code` 必填字符串、≤2MB；成功 `200 { ok: true }`，校验失败 400，glimpse 失败 `500 { error }`。鉴权与其他 `/api` 一致（loopback + 可选 PI_WEB_PASSWORD），无特殊处理。

## 三、前端特判（核心：完成后**不折叠**）

- `lib/widget-tool.ts`（纯函数，可测）：`WIDGET_TOOL_NAME = "show_widget"`；`extractWidgetCall(input)` → `{ code, title, width, height, isSVG } | null`（类型校验，code 非空）；`widgetPreviewKind(isSVG)` → `"svg" | "html"`；`streamingWidgetBytes(rawInput)`（流式进度用）。
- `components/WidgetToolView.tsx`：
  - **流式期间**：轻量占位卡（工具图标 + title（参数已到时）+ "正在生成 widget…" + 已接收字节数），不渲染 iframe（避免重挂重跑脚本）。
  - **完成后**：常驻卡片 = 头部（title + W×H + 按钮组：**弹出外窗**/源码切换/全屏/下载）+ iframe（`HTML_PREVIEW_SANDBOX` 沙箱、`buildHtmlPreviewDocument`、初始高度 `clamp(widget.height)`、SIZE_MESSAGE 自适应）+ `HtmlPreviewErrorBar`。工具结果文本并入卡片（错误时红色小字，正常确认文本弱化显示）。
  - **不折叠**：`BlockView` 在 `block.toolName === "show_widget"` 时**整块拦截**、直接渲染 WidgetToolView，完全绕过 `ToolCallBlock` 的 expanded/`isToolCallExpanded` 折叠机制——工具结束后卡片保持展开，这是本次的硬性需求。
  - 自动运行规则沿用 artifacts 平台安全规则：本轮流式完成（`wasStreamedHere`）或无脚本内容 → 自动渲染；历史加载的带脚本 widget 显示源码 + 「预览」按钮（不折叠、可见，仅不自动执行——macOS 沙箱帧共享进程的防冻结规则）。
  - 弹出按钮：`POST /api/widgets/open` → 成功后按钮短暂显示"已打开"；失败在卡片内显示原因（如 Linux 缺 chrome 的提示），不 crash。每次点击新开窗口（不复用）。
- `MessageView.tsx` `BlockView`：toolCall 分支最前面加特判（需先取 `toolResults?.get()` 传入）；`isStreaming` 透传。
- i18n：en / zh-CN / zh-TW 新增 key（widget.generating / widget.openExternal / widget.opened / widget.openFailed / widget.preview 等）。
- 历史会话里旧包扩展产生的 `show_widget` 调用同样被特判捕获（input 持久化了 widget_code）——存量会话自动获得内联渲染。

## 四、测试

- `lib/generative-ui.test.mjs`（重写）：factory 注册双工具且 schema 与包一致（含 `i_have_seen_read_me` 必填）；`visualize_read_me` 返回 guidelines 文本（包已安装的集成断言）；`show_widget` 门禁拒绝 + 返回内联文案 + **结构上不触碰 glimpse**；`preferBuiltinGenerativeUiExtension` 反转消解（保 inline 丢包副本、双向冲突错误消解、无 builtin 时不动）。
- `lib/widget-window.test.mjs`：注入 fake open/resolver——成功注册进 globalThis 集合、失败传播带原因、尺寸钳制、isSVG 自动判定。
- `app/api/widgets/open/route.test.mjs`：400（缺 code / 超 2MB）、500 带原因（注入失败 resolver）、200 正常路径。
- `lib/widget-tool.test.mjs`：`extractWidgetCall` 类型校验/非法输入 null；流式字节数。
- 组件级（沿用 `.test.mjs` VM 模式）：特判分发逻辑——非 widget 工具返回 null、widget 返回渲染 props。
- 既有集成测试更新：`lib/generative-ui.integration.test.mjs` 改为断言「factory 存在时包副本被丢弃」。
- 手工验收（dev server）：①让模型画图 → 流式占位卡 → 完成即内联渲染**且不折叠**；②点「弹出」→ 本机 chromium 后端开窗；③本机全局包副本在场 → 无冲突错误、无自动弹窗；④刷新页面 → widget 卡片仍在（带脚本的显示源码+预览按钮）；⑤TUI 侧 pi CLI 不受影响。

## 五、显式假设与默认

1. 流式期间只显示占位卡（不做 live iframe）——低风险默认。
2. 历史带脚本 widget 不自动执行（平台安全规则），但卡片常驻可见、不折叠。
3. 弹出按钮每次点击新开窗口。
4. 卡片保留源码切换/全屏/下载（沿用 HtmlPreviewBlock 能力面）。
5. `/widgets` 命令移除；`floating` 参数保留 schema 但 builtin 忽略。
6. pi CLI（TUI）侧完全不受影响（用户全局包照常加载、照常弹窗）。
7. widget_code API 上限 2MB。
8. guidelines / wrapHTML 经 jiti 从包依赖加载（版本随包），不复制源码进 lib。
9. 打包零新增（包与 glimpseui 已 staged、allowScripts 已批、prepare-desktop 守卫不变）。
