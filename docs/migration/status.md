# 静态宿主迁移实施状态

此表记录主分支 `migrate/static-tauri-host` 在 `507c6778` 的集成状态。**不是 M5 验收报告。** README 中较早的测试计数、未迁移列表和 PoC 表是历史记录，以本表为当前状态；API 全量目标仍由 `api-inventory.json` 定义。

## 目前没有发生的切换

- 正式产品仍启动 Next；未删除旧后端、未启用正式 Rust 调度循环。
- 静态前端沿用原组件/UI，不把安全拒绝或空占位当功能完成。
- 没有发布、推送、修改更新仓库或签名策略。
- 本地托管 pi、SDK symlink、浏览器桥及 `tauri::test::mock_app` 都不是 standalone/native WebView/安装升级证明。

## 已集成的实现

| 领域 | 当前范围 | 仍需区分的边界 |
|---|---|---|
| 会话基础 | 原 UI 创建/发送/流式/停止/队列编辑与立即发送、重开历史；目录/上下文投影、普通 fork/clone/navigate、rename/search/export | DELETE、自动命名、带摘要分支及 Stop 尚未完成；扩展 UI、fleet、丰富状态及懒加载余项在实施 |
| 模型 | 列表/默认/启用模型最小编辑、models.json 读写、catalog/discover/test/nonchat/refresh/provider usage | 保留手动目录刷新及原配置校验，真实账户/付费请求未参与测试 |
| Provider 认证 | provider 列表/API key/类型安全删除/logout、OAuth 进度流及关联 task-input/取消 | SDK 内置 OAuth callback 仍在 Node；Rust loopback 尚未接内置 provider |
| MCP | 配置 CRUD/undo、项目 MCP 列表、trust 写入、本地 Test，结构化 refusal 兼容 | OAuth 仅服务/fixture checkpoint，IPC 尚在接；信任后的 idle-session 安全重建未完 |
| 插件/技能 | 列表/开关/批量技能禁用、搜索/check、install/update/remove 任务 UI/IPC | 不可取消的 SDK mutation 使用独占短寿命 pi；强停可能部分写入，结果 unknown；官方 skills CLI、真实 npm/git 安装及 Windows mutation 未验/未支持 |
| 文件/资源 | Unix 授权根 beneath-walk、列目录/链接授权/read/write/index、资源句柄、图片/原生保存/附件服务；DOCX 在固定 pi 管理树中提取 | Windows 句柄级实现、剩余消息资源 URL 与下载/预览原生通道、真实 OS dialogs/ACL 待完整验收 |
| Git/worktrees | status/diff/list/create/switch/delete/fetch、隔离 Git fixture | Windows runner fail-closed；macOS 尚未验证 |
| 设置 | 字体偏好/系统字体、tools/artifacts/Chat settings、自定义 CSS、状态镜像 | 非 Linux 字体与原生 UI 未验；跨版本镜像导入及升级仍需验收 |
| 终端 | Linux 真 PTY、原 TerminalPanel、输入/resize/history/ACK/lease/reconnect/close/settings | macOS/Windows 安全 cwd-handle spawn 未完成，创建 fail-closed |
| 调度器 | CRUD/preview/history/seen、marker 确认后的真实 RunSpawner、手动执行、事件、显式启动的 30s loop/租约/slot/overlap/catch-up、TS/Rust 共同事务门、scheduled-session index | 正式启动切换未做；旧已发布二进制不参与新门；崩溃事务锁恢复未完；引用扫描需为删除严格拒绝损坏行 |
| 管理运行时 | 实例级结果 router、rid/nonce task、deadline/cancel/状态、关联输入、物理 scope 协调、插件独占实例 process-group 清理 | unknown 仍仅内存，重启持久恢复未完；Semaphore(16) 仅限制活动调用，未限制全部待准入请求 |

## 当前实施工作

在各自 worktree 单 writer 实施，主代理合并共享注册点和冲突。基础类型/fixture 测试继续运行；实现完成后统一审阅，不为每个小提交反复扩展审计。

- **会话删除**：严格 scheduled 引用扫描、同事务门检查与删除、session admission、journal/恢复、子关系与共享 Chat 文件夹规则。生产 DELETE 仍安全拒绝。
- **会话扩展交互与状态**：reader 启动前 UI attach、权威 pending 生命周期、显式回复/取消，随后 fleet/状态/消息懒数据；不得覆盖 bridge 的 notify handler。
- **MCP 登录**：固定管理树内 OAuth task 生命周期、关联输入/状态/取消/sign-out、信任重建；使用隔离 fake OAuth/MCP fixture。
- **桌面服务**：distro/updates/cwd.status/目录选择；distro checkpoint 尚在 lane，未算入上述已集成表。

## 集成验证记录（不是全量/跨平台验收）

- `1552bd06` 调度器合并后：静态前端 **112 passed / 0 skipped**；静态 `tsc --noEmit` 通过；Rust `cargo check --lib --features harness --bin static-ui-harness` 通过。
- `507c6778` MCP checkpoint 合并后：静态 tsc 通过；MCP/service 定向测试 **17 passed**，同次没有指定 pi 的管理测试 **8 skipped**；随后显式指定本地 pi 重跑管理扩展 **8 passed / 0 skipped**。
- `507c6778` Rust library+harness compile check 通过。两次 check 使用进程局部 `TAURI_CONFIG={"bundle":{"resources":[]}}`，只证明源码组合可编译，不证明资源打包。
- 工作 lane 的隔离真实 pi/MCP/PTY/调度 fixture 结果保留在各提交与交接报告中；不将其冒充主分支全套测试。
- 原静态 UI 浏览器桥证明了 Linux Rust/pi/PTY 的实际交互；尚无本轮全域整合后原生 WebView、系统菜单/对话框或四平台升级验收。

## M5 必须关闭的门槛

1. 清完保留功能的 HTTP/EventSource/资源 URL 残留；同步 runtime op、静态服务 alias 与 UI 调用。存在 op 字符串不等于功能已实现。
2. DELETE、自动命名、可取消分支摘要、Chat 解锁/继续到项目、扩展 UI/fleet 等保留功能完整实现；公开 SDK 缺口需明确解决，不能靠静默降级、私有字段反射或另起 AgentSession。
3. IPC 真正有界准入、会话流背压/ACK/原子快照、未知副作用重启恢复与可见状态、所有退出/取消资源清理。
4. 调度器新旧产品运行排他、崩溃事务门安全恢复、后台/隐藏窗口运行和退出中的 active run 语义。引用检查和删除不能分离到门外。
5. Rust 拥有 OAuth loopback；SDK 当前未暴露 callback 注入点，PoC 不算接入。
6. Windows/macOS 缺失的安全文件/进程/PTY 实现与实际平台证据。
7. 固定 SDK 管理树的 genuine standalone 布局、原生 WebView/preview ACL、官方安装工具行为、系统 dialogs、升级与状态迁移验收。
8. 完成统一 review/修复和回归后，才切换产品启动、启用正式 Rust scheduler、删 Next/backend-only 依赖与代码。当前没有声称到达此步。
