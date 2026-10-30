# 去 Next.js 迁移（静态前端 + Tauri/Rust 应用宿主）

总计划见 `plans/2026-10-31-去-next-js-静态前端-tauri-rust-应用宿主完整迁移计划.md`。本目录存放迁移的落地工件；按里程碑（M0–M5）推进，每个阶段的验证门槛以计划 §八–§九 为准。

## 当前状态（M0 进行中）

| 项 | 状态 | 工件 |
|---|---|---|
| 全部 HTTP 方法 → IPC 完整映射 | ✅ 完成（90 文件/126 方法：M0 冻结的 89/124 + M1 新增的 state-mirror 过渡脚手架） | `api-inventory.json` + `scripts/migration/api-inventory-mapping.mjs`（守卫测试：冻结计数、op 唯一、无遗漏、transitionOnly 显式标记） |
| IPC 协议规范（信封/错误码/流/资源通道） | ✅ 冻结初版 | `ipc-protocol.md` |
| Rust→pi 握手/桥接/退出（最高风险项） | ✅ PoC 验证通过 | `crates/pi-host`：20 个确定性协议测试 + 3 个真实 pi 集成测试（`PI_CLI_BIN` 门控，隔离 `PI_CODING_AGENT_DIR` 沙箱） |
| 管理依赖加载（隔离固定版本模块树，绝对路径导入） | ✅ 机制验证通过（本机 pi 1.4.0 托管安装 = release 目录布局，linux-x64） | `scripts/migration/management-deps-loading.test.mjs`：vendored croner 10.x 在子进程内解析、执行、回报 URL；空 NODE_PATH + 临时 cwd。已随 `PI_CLI_BIN=… npm test` 全量回归（3629/3629，0 跳过）。⚠️ 其余三个发行目标的打包布局（desktop:prepare 产物）验证仍待做 |
| 扩展 provider 枚举 | ✅ 验证通过 | `crates/pi-host/tests/real_pi.rs::real_pi_management_instance_enumerates_extension_providers`：管理形态 child（`--mode rpc --no-session`）加载 pi.registerProvider fixture 后，标准 `get_available_models` RPC 枚举出该 provider 的模型；`--no-session` 不写会话文件 |
| 模拟 OAuth 取消/回调 | ✅ 验证通过 | `crates/oauth-loopback`：OS 随机端口的 127.0.0.1 监听、唯一 `/callback` 端点（路径外的都 404）、state 不匹配绝不是成功、PKCE S256 挑战独立复算一致（verifier 只留宿主侧）、完成/取消后监听关闭、百分号解码。7 测试 + 1 显式忽略的超时长路径 |
| 终端 IPC 接线 | ✅ 落地 | `pi_ipc`：terminal.create（幂等）/write（base64，失败不重试）/read（游标 suffix/reset+重放）/resize/close + `pi_ipc_subscribe_terminal` 输出流（真实 PTY 往返测试）
| PTY（portable-pty） | ✅ 可行性验证通过 | `crates/pty-host`：幂等创建（同 id 返回同一实例）、输入/resize 串行、128 Ki UTF-16 历史窗口 + 游标后缀读 + 过旧游标 reset/有界重放、退出码传播（exit 7 实测）、Unicode 分块、关闭后输入显式失败。120 秒租约与 Tauri 接线是 M4 |
| 无权限资源预览（自定义资源协议） | ✅ 已接入 pi_ipc | resources.grantFile/read/revoke（宿主侧授权决策、不透明句柄、MIME/Range、拒绝原因→协议错误码）| 
| 无权限资源预览（自定义资源协议，逻辑层） | ✅ | `crates/resource-protocol`：随机 128 位句柄、单文件/目录授权、请求时重校验（canonical 一致 + 目录包含检查拒绝穿越/绝对路径/反斜杠/树内逃逸 symlink）、授权绑定解析后的目标（symlink 重定向不动授权；锚点被换成 symlink 则拒绝）、MIME/Range、过期与撤销。Tauri 协议注册是 M3 |

## 如何跑真实 pi 测试

真实 pi 测试（Rust `crates/pi-host/tests/real_pi.rs`、JS `lib/pi-rpc/*.smoke.test.mjs`、`scripts/migration/management-deps-loading.test.mjs`）都以 `PI_CLI_BIN` 门控，未设置时跳过。开发机上直接指向本地托管安装即可（它就是桌面随包的 release 目录布局）：

```bash
PI_CLI_BIN=$HOME/.pi/agent/bin/pi npm test          # 全量套件含真实 pi 冒烟（3629 个，0 跳过）
PI_CLI_BIN=$HOME/.pi/agent/bin/pi cargo test --test real_pi   # 在 crates/pi-host 下
```

所有真实 pi 测试都跑在隔离沙箱（临时 `PI_CODING_AGENT_DIR`、临时 cwd），不碰真实 `~/.pi/agent` 数据。

## 当前状态（M0–M1 进行中）补充

M1 项：

