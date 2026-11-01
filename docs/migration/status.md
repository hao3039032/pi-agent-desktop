# 静态宿主迁移实施状态

此表记录主分支 `migrate/static-tauri-host` 截至 Windows 资源句柄源码、MCP credential admission 与运行中自动命名整合点 `e099bbf3` 的状态。**不是 M5 验收报告。** README 中较早的测试计数、未迁移列表和 PoC 表是历史记录，以本表为当前状态；API 全量目标仍由 `api-inventory.json` 定义。

## 目前没有发生的切换

- 正式产品仍启动 Next；未删除旧后端、未启用正式 Rust 调度循环。
- 静态前端沿用原组件/UI，不把安全拒绝或空占位当功能完成。
- 没有发布、推送、修改更新仓库或签名策略。
- 本地托管 pi、SDK symlink、浏览器桥及 `tauri::test::mock_app` 都不是 standalone/native WebView/安装升级证明。

## 已集成的实现

| 领域 | 当前范围 | 仍需区分的边界 |
|---|---|---|
| 会话基础 | 原 UI 创建/发送/流式/停止/队列编辑与立即发送、重开历史；目录/上下文投影、普通 fork/clone/navigate、rename/search/export；扩展 pending UI/回复/取消、fleet、thinking、prompt 与有证据的状态 | 自动命名已接 live registry、运行中/队列兼容和持久 rename fence；DELETE、带摘要分支及其关联 Stop 尚未完成；历史工具图片 resolver/URL 生命周期与安全 bash 下载已接线，原生验收未做；RPC custom UI 不支持，不伪造替代 |
| Chat | 解锁读写、继续到宿主已授权项目；旧 child 确认退出、固定短寿命文件 writer、source/target 持久 fence | 正式启动与 harness 默认拒绝解锁；原生主窗口/iframe ACL、Windows mutation、跨宿主排他及未决结果恢复未验/未完成 |
| 模型 | 列表/默认/启用模型最小编辑、models.json 读写、catalog/discover/test/nonchat/refresh/provider usage | 保留手动目录刷新及原配置校验，真实账户/付费请求未参与测试 |
| Provider 认证 | provider 列表/API key/类型安全删除/logout、OAuth 进度流及关联 task-input/取消 | SDK 内置 OAuth callback 仍在 Node；Rust loopback 尚未接内置 provider |
| MCP | 配置 CRUD/undo、项目 MCP 列表、本地 Test、OAuth start/status/input/cancel/signout；静态 IPC 的 OAuth loopback 由 Rust 持有、SDK 公共引擎处理协议；trust.set 与 fresh-folder 写入经过 policy 独占、受影响旧会话退出、持久 pending marker 和结果核对 | OAuth 超时/取消显示远端 token 不确定性，保留 15 秒期限及迟到本地写保护；canonical/legacy/config/generation 私有 admission 已接 JS，native ledger/reservation/ACK 验证尚在实施，不能据 JS 合同直接解除 pending；仅隔离 fake 服务及管理 child 验证，原生浏览器和跨平台待验；Next 路径仍为 SDK Node callback；非 Unix trust mutation 拒绝；重启后 pending 的产品恢复入口与跨宿主排他未完成 |
| 插件/技能 | 列表/开关/批量技能禁用、搜索/check、install/update/remove 任务 UI/IPC | 不可取消的 SDK mutation 使用独占短寿命 pi；强停可能部分写入，结果 unknown；官方 skills CLI、真实 npm/git 安装及 Windows mutation 未验/未支持 |
| 文件/资源 | Unix root grant 保留目录对象与身份、准入复核路径、beneath-walk、目录/index/精确会话引用；普通 add 不续授已替换根，显式 native picker 可重新授权；统一 pi-resource 协议、Range/TTL/revoke、宿主内部栅格 byte grant；FileViewer/Markdown 资源、PDF/HTML/DOCX 预览与变更轮询、原生 drop/import、浏览器上传；overwrite 原子替换目录项，不截断硬链接 inode | 消息 sessionId/图片接线与 bash 下载已集成；原生保存使用有界准入、独立偏移流式读取和原子替换；reveal 路径重命名竞态待统一复审；失败暂存项不自动 unlink，可能留残件；Windows roots/read/index/pi-resource 句柄源码已接但未目标编译或原生执行，save/bash 与根外精确 session 引用仍缺；Windows index 的 Git 可见性尚未完成，故持续标记截断；Windows/Unix fallback 已加总节点与目录句柄预算；真实 dialogs/ACL 未验 |
| Git/worktrees | status/diff/list/create/switch/delete/fetch、隔离 Git fixture | Windows runner fail-closed；macOS 尚未验证 |
| 设置 | 字体偏好/系统字体、tools/artifacts/Chat settings、自定义 CSS、状态镜像 | 非 Linux 字体与原生 UI 未验；跨版本镜像导入及升级仍需验收 |
| 终端 | Linux 真 PTY、原 TerminalPanel、输入/resize/history/ACK/lease/reconnect/close/settings | macOS/Windows 安全 cwd-handle spawn 未完成，创建 fail-closed |
| 调度器 | CRUD/preview/history/seen、marker 确认后的真实 RunSpawner、手动执行、事件、显式启动的 30s loop/租约/slot/overlap/catch-up、TS/Rust 共同事务门、scheduled-session index | 正式启动切换未做；旧已发布二进制不参与新门；崩溃事务锁恢复未完；引用扫描需为删除严格拒绝损坏行 |
| 桌面服务 | 宿主原生目录选择授权、已知会话目录验证、distro/status/configure、updates.check；seed 为宿主内部操作 | 正式 seed 启动未切换；真实更新安装未执行；cwd.validate 不再授予任意前端路径权限 |
| 管理运行时 | 实例级结果 router、rid/nonce task、deadline/cancel/状态、关联输入、物理 scope 协调、插件独占实例 process-group 清理；Chat/session writer 与 trust 有持久拒绝标记 | 通用 task unknown 持久 ledger 正在实施，重启恢复未完；标记不是跨进程锁；`6dafa016` 已改为 16 个普通槽 + 4 个清理/ACK 槽立即准入或 busy，不再排队等待 semaphore，但请求字节、其他流及 Tauri/WebView 内部队列仍未完成全链有界验证 |

