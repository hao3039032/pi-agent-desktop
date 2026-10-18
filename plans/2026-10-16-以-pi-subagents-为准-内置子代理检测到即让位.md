# 以 pi-subagents 为准：内置子代理检测到即让位（最终版）

## 背景与根因（含会话取证）

- 本 fork 自带内置子代理系统（`lib/subagent-extension.ts` 的 `pi-web-subagents` 内联扩展，注册 `Agent` / `get_subagent_result` / `steer_subagent`，内置 `general-purpose` / `explore` / `plan` 三个 profile，开关存于 `~/.pi/agent/agents/settings.json` 的 `builtInEnabled`，默认关）。
- 本发行版（`distro/distro.json`）默认捆绑 `npm:pi-subagents`（0.78 注册的工具名为 `subagent`，自带 scout/worker/reviewer/oracle/researcher/evidence-auditor/delegate 等角色）。
- 现有去重函数 `preferPiWebSubagentExtension` 设计为"内置赢"，但识别条件要求 pi-subagents 注册保留名（`Agent` 等）——0.78 不满足，永远匹配不上。一旦内置开关打开，`Agent` 与 `subagent` 两套委派工具同时暴露给模型 → "经常找错"。
- 会话取证结论（写给实现者，避免误判）：用户报告的 `Unknown agent 'general-purpose'` 真实发生在 pi-subagents 会话中（如 analysis_agent_deploy 2026-10-14），但**该会话根本没有注册内置 `Agent` 工具**（全部历史会话均无 `subagent_type` 参数或 Agent 工具声明；本机 `builtInEnabled` 一直为 false）。pi-subagents 的工具描述不含可用 agent 名单（名单只在报错时返回），模型凭训练先验猜了 Claude Code 的惯用名 `general-purpose`，报错后按错误里的名单自纠为 `scout`。用户已明确决定：**不配置 pi-subagents 的 advertise 机制、不做 fork 注入 agent 清单、不动 distro seed**——本计划只做内置让位；若将来想根治猜名，pi-subagents 的 `subagents.agentOverrides.<name>.advertise: true` / agent 文件 `advertise: true`（`<advertised_subagents>` 提示词目录）是其官方路径，此处不做。

## 方案（用户已确认：检测到就让位；不做 advertise/注入/seed）

只要 pi-subagents 的扩展文件出现在会话的扩展加载结果中，内置子代理就让位；pi-subagents 缺席或被禁用时一切照旧。

## 行为变更

1. **加载期优先级反转**（`lib/subagent-extension.ts`）：`preferPiWebSubagentExtension` 改为 `preferPiSubagentsExtension`——用现有 source/路径段检测（`sourcePackage === "pi-subagents"` 或路径段含 `pi-subagents`）识别 pi-subagents 扩展文件，**去掉"注册保留工具名"这一条件**。检测命中且内置 host（`<inline:pi-web-subagents>`）注册了 `Agent` 时：
   - 从 `base.extensions` 中移除 host 扩展（三件套工具随之消失）；
   - 清理错误列表：host 路径上与 pi-subagents 路径冲突的错误（`Tool "X" conflicts with <path>`）删除；pi-subagents 路径上与 host 冲突的错误也删除（冲突已随 host 移除而消失）；其余错误保留。
   - host 未注册工具（内置关）或无 pi-subagents 扩展时原样返回 `base`。