| 项 | 状态 | 工件 |
|---|---|---|
| 过渡版本：状态镜像/导出兼容 | ✅ 已落地（发布节奏仍由人工把控） | `lib/state-mirror.ts` + `lib/state-mirror-store.ts` + `app/api/state-mirror` + `hooks/useStateMirror`（AppShell 挂载）：显式白名单、schemaVersion/revision/校验和、ACK 后才推进 revision、原子写 + 0600、防抖/周期/pagehide 三路持久化。11 个测试 |
| Vite 静态入口与诊断骨架 | ✅ 骨架可构建 | `static-frontend/`：`npm run build` 产物进 `desktop/frontend`（`emptyOutDir:false`，占位保留）；BootPage 无 Next/pi 可渲染，含宿主探测/诊断/重试；主题首屏内联离线初始化 |
| IPC 类型层 | ✅ 初版 | `static-frontend/src/ipc/`：协议 v1 信封/错误码/流帧类型（对齐 `ipc-protocol.md`）、类型化客户端 + 可注入 transport（Tauri 桥/Mock）、封闭操作面（unknown_op 拒绝、超时不重发）、集中式导航适配（session/cwd/view，URL 优先）。12 个 mock-transport 测试 |
| 页面组件迁移 | ⬜ M2 起 | 会话 UI、模型面板等 |

M4 项：

| 项 | 状态 | 工件 |
|---|---|---|
| 调度器核心 | ✅ 落地 | `crates/task-scheduler`：slot 决策（2 分钟准时宽限/7 天补跑一次/更旧丢弃带跳过计数）、overlap 跳过、2 并发上限（手动运行绕过上限不绕过 overlap）、连续 5 失败自动暂停（保留致停错误）、成功重置、90 秒租约心跳/过期/显式接管、超时清理、磁盘任务形状解析。8 测试 |
| CronOracle（cron 计算经管理扩展的固定版 croner） | ✅ 桥接落地 | `ManagementCronOracle`：previous_run 一次 cron.previousRuns 调用；真实 pi + vendored croner 实测（UTC 表达式、独立核算的 epoch） |
| 任务存储（磁盘格式兼容） | ✅ 落地 | `crates/task-scheduler/src/store.rs`：scheduled-tasks.json 原子写 + 未知字段保留、lastScheduledFor↔since_ms 映射、JSONL 运行账本容忍截断尾行（历史不重写）、缺文件=空、损坏=错误
| tick 引擎 | ✅ 落地 | `crates/task-scheduler/src/engine.rs`：slot 决策 + 租约 + overlap 消耗槽位并记 skipped、并发满则不推进水位（下 tick 重试）、spawn 失败计入 5 连败自动暂停（致停错误持久化）、finish_run 释放租约并落盘暂停。17 测试
| tasks.list IPC | ✅ 落地 | pi_ipc 读面：原样返回任务形状（未知字段透传）、损坏存储报 io 错（绝不空成功诱导覆盖保存）。tick 循环属宿主 30s 定时器，不在请求路径
| 30s 定时器接线（宿主启动即跑、UI 关闭不停止） | ⬜ 随 M4 宿主整合 | 引擎/存储/预览均已就位 |

M3 项：