## 当前实施工作

在各自 worktree 单 writer 实施，主代理合并共享注册点和冲突。基础类型/fixture 测试继续运行；实现完成后统一审阅，不为每个小提交反复扩展审计。

- **会话删除**：group journal、严格 scheduled 引用、session admission、直接子 header 重写、传递 subagent 级联、共享/独占 Chat 文件夹规则已整合。生产破坏性删除许可和 journal 恢复许可彼此独立，均默认不授予；DELETE 返回 `busy`，reason 为 `session_deletion_exclusive_maintenance_required`。活动的其他受影响会话、跨目录直接 fork child、无法核验的 cwd/引用仍保守拒绝，尚未达到完整旧行为。
- **会话资源消费者**：已合并工具图片 resolver、late-result revoke、Markdown sessionId 和安全 bash 下载；历史图片投影已配套启用。继续保留真实原生窗口/预览 ACL、对话框与平台验收门槛。
- **Fork/clone writer 修复**：`47a386ee` 已替换共享 child 的 `session.fork`：同门只读 live snapshot、受限短寿命 writer 私有 staging、预绑定目标和两端持久 fence、退出确认后的无覆盖发布；保留 fork_branch 的源 child/active leaf。group journal 已引入此基线，并在隔离 real-pi fixture 中验证其 pending fence 交互；policy 写锁仍不能代替未知 writer 的终止证明，跨宿主排他与用户恢复未完成。
- **未决结果与生命周期**：`073815f2` 已集成合作式 Unix ownership guard、`HostLifecycle::init/register/shutdown` 顺序关闭、`desktop.recoveryStatus` 及静态只读提示、fork/continue 双端 fence 配对诊断。未接正式 bootstrap，guard 不证明旧宿主或脱管 writer 已退出；记录匹配不授予恢复权。产品恢复、旧宿主排他、正式 seed/scheduler 启动仍属 M5。
- **Terra 并行续作**：八个隔离工作树继续生命周期、会话 SDK、OAuth、独立打包、平台文件、传输、自动命名和 PTY/Git。小提交不等于功能交付；源码未接生产调用者的 primitive 不列已完成。SDK 最小补丁分发与合作升级/非合作 CLI 支持边界已向用户求决，尚未获准，不默认放行。
- **自动命名**：`963f20fd` 接通 live child 的实际 model registry 和专用纯 helper bundle，`50714c76` 恢复运行中及 queued follow-up 的原行为；同分支正常追加不作 stale，模型/树 ABA、名称或 child 实例变化拒绝。改名使用公开 `pi.setSessionName`，不调用只读 extension context 未暴露的写方法；写前持久 marker，只有关联成功或明确写前拒绝清除，ACK 丢失/append 异常保留。最多 64 KiB 的 source 前缀仅为诊断，不冻结已准入运行。真实 90 秒 deadline 和原生 UI 仍待验。
- **尚未整合的续作**：生命周期 lane `5e3d3d7b` 提供共用绝对 deadline 的 registry 关闭报告，打包 lane `d85ae23d` 已在隔离 mock static host 登记真实服务和 IPC drain；短寿命 writer 与普通 prompt 关联静默证据仍缺。平台 `0c61b276` 已作为 `ef075806` 合入 Windows roots/read/index/资源句柄及 Unix 嵌套根回退修复；Windows 未目标编译。整合检查确认的空目录无界队列已在 `e099bbf3` 修复：最多物化 50,000 个条目、最多 64 个待处理目录句柄，当前目录及临时枚举句柄另计；耗尽保留 partial/truncated。该修复不代替 Windows 目标编译或原生验收。MCP lane `ff3157de` 提供 probe mode admission/局部 guard/私有 receipt，尚待 native 消费；stdio/provider-auth/`!command` 的宽 scope 不作为只读放行。这些均不是正式 bootstrap 或 M5 验收。
- **Composer 技能列表**：已复用 `skills-client` seam（Next fetch / 静态 IPC），保留 cwd 与取消守卫，不再在组件里直接请求 `/api/skills`。

