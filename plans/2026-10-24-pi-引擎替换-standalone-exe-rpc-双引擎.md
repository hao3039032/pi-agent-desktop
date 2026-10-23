# pi 引擎替换:进程内 SDK → 官方 standalone pi.exe(RPC 双引擎)

状态:已被取代(2026-10-24 用户决策:一步到位,不留双引擎开关;现行计划见《2026-10-24-pi-cli-backend-盘点与里程碑.md》。本文保留作为决策史与实测依据)
日期:2026-10-24
前置实测:已完成(见"背景"第 3 条)

## 背景与动机(写给实现者)

1. **现状**:pi-web 对 pi 引擎的调用是**进程内 SDK**——`lib/rpc-manager.ts` 的 `AgentSessionWrapper`(约 2000 行,332-2270)包装 `createAgentSessionFromServices`(`@earendil-works/pi-coding-agent`),全仓 67 个文件有运行时 import、32 个 type-only import。引擎与 Next 服务器同进程同生命周期。
2. **痛点**:
   - pi 升级 = 重打包 server(node_modules 里 SDK 版本锁定),每次都要走 pi → pi-web → desktop 同步链;
   - agent 崩溃/OOM 会带走整个 Next 服务器(所有会话);
   - 未来"去 Next 化/窗口先行"被进程内耦合卡住。
3. **官方 standalone 已实测可行(2026-10-24,本机)**:
   - `pi v1.4.0` releases 的 `pi-windows-x64.zip`(43MB 压缩/111MB 解压,单文件 `pi.exe`,Bun 编译);
   - `--mode rpc` JSONL over stdio,协议文档完整(zip 内 `docs/rpc.md` + `rpc-commands.md`,30+ 命令);
   - 实测:裸启动 0.56s;RPC 握手 0.72-0.94s(禁扩展)/ 3.1-3.3s(加载本机全套用户扩展);`bash` 工具真实执行;LLM 完整往返(prompt→agent_settled→回复);stdin 关闭有序退出;
   - **完整加载 `~/.pi` 用户扩展生态**(subagents/advisor/plan-mode 事件流均激活)。

## 诚实声明:本计划不解决什么

- **不解决启动慢**:Next 服务器(5.5k 文件冷启动 20-30s)原样保留。止血是已 commit 的超时重试(`3536c11d`)+ backlog 里的窗口先行。本计划是**结构性投资**,为"去 Next 化"解锁,顺带拿崩溃隔离与独立升级。
- 若动机只是修启动问题,本计划应降级/暂缓。

## 目标架构(过渡期双引擎)

```
API routes(app/api/**)           ← 不动,依赖 rpc-manager 导出的函数签名
        │
startRpcSession(engine 开关)      ← 新增 PI_WEB_AGENT_ENGINE=standalone|inprocess(默认 inprocess)
        │
  ┌─────┴──────┐
InProcessEngine  StandaloneEngine
(现状代码平移,   (spawn pi.exe --mode rpc
 行为零变化)      + JSONL 客户端 + 事件桥)
```

## 分阶段(每步可独立交付、验证、回退)

### 阶段 0:能力盘点 + 注入 PoC(1-2 天)★本阶段产出决定后续规模
1. **SDK 调用面清单**:从 `AgentSessionWrapper` 全文提取 `inner/AgentSessionLike` 的方法与事件使用面,对照 `rpc-commands.md` 命令表,产出逐项 gap 表(✅有对应命令 / ⚠️需变通 / ❌无对应)。
   - 重点核查:工具白名单运行时切换(`setRpcSessionTools`)、chat-unlock、扩展 UI 双向流、MCP host 的 `prepareForPrompt`、composer 队列行为。
2. **宿主扩展注入 PoC**:把 `lib/artifact-guide-extension.ts`(选它因为最简单)编译为独立 js,`pi.exe --extension ./xxx.js --mode rpc` 验证 extension_ui_request/response 事件流闭环。
3. **决策点确认**(需用户拍板,见文末)。

### 阶段 1:双引擎骨架(3-5 天)
- 从 AgentSessionWrapper 的实际使用面反推小接口 `SessionEngine`(不要照抄全 SDK 面);
- `InProcessEngine`:现状代码平移,行为零变化(纯移动+包装,不改逻辑);
- `StandaloneEngine`:
  - spawn `pi.exe --mode rpc --no-session`(路径来自 distro 组件,见阶段 4);
  - JSONL 客户端:按 id 关联 response、事件流订阅、**手写 LF 分帧**(rpc.md 明确警告 Node readline 会错切 U+2028/2029);
  - 生命周期:stdin 关闭=有序停;退出/崩溃→wrapper 发 session_shutdown,会话状态落盘在 ~/.pi(pi.exe 自己写)。