| 项 | 状态 | 工件 |
| 文件访问允许清单 + files.read/write | ✅ 落地 | `src-tauri/src/file_access.rs`（归一化/词法授权/解析后授权拒绝 symlink 逃逸/~/pi-cwd 扫描）+ pi_ipc 的 files.allowRoot/read/write（越界写拒绝于任何 IO 之前）；往返测试 |
|---|---|---|
| 管理实例宿主（Rust 侧） | ✅ 骨干落地 | `crates/management-host`：按 scope（global/项目 cwd）分区按需启动 `--mode rpc --no-session` 子进程（发现全关、仅显式扩展）、60 秒空闲回收 + 租约保持、provider/模型枚举（`get_available_models`，含扩展注册的 provider）、扩展命令调用（无 run 启动）、不写会话文件（实测）。真实 pi 测试 2/2 |
| 管理扩展（JS 侧骨架） | ✅ 骨架落地 | `lib/pi-rpc/assets/pi-web-management.mjs`：管理协议 v1（nonce 绑定信封、能力表、错误码、进度帧预留）；cron.preview/previousRuns（vendored croner，UTC/上海时区实测）；session.readHeader/readEntries（vendored SDK 的 session-manager 隔离模块图——实例一致性规则的落地模式）；unknown op 拒绝；不写会话文件。端到端测试（真实 vendored 树，desktop:prepare 形态）
| 管理扩展配置操作面（配置编辑/enabledModels/凭证/MCP 管理/插件技能的移植） | ⬜ M3 主体 | 骨架与协议已就位，按清单 op 逐个从 lib/*.ts 移植 |
| MCP transport 实例一致性 | 🔶 模块图模式已证明 | vendored SDK 的 SessionManager 读写已在隔离模块图内完成（MCP transport 同一模式）；完整 MCP transport/OAuth 移植随配置操作面 |

M2 项：

| 项 | 状态 | 工件 |
|---|---|---|
| Rust 会话宿主骨干 | ✅ 骨干落地 | `crates/session-host`：id 键注册表、并发启动去重（每 id 一把启动锁）、10 分钟空闲租约/驱逐、会话文件头创建（host 为 header 作者）、生产启动形态（`--session` + 发现关闭 + bridge 资产 + nonce）、握手（get_state 身份一致性 + get_commands 桥接命令归属）、事件扇出（N 订阅者）、封闭操作分发表（`sessions.runState`/`agent.interrupt`/`agent.setSessionName`；unknown_op/not_found）。真实 pi lifecycle 测试（create→start→并发去重→bridge tools.list→runState→租约到期驱逐→关闭） |
| 消息层状态机 | ✅ 核心已移植 | `crates/session-host/src/machine.rs`：run epoch、isRunning OR 规则、autoRetry 未知语义、流式 delta 累积（text/thinking/toolcall 稠密块）、队列、压缩、model_change、陈旧快照防护；prompt 的 SDK 契约（started 等下一 epoch / queued 等当前 / handled 不起 run）。9 单测 + 真实 pi 生命周期 |
| 事件流桥（Tauri Channel） | ✅ 落地 | `pi_ipc_subscribe_events`：snapshot 帧先行（与订阅原子）、事件单调 seq、宿主 epoch、关闭即分离；静态前端 transport 已接 Channel |
| 剩余命令面（树导航、fork/clone、统计缓存、fleet 监控、自动命名桥接） | ⬜ 逐命令迁移 | 状态机与分发表已就位，按清单 op 逐个落 |
| 会话历史索引 + sessions.list + 侧栏视图 | ✅ 落地 | `crates/session-host/src/history.rs`（只读扫描、项目分组、按时间排序、坏文件跳过带原因、ISO→epoch）；dispatch + pi_ipc 的 sessions.list；静态前端 SessionsView（首个迁移 UI 组件，typed IPC 驱动） |
| 全量 UI 迁移机制 | ✅ 落地 | `static-frontend`：整棵现有组件树（3636 模块）经 Vite 构建进 desktop/frontend，tsc 0 错误。Next 客户端 API 四件套经 shim（navigation→History/URLSearchParams 适配、image→img、dynamic→lazy、link→anchor）；CSS 级联按 layout 顺序（katex/globals/settings/native-theme）；主题首屏内联、Google 字体移除（系统回退） |
| 数据层逐域替换 | 🔶 已开工 | `agent.command`（封闭命令枚举 + 形状校验，错误→协议码）+ agent-client IPC 版（同表面：AgentCommandError/code/accepted/instanceId）；会话事件流 SSE→IPC Channel（快照/事件帧、seq/epoch、reset→重连、close 即分离）；传输层唯一接线点 `src/data/transport.ts`。⚠️ 其余领域（sessions 目录、models、MCP、插件技能、文件、git/worktree、scheduled、appearance、desktop）仍走 fetch——生产合规检查（无 /api、无 EventSource）尚未通过，逐域对齐响应形状是 M2/M3 主体 |
| 消息层状态机 | ✅ 核心已移植 |
| Tauri IPC 桥（`pi_ipc` 命令） | ✅ 垂直切片落地 | `src-tauri/src/pi_ipc.rs`：协议 v1 信封校验（版本/结构/参数对象）、封闭操作表（`desktop.identity` 先于任何子进程应答；会话操作路由 session-host 的分发表）、`unknown_op`/`not_found` 协议错误码。`allow-pi-ipc` 权限（desktop-shell.toml）+ 主窗口 capability；静态 BootPage 的 Tauri 探测路径真实可用（客户端超时，超时不重发）。src-tauri 24 测试全绿 |

## 工件索引

- `api-inventory.json` — 迁移清单：89 个路由文件、124 个方法，逐条 IPC 操作、实现归属（rust-host / mgmt-extension / session-bridge / rust-native / removed-web-only）与里程碑。重新生成：`node scripts/migration/generate-api-inventory.mjs`；校验：`--check`；守卫：`node --test scripts/migration/api-inventory.test.mjs`。
- `ipc-protocol.md` — WebView ↔ Rust 宿主 IPC 契约（请求信封、错误码、Channel 流、二进制/资源通道、禁止事项）。
- `crates/pi-host` — pi CLI JSONL RPC 客户端的 Rust 移植（client.ts / core.ts bridge 部分），M2 会话宿主的地基。测试：`cd crates/pi-host && cargo test`；真实 pi：`PI_CLI_BIN=<pi 路径> cargo test`。

## 硬规则摘录（实现时不得违反）

- 每个现有 HTTP 方法必须进入迁移清单；只允许删除 `removed-web-only` 的 5 个方法（web-auth×3、push×2）。
- 不暴露通用执行接口；Rust 用封闭操作枚举。
- 超时不重发副作用操作；requestId + 状态查询定结果。
- 不 monkey-patch fetch/EventSource；非 fetch 的 `/api` 地址一并迁移。
- iframe 永远不能同时拥有 `allow-scripts` 与 `allow-same-origin`；预览资源协议无 IPC capability。
- 前端样式仍只进 `app/native-theme.css`；`globals.css`/`settings.css` 字节基线在迁移期间照旧（M1 Vite 构建沿用）。