## 集成验证记录（不是全量/跨平台验收）

- `e099bbf3` index 预算修复：三个改动文件与 lane 的 `fd9d0ba8` 完全一致。lane 报告 Linux index **13 passed**（其中预算 5 项）、resource handler **5**、resource-protocol **15**，library+harness check 通过。父代理尝试合并后定向 Rust 测试时共享 heavy 锁繁忙，`flock -n` 返回 75，**没有执行测试**；没有把它计为通过或重复等待占锁。
- `ef075806` 平台源码整合：父代理核对句柄调用链、独立 ReOpenFile 游标、锁文件和 Linux 嵌套根拒绝逻辑，尚未执行该合并点的 Rust 检查。lane 报告早先 Linux 根/目录 **28 passed**，资源 crate **15**、handler **5**、保存 **3**、资源授权 **1** 通过及 library+harness check；这些不是 Windows 编译/原生证据；其后 index 总目录预算问题由上述独立修复覆盖。
- `44e6a102` Unix 固定根整合：lane 报告隔离 Linux **35 passed** 及 library+harness check。父代理随后在 `fed16264` 执行合并后 library+harness check，通过；使用已空闲 lifecycle lane 的现有 target（2.6 GiB），没有继续写主仓库 26 GiB target。
- `fed16264` OAuth 超时/取消警告及私有撤权协议：父代理定向 JS **18 passed / 0 failed / 0 skipped**，包含真实 15 秒超时但仅 fake OAuth 服务。`19c17bc3` canonical/legacy admission 整合后定向 JS **36 passed / 0 failed / 0 skipped**；native 还未据此获得安全合作准入，跨实例/共享 legacy 的其他 canonical writer 不受单个 ACK 证明覆盖。
- `963f20fd` title 首轮整合：父代理 JS **47 passed**、静态 tsc、root source-only tsc、inventory（90 routes / 126 methods）和 library+harness check 通过。后一次 Rust check 使用已空闲 packaging target，完成后 2.8 GiB。
- `50714c76` 运行中 title 及公开 API 修正：父代理定向 JS **49 passed / 0 failed / 0 skipped**；调整真实 fixture 的注入针点后，在隔离 HOME/agentDir、真实本地 pi 和 fake provider 下执行 Rust IPC title fixture **1 passed / 0 failed / 0 ignored**（304 项仅 filtered out，未执行）。复用了已空闲 title target，完成后 2.2 GiB。lane 的 fence **3**、session-host **43 passed / 1 ignored** 是另行证据；未 flush 的 SDK fixture 不等于静态 IPC 未 flush 端到端证明。上述不证明 standalone、Windows/macOS 或原生 WebView。