- `startRpcSession` 加开关,默认 inprocess(零风险发布)。
- **验收**:standalone 引擎完整跑通一条 prompt→SSE 事件流→assistant 回复→abort;同一进程内两种引擎并存可切。

### 阶段 2:核心命令覆盖(1-2 周)
- 命令:prompt / steer / follow_up / abort / clear_queue / get_messages / get_entries / get_tree / get_last_assistant_text / fork / clone / new_session / switch_session / set_model / get_available_models / set_thinking_level / compact / bash / get_session_stats。
- SSE 桥接:pi.exe 事件(json.md 的事件流)→ `agent-event-wire` 现有 wire 格式适配层。
- 会话文件兼容性验证:pi.exe 写的 `~/.pi/agent/sessions/**.jsonl` 与 pi-web 现有会话读取(`session-reader.ts`)互通;不互通则加迁移/双读。
- 测试:沿用 `route.test.mjs` 模式逐命令覆盖;协议握手失败、进程崩溃、stderr 噪声三类故障注入。

### 阶段 3:宿主扩展迁移(1-2 周,规模取决于阶段 0 盘点)
- 全量清单分类处置:lib/builtin-extensions、chat-unlock、permission-system(findSecurityExtensionPaths/registerSecurityChildExtensions)、subagent-extension、exact-system-prompt、artifact-guide、chat-downloads-tool 等:
  - A 类(引擎侧逻辑)→ 编译为独立 js,`--extension` 注入,或打成 pi package 进 distro seed;
  - B 类(UI/策略编排)→ 留 pi-web 侧不动;
  - C 类(与进程内耦合已无意义)→ 标记淘汰。
- MCP:pi 自带 MCP 加载;pi-web `mcp-host.ts` 的职责重划(哪些留宿主、哪些交给引擎)。
- subagent 事件总线:pi.exe 内跑的 pi-subagents 扩展的事件,经 extension_ui / 事件流转发,替代现在的进程内 EventBus RPC。

### 阶段 4:distro 集成 + 回退兜底(2-3 天)
- distro 新增 `pi-standalone` 组件:按平台下载 releases zip、SHA256SUMS 校验、版本锁定(复用现有 distro/updater 基建);
- 回退链:pi.exe 缺失/校验失败/握手超时 → 自动降级 inprocess 引擎 + desktop.log 记录(用户无感);
- 打包决策(见决策点 3)。

## 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| RPC 协议能力缺口(阶段 0 才知真实大小) | 高 | gap 表驱动;缺的能力所在功能暂留 inprocess,不硬造 |
| pi.exe 协议演进 breaking | 中 | distro 锁版本窗口;RPC 有正式文档+测试套件,变更可追踪 |
| 双引擎长期维护成本 | 中 | standalone 稳定后 2-3 个版本内把 inprocess 降级为 legacy/移除投票 |
| 会话 jsonl 格式漂移 | 中 | 阶段 2 互读写测试;pi.exe 与 SDK 同源同版本时风险最小 |
| 111MB 体积 | 低 | 见决策点 3 |

## 决策点(待用户拍板)

1. **引擎切换粒度**:全局配置(新会话生效,简单)vs 每会话(灵活但状态管理复杂)。→ 建议全局。
2. **阶段 3 扩展迁移范围**:一次性全迁 vs 先迁 A 类最小集(chat-unlock/permission-system 这类安全相关的最后迁)。→ 建议最小集起步。
3. **pi.exe 分发**:打进安装包(安装即用,体积 +111MB)vs 首启按需下载(包小,但首启多一步+弱网风险)。→ 建议打进安装包(桌面产品体验优先,distro 已有增量更新)。
4. **时间窗**:现在就动 vs 等 pi 官方 desktop 参考实现(若官方出手,协议面会更快稳定)。→ 建议先做阶段 0 盘点(沉没成本最低),拿 gap 表再决定是否全速。

## 明确不做(本计划范围外)

- 不动 `app/api/**` 路由层与前端(接口签名保持)。
- 不做窗口先行 / UI 静态化(独立 backlog;本计划完成是其前置)。
- 不追 pi nightly;只用 releases 正式版。
- 不在 standalone 引擎里复刻 inprocess 的全部细粒度行为(如 composer 队列的精确语义)——以 gap 表为准,缺口显式记录而非静默模拟。
