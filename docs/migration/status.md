# 静态宿主迁移实施状态

此表记录主分支 `migrate/static-tauri-host` 截至 staged fork writer 集成点 `47a386ee` 的状态。**不是 M5 验收报告。** README 中较早的测试计数、未迁移列表和 PoC 表是历史记录，以本表为当前状态；API 全量目标仍由 `api-inventory.json` 定义。

## 目前没有发生的切换

- 正式产品仍启动 Next；未删除旧后端、未启用正式 Rust 调度循环。
- 静态前端沿用原组件/UI，不把安全拒绝或空占位当功能完成。
- 没有发布、推送、修改更新仓库或签名策略。
- 本地托管 pi、SDK symlink、浏览器桥及 `tauri::test::mock_app` 都不是 standalone/native WebView/安装升级证明。

## 已集成的实现

| 领域 | 当前范围 | 仍需区分的边界 |
|---|---|---|
| 会话基础 | 原 UI 创建/发送/流式/停止/队列编辑与立即发送、重开历史；目录/上下文投影、普通 fork/clone/navigate、rename/search/export；扩展 pending UI/回复/取消、fleet、thinking、prompt 与有证据的状态 | DELETE、自动命名、带摘要分支及 Stop 尚未完成；历史工具图片 resolver/URL 生命周期与安全 bash 下载已接线，原生验收未做；RPC custom UI 不支持，不伪造替代 |
| Chat | 解锁读写、继续到宿主已授权项目；旧 child 确认退出、固定短寿命文件 writer、source/target 持久 fence | 正式启动与 harness 默认拒绝解锁；原生主窗口/iframe ACL、Windows mutation、跨宿主排他及未决结果恢复未验/未完成 |
| 模型 | 列表/默认/启用模型最小编辑、models.json 读写、catalog/discover/test/nonchat/refresh/provider usage | 保留手动目录刷新及原配置校验，真实账户/付费请求未参与测试 |
| Provider 认证 | provider 列表/API key/类型安全删除/logout、OAuth 进度流及关联 task-input/取消 | SDK 内置 OAuth callback 仍在 Node；Rust loopback 尚未接内置 provider |
| MCP | 配置 CRUD/undo、项目 MCP 列表、本地 Test、OAuth start/status/input/cancel/signout；trust.set 与 fresh-folder 写入经过 policy 独占、受影响旧会话退出、持久 pending marker 和结果核对 | SDK OAuth callback 仍在 Node；非 Unix trust mutation 拒绝；重启后 pending 的产品恢复入口与跨宿主排他未完成 |
| 插件/技能 | 列表/开关/批量技能禁用、搜索/check、install/update/remove 任务 UI/IPC | 不可取消的 SDK mutation 使用独占短寿命 pi；强停可能部分写入，结果 unknown；官方 skills CLI、真实 npm/git 安装及 Windows mutation 未验/未支持 |
| 文件/资源 | Unix beneath-walk、目录/index/精确会话引用；统一 pi-resource 协议、Range/TTL/revoke、宿主内部栅格 byte grant；FileViewer/Markdown 资源、PDF/HTML/DOCX 预览与变更轮询、原生 drop/import、浏览器上传；overwrite 原子替换目录项，不截断硬链接 inode | 消息 sessionId/图片接线与 bash 下载已集成；原生保存使用有界准入、独立偏移流式读取和原子替换；reveal 路径重命名竞态待统一复审；失败暂存项不自动 unlink，可能留残件；Windows 安全句柄及真实 dialogs/ACL 未验/未完成 |
| Git/worktrees | status/diff/list/create/switch/delete/fetch、隔离 Git fixture | Windows runner fail-closed；macOS 尚未验证 |
| 设置 | 字体偏好/系统字体、tools/artifacts/Chat settings、自定义 CSS、状态镜像 | 非 Linux 字体与原生 UI 未验；跨版本镜像导入及升级仍需验收 |
| 终端 | Linux 真 PTY、原 TerminalPanel、输入/resize/history/ACK/lease/reconnect/close/settings | macOS/Windows 安全 cwd-handle spawn 未完成，创建 fail-closed |
| 调度器 | CRUD/preview/history/seen、marker 确认后的真实 RunSpawner、手动执行、事件、显式启动的 30s loop/租约/slot/overlap/catch-up、TS/Rust 共同事务门、scheduled-session index | 正式启动切换未做；旧已发布二进制不参与新门；崩溃事务锁恢复未完；引用扫描需为删除严格拒绝损坏行 |
| 桌面服务 | 宿主原生目录选择授权、已知会话目录验证、distro/status/configure、updates.check；seed 为宿主内部操作 | 正式 seed 启动未切换；真实更新安装未执行；cwd.validate 不再授予任意前端路径权限 |
| 管理运行时 | 实例级结果 router、rid/nonce task、deadline/cancel/状态、关联输入、物理 scope 协调、插件独占实例 process-group 清理；Chat/session writer 与 trust 有持久拒绝标记 | 通用 task unknown 仍仅内存，重启恢复未完；标记不是跨进程锁；Semaphore(16) 仅限制活动调用，未限制全部待准入请求 |

## 当前实施工作

在各自 worktree 单 writer 实施，主代理合并共享注册点和冲突。基础类型/fixture 测试继续运行；实现完成后统一审阅，不为每个小提交反复扩展审计。