- `073815f2` 生命周期合并树与 lane 的 `5ca2059c` 完全一致。lane 报告 ownership **4**、lifecycle **3**、recovery IPC **1**、配对证据 **3**、前端服务/SSR **4** 通过及静态 tsc 通过；父代理未重复相同 Rust 重构建。它们不证明真实服务均已登记或未知 writer 已结束。
- `f544e566` Rust MCP callback 整合：父代理在合并后的源码执行 broker/hosted OAuth/取消与恢复状态定向 JS **7 passed / 0 failed / 0 skipped**。lane 报告隔离 fake OAuth/MCP + 实际 pi 管理 child 的 IPC fixture **1**、loopback crate **13**、MCP/OAuth JS **38** 通过，以及 TS、Rust library+harness check 通过；后者是 lane 证据且使用空 resources，不是 standalone/native 验收。provider callback 仍未接 Rust。不因此重启逐提交独立审阅循环。父代理随后执行静态 tsc 与排除遗留 Next 生成类型的 root source-only tsc，均通过。
- `6dafa016` 合入 IPC 立即准入与 management nonce 修复；lane 的准入饱和测试 **1 passed**（含 1,000 个拒绝请求及预留控制容量），nonce router 测试 **1 passed**。错误 nonce 不再消耗 pending rid。父代理核对源变更及合并冲突，不将未执行的合并后 Rust 重构建称为通过；更广泛取消、事件和字节预算仍由该 lane 继续。

- `1552bd06` 调度器合并后：静态前端 **112 passed / 0 skipped**；静态 `tsc --noEmit` 通过；Rust `cargo check --lib --features harness --bin static-ui-harness` 通过。
- `507c6778` MCP checkpoint 合并后：静态 tsc 通过；MCP/service 定向测试 **17 passed**，同次没有指定 pi 的管理测试 **8 skipped**；随后显式指定本地 pi 重跑管理扩展 **8 passed / 0 skipped**。
- `507c6778` Rust library+harness compile check 通过。
- `850cba38` fleet/state 整合：客户端/组件 **18 passed**；新增旧 Session Arc 的 steering fence 回归 **1 passed**；static tsc、Rust library+harness check 通过。status/stop/interrupt 不被 steering 的准入门一并禁止。
- `67a9f6f0` trust writer 整合：定向 **42 passed / 0 skipped**；新增单/多 session writer 不等待 start mutex 的回归 **1 passed**；static tsc 与 Rust library+harness check 通过。旧插件 trust 源码断言跟随提取后的服务，同时保留 route 委托断言。
- `57be5fa3` 资源整合：静态测试 **139 passed / 0 skipped**；static tsc + Vite build、Rust library+harness check 通过。工作 lane 的 overwrite 修复 **6 passed**、native import **1 passed**，父代理没有重复未改动的相同测试。
- `4fcf5f92` 图片/下载整合：定向 JS **36 passed / 0 skipped**，Rust 保存测试 **3 passed / 0 ignored**（含新增共享文件游标回归）；static tsc、API inventory 校验（90 routes / 126 methods）、Rust library+harness check 通过。工作 lane 的 87 项定向 JS、真实 pi fixture 与 Vite build 是 lane 证据，未重复未改动的全套构建。
- `47a386ee` fork writer 整合：能力冲突后管理扩展语法检查及隔离真实管理/客户端 **12 passed / 0 skipped**。工作 lane 报告 session-host **42 passed / 1 ignored**、生命周期 **1**、真实 pi 分支 **1**、staging **3**、Chat **5**、JS **30** 通过，static tsc/harness check 通过；这些是 lane 证据，本次主线未追加 Rust 重编译。
- `17ddff35` 删除整合：除本状态文档外，合并代码与工作 lane 已测试的 `bae7a36e` 完全一致。lane 报告删除/journal **62 passed / 1 ignored**，该 ignored real-pi fork/group fixture 另行显式执行 **1 passed**；搜索 **5**、catalogue **3**、real-pi fork/branch **1**、UI service **4** 通过，非测试 `cargo check --lib` 通过。主线未重复这些未改动的相同检查；这些证据不代表生产删除权限已开放。
- 主线 `src-tauri/target` 检查时为 **26 GiB**（其中 incremental 8.7 GiB、deps 14 GiB），已停止进一步重编译，尚未清理可能含历史构建的产物；此后不能把未运行的 Rust 检查称为通过。
- 根目录普通 tsc 被 `.next`/`.next-desktop` 遗留生成类型对已删除 subagents 路由的引用阻塞；未删除开发缓存。排除这两处生成目录的临时 source-only 配置检查通过，不把它称为普通全量 tsc 通过。
- 上述 Rust compile checks 使用进程局部 `TAURI_CONFIG={"bundle":{"resources":[]}}`，只证明源码组合可编译，不证明资源打包。
- 工作 lane 的隔离真实 pi/MCP/PTY/调度 fixture 结果保留在各提交与交接报告中；不将其冒充主分支全套测试。
- 原静态 UI 浏览器桥证明了 Linux Rust/pi/PTY 的实际交互；尚无本轮全域整合后原生 WebView、系统菜单/对话框或四平台升级验收。

## 集中独立审阅（基线 `66b9f54b`）