2. **运行时守卫**（`lib/subagent-extension.ts` + `lib/subagent-runtime.ts` + `lib/rpc-manager.ts`）：`subagent-extension.ts` 维护模块级标志 `piSubagentsPreferred`（每次 `preferPiSubagentsExtension` 调用时更新，以"是否检测到 pi-subagents 扩展"为准），导出 `isPiSubagentsPreferred()`；`SubagentRuntimeDependencies` 增加可选 `isPiSubagentsPreferred?(): boolean`，rpc-manager 的 `SUBAGENT_CONTROLLER` 接线传入；`start()` / `resume()` 在现有 `builtInEnabled` 检查之后追加拒绝，错误信息指引用模型改用 pi-subagents 的 `subagent` 工具。模块级标志在 HMR 后重置为 false（下次会话加载即恢复），守卫为尽力而为；设置文件检查仍是主守卫。
3. **settings 路由**（`app/api/subagents/settings/route.ts`）：GET/PUT 响应增加 `legacyPackage: boolean`。由新 helper `readPiSubagentsPackageActive()`（放 `lib/subagent-settings.ts`，路径可注入便于测试）读 `~/.pi/agent/settings.json` 的 `packages` 判定：复用 `lib/distro/packages.ts` 的 `packageKey()` 识别 `npm:pi-subagents`（含带版本号），绝对路径条目按路径段含 `pi-subagents` 识别；对象条目若 `extensions` 为空数组（经 Plugins 面板禁用）视为未激活；任一激活条目命中即为 true。注意 packages 条目会被运行中的 app 改写（本机已由 pi-seed 绝对路径变为 `npm:pi-subagents`），判定必须兼容两种形态。
4. **Agents 面板**（`components/AgentsConfig.tsx`）：`legacyPackage === true` 时——在内置开关上方显示提示（新 i18n 键 `agents.piSubagentsPreferredNotice`，文案如"检测到 pi-subagents 扩展：子代理以 pi-subagents 为准，内置子代理工具已停用"）；内置 `ConfigSwitch` 置 disabled（title 用同一文案说明原因）；侧栏 profile 分组过滤掉 `builtin` scope（三件套此时不可达；同名的用户文件仍以 global/project scope 显示，不受影响——这些文件与 pi-subagents 共享，编辑功能保留）。
5. **i18n**（en / zh-CN / zh-TW 三份同步）：新增 `agents.piSubagentsPreferredNotice`；更新三处 `agents.builtInDescription`——现文案"……并停用发生冲突的 pi-subagents 扩展"反转为"……检测到 pi-subagents 扩展时自动让位"。
6. **rpc-manager 调用点**：`extensionsOverride: (base) => preferUserBashExtension(preferPiSubagentsExtension(base))`（仅改名与语义反转，位置不变）。

## 明确不做（用户已决定）

- 不配置 advertise（settings.json 的 `subagents.agentOverrides` 与 agent 文件 frontmatter 均不动）。
- 不在 fork 里注入 agent 名单或"先 list 再调用"的 prompt 引导。
- 不改 distro seed / `distro.json`。
- 不删除内置子代理系统本体（保留为无 pi-subagents 时的后备与面板能力）。

## 不变项

Chat-only 会话（本就无子代理扩展）；profile 文件的 frontmatter 往返保存（与 pi-subagents 共享 `~/.pi/agent/agents/*.md`、`.pi/agents/*.md`）；`lib/required-child-extensions.ts` 的安全扩展注入；已存在的内置子代理运行/会话文件；切换后需重载会话才生效（现有行为）。

## 测试

- `lib/subagent-extension.test.mjs`：重写优先级用例——① pi-subagents 注册 `subagent`（0.78 形态）+ host 注册 `Agent` → host 被移除、pi-subagents 保留、标志 true；② 双方都注册 `Agent` 且两侧均有冲突错误 → host 移除、双向相关冲突错误清掉、无关错误保留；③ 无 pi-subagents → `base` 原样返回（恒等）、标志 false；④ host 无工具（内置关）+ pi-subagents 在场 → `base` 原样但标志 true。
- `lib/subagent-runtime.test.mjs`：`isPiSubagentsPreferred: () => true` 时 `start`/`resume` 以优先级错误拒绝（镜像现有 disabled 用例的 deps 构造方式）。
- `lib/subagent-settings.test.mjs`：`readPiSubagentsPackageActive` 覆盖字符串条目、带版本 npm 条目、pi-seed 绝对路径条目、`extensions: []` 禁用条目、多 entry 任一激活。
- 验证：`node_modules/.bin/tsc --noEmit`、`npm run lint`、`node --test` 上述三个测试文件；手动验证——pi-subagents 包激活 + 打开内置开关后新会话的工具列表含 `subagent` 不含 `Agent`，面板显示提示且开关禁用、builtin 分组隐藏；禁用/卸载 pi-subagents 后开关恢复可用、三件套回归。

## 文档

- `docs/adr/0003-built-in-subagent-toggle.md`：优先级段落改写为"pi-subagents 在场时内置让位（按扩展加载结果判定），缺席或禁用时内置照旧"。
- `docs/agents/subagents.md` 第 4 行的优先级句子同步反转。
- 根 `AGENTS.md` "Built-in subagents" 小节对应 bullet 更新（提交前 `git checkout -- AGENTS.md` 去掉 next dev 追加块后再改）。

## 假设与说明

- "pi-subagents 在场"的权威信号是会话扩展加载结果（`extensionsOverride` 收到的 `base.extensions`），settings 包条目判定仅用于 UI 提示与路由返回值。
- 模型猜错 agent 名（如 `general-purpose`）属于 pi-subagents "报错自纠" 的设计内行为，本计划不消除该现象；证据与可选的 advertise 后续路径已记录在背景节。
- 无迁移需求：无新增持久化格式；`legacyPackage` 每次按需计算。