- **会话删除**：严格 scheduled 引用扫描、同事务门检查与删除、session admission、journal/恢复、子关系与共享 Chat 文件夹规则。生产 DELETE 仍安全拒绝。
- **会话资源消费者**：已合并工具图片 resolver、late-result revoke、Markdown sessionId 和安全 bash 下载；历史图片投影已配套启用。继续保留真实原生窗口/预览 ACL、对话框与平台验收门槛。
- **Fork/clone writer 修复**：`47a386ee` 已替换共享 child 的 `session.fork`：同门只读 live snapshot、受限短寿命 writer 私有 staging、预绑定目标和两端持久 fence、退出确认后的无覆盖发布；保留 fork_branch 的源 child/active leaf。删除工作线正在引入此基线验证 group journal 交互；policy 写锁仍不能代替未知 writer 的终止证明，跨宿主排他与用户恢复未完成。
- **未决结果与生命周期**：trust/session 持久标记保留拒绝语义，产品恢复流程、旧宿主排他、正式 seed/scheduler 启动仍属 M5。
- **Composer 技能列表**：已复用 `skills-client` seam（Next fetch / 静态 IPC），保留 cwd 与取消守卫，不再在组件里直接请求 `/api/skills`。

## 集成验证记录（不是全量/跨平台验收）

- `1552bd06` 调度器合并后：静态前端 **112 passed / 0 skipped**；静态 `tsc --noEmit` 通过；Rust `cargo check --lib --features harness --bin static-ui-harness` 通过。
- `507c6778` MCP checkpoint 合并后：静态 tsc 通过；MCP/service 定向测试 **17 passed**，同次没有指定 pi 的管理测试 **8 skipped**；随后显式指定本地 pi 重跑管理扩展 **8 passed / 0 skipped**。
- `507c6778` Rust library+harness compile check 通过。
- `850cba38` fleet/state 整合：客户端/组件 **18 passed**；新增旧 Session Arc 的 steering fence 回归 **1 passed**；static tsc、Rust library+harness check 通过。status/stop/interrupt 不被 steering 的准入门一并禁止。
- `67a9f6f0` trust writer 整合：定向 **42 passed / 0 skipped**；新增单/多 session writer 不等待 start mutex 的回归 **1 passed**；static tsc 与 Rust library+harness check 通过。旧插件 trust 源码断言跟随提取后的服务，同时保留 route 委托断言。
- `57be5fa3` 资源整合：静态测试 **139 passed / 0 skipped**；static tsc + Vite build、Rust library+harness check 通过。工作 lane 的 overwrite 修复 **6 passed**、native import **1 passed**，父代理没有重复未改动的相同测试。
- `4fcf5f92` 图片/下载整合：定向 JS **36 passed / 0 skipped**，Rust 保存测试 **3 passed / 0 ignored**（含新增共享文件游标回归）；static tsc、API inventory 校验（90 routes / 126 methods）、Rust library+harness check 通过。工作 lane 的 87 项定向 JS、真实 pi fixture 与 Vite build 是 lane 证据，未重复未改动的全套构建。
- `47a386ee` fork writer 整合：能力冲突后管理扩展语法检查及隔离真实管理/客户端 **12 passed / 0 skipped**。工作 lane 报告 session-host **42 passed / 1 ignored**、生命周期 **1**、真实 pi 分支 **1**、staging **3**、Chat **5**、JS **30** 通过，static tsc/harness check 通过；这些是 lane 证据，本次主线未追加 Rust 重编译。
- 主线 `src-tauri/target` 检查时为 **26 GiB**（其中 incremental 8.7 GiB、deps 14 GiB），已停止进一步重编译，尚未清理可能含历史构建的产物；此后不能把未运行的 Rust 检查称为通过。
- 根目录普通 tsc 被 `.next`/`.next-desktop` 遗留生成类型对已删除 subagents 路由的引用阻塞；未删除开发缓存。排除这两处生成目录的临时 source-only 配置检查通过，不把它称为普通全量 tsc 通过。
- 上述 Rust compile checks 使用进程局部 `TAURI_CONFIG={"bundle":{"resources":[]}}`，只证明源码组合可编译，不证明资源打包。
- 工作 lane 的隔离真实 pi/MCP/PTY/调度 fixture 结果保留在各提交与交接报告中；不将其冒充主分支全套测试。
- 原静态 UI 浏览器桥证明了 Linux Rust/pi/PTY 的实际交互；尚无本轮全域整合后原生 WebView、系统菜单/对话框或四平台升级验收。

## M5 必须关闭的门槛

1. 清完保留功能的 HTTP/EventSource/资源 URL 残留；同步 runtime op、静态服务 alias 与 UI 调用。存在 op 字符串不等于功能已实现。
2. DELETE、自动命名、可取消分支摘要等剩余功能完整实现；已合并的 fork/clone/Chat/扩展 UI/fleet/消息图片/安全下载还需跨域回归与完整原生验收。公开 SDK 缺口需明确解决，不能靠静默降级、私有字段反射或另起 AgentSession。
3. IPC 真正有界准入、会话流背压/ACK/原子快照、未知副作用重启恢复与可见状态、所有退出/取消资源清理。
4. 调度器新旧产品运行排他、崩溃事务门安全恢复、后台/隐藏窗口运行和退出中的 active run 语义。引用检查和删除不能分离到门外。
5. Rust 拥有 OAuth loopback；SDK 当前未暴露 callback 注入点，PoC 不算接入。
6. Windows/macOS 缺失的安全文件/进程/PTY 实现与实际平台证据。
7. 固定 SDK 管理树的 genuine standalone 布局、原生 WebView/preview ACL、官方安装工具行为、系统 dialogs、升级与状态迁移验收。
8. 完成统一 review/修复和回归后，才切换产品启动、启用正式 Rust scheduler、删 Next/backend-only 依赖与代码。当前没有声称到达此步。