本轮实现交接后进行了一次 GPT-6.1-Terra 只读集中审阅；未运行构建、测试或真实 provider。审阅方未独立核验 checkout 身份，父代理随后确认 HEAD 仍为 `66b9f54b` 且无 tracked 变更。审阅覆盖部分关键实现，**不是全域穷尽审计，也不证明其余域无缺陷**。

接受并已交回两条独立工作线修复的 P1：

- **资源响应无界物化——实现已修复合入 `3fb0b26b`**：单次响应最多 16 MiB、最多 4 个并发读取/响应构造，超额并发返回 503；过大的无 Range 请求返回明确 413，Range 返回有界 206 与实际 Content-Range。授权源用 Arc 快照后释放注册表锁，Unix 使用独立偏移读取。已准入读取可完成，revoke 后新请求拒绝。原生全量保存仍流式且不设新字节上限。
- **搜索规模回退——实现已修复合入 `0e0341e5`**：以有界目录扫描和 mtime 堆选取近期候选，每批最多 32 个源句柄；单文件最多读取 16 MiB、总快照最多 64 MiB。普通不可读项或合作式 3 秒预算耗尽保留已取得结果并标记 `truncated`，journal、writer fence、符号链接和已发现身份冲突仍拒绝。匹配继续使用原 TS 算法，结果映射回真实 session 路径。

两项均已由父代理核对源码并完成实现合入，**不等于端到端原生验收已完成**。资源工作 lane 报告 crate **15/15**、handler **5/5**、原生保存核心 **3/3**、IPC 往返 **1/1**；隔离 Chromium + 真实 Rust harness 验证大于 16 MiB WAV 的分块 206、跨块 seek 和无 Range 的 413。除本状态文档外，主线合并代码与该测试版本 `8e986c11` 完全一致，未重复相同重型测试。

搜索修改仅涉及 `src-tauri/src/session_search.rs`，合并文件与工作 lane 的 `a8b3e11a` 完全一致。lane 报告搜索定向 **18 passed**、pending-journal **1 passed**、原 TS 搜索 **10 passed**、非测试 `cargo check --lib` 通过；未重复其未变化的相同检查。超过 501 个候选时以文件 mtime 近似选取，超大文件元数据来自前缀，均标记截断；任一未决 writer fence 会保守使搜索 busy。3 秒预算不能中断已阻塞的文件系统调用。

Tauri 自定义协议接受缓冲 body，不是流。当前预算只覆盖读取/响应构造，**不覆盖返回后 Tauri/WebView 内部排队与传输生命周期**；原生媒体/PDF 是否续接 Range 未验，不发 Range 的大预览会收到 413，需下载或支持 Range 的查看器。取消清理的 unwind fixture 不是实际 WebView 中止验收。

不再逐提交反复启动独立审阅；修复后执行针对性回归。保存 hardlink/共享游标修复未被重新开单；`reveal` 路径竞态缺乏本轮具体可达影响证明，仍列待验，不称已确认漏洞。结论仍是禁止正式切换，可继续修复及 M5 准备。

## M5 必须关闭的门槛

1. 清完保留功能的 HTTP/EventSource/资源 URL 残留；同步 runtime op、静态服务 alias 与 UI 调用。存在 op 字符串不等于功能已实现。
2. DELETE、可取消分支摘要等剩余功能完整实现；自动命名的运行中主链已接，仍须真实 deadline/原生验收；已合并的 fork/clone/Chat/扩展 UI/fleet/消息图片/安全下载还需跨域回归与完整原生验收。公开 SDK 缺口需明确解决，不能靠静默降级、私有字段反射或另起 AgentSession。
3. IPC 真正有界准入、会话流背压/ACK/原子快照、未知副作用重启恢复与可见状态、所有退出/取消资源清理。
4. 调度器新旧产品运行排他、崩溃事务门安全恢复、后台/隐藏窗口运行和退出中的 active run 语义。引用检查和删除不能分离到门外。
5. Rust 拥有 OAuth loopback：MCP 静态路径已采用公开协议引擎及 Rust listener，仍需原生和平台验收；provider SDK 当前未暴露 callback 注入点，provider PoC 不算接入。
6. Windows/macOS 缺失的安全文件/进程/PTY 实现与实际平台证据。
7. 固定 SDK 管理树的 genuine standalone 布局、原生 WebView/preview ACL、官方安装工具行为、系统 dialogs、升级与状态迁移验收。
8. 完成统一 review/修复和回归后，才切换产品启动、启用正式 Rust scheduler、删 Next/backend-only 依赖与代码。当前没有声称到达此步。
