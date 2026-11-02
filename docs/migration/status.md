# 静态宿主迁移实施状态

此表记录主分支 `migrate/static-tauri-host` 截至 `69a8d636` 四类 observer relay 关闭、`5e7a2a51` 本地 CLI 认证夹具、`303da5bc` 账本／事件流及 `c4b46e72` 索引预算整合的状态（真实 MCP 链路及其他本地 CLI 失败门槛仍未关闭）。**不是 M5 验收报告。** README 中较早的测试计数、未迁移列表和 PoC 表是历史记录，以本表为当前状态；API 全量目标仍由 `api-inventory.json` 定义。

## 当前工作点：Windows Preview 优先

用户已恢复实施，并明确 **Windows 是本轮主要交付平台，Linux 暂无发行版本**。Linux 保留本地开发／测试用途；Linux/macOS 发包验收不作为 Windows Preview 的前置条件。允许新增独立 Windows Preview GitHub Actions，产物仅为测试 artifact，不发布正式 Release／tag／updater，也不切换默认生产入口。

- `c06e0761` 已整合 `18e7b900`／`7335bd79`／`45cbda86`：独立管理 SDK 已接入显式 development-package harness 配置与共享受限会话 writer。开发 CLI 绑定通过受信 checkout lock/pins、安装包 name/version/bin 与实际 CLI 路径交叉核验，不只信自报版本；不是 standalone 来源认证。
- `e7e5de88` 已整合 `392157f0`：自动化设置失败后的状态回同步改走现有数据接口，静态使用 IPC、Next 保留 HTTP；会话切换／卸载时拒绝迟到结果。
- `4190f1e6` 已整合 Windows Preview CI／清单准备至 `1add5581`。后续门禁提交 `6a23b2e3f17b5bffe94ed6d587991636d2e0e1dc` 已推送独立 `preview/windows-static` 并通过 ls-remote 核验；[首次 Actions 41506970519](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41506970519) 已启动、当前运行中，尚无 Windows 编译或安装包验收结果。独立 app identifier、主程序名、NSIS 资源清理路径及 artifact-only 边界不变。
- `04bde47d` 已整合原生入口至 `ad76f0d4`：真实 Tauri WebView/IPC/Channels/pi-resource，固定 packaged CLI 与独立管理 SDK，持久 Preview home/agent，独立身份，拒绝 updater 入口。修复了真实原生 OAuth stream 缺少 app ACL 授权的问题；只给 local-only main capability。Preview 明确拒绝 terminal.create、托盘隐藏、调度执行/接管，不把这些拒绝算作功能完成；退出不再追加无 deadline 的 PTY shutdown，也不宣称整个进程退出已证明有界。
- `3092a05c` 已整合 Windows target-key/ledger 至 `43feff98`，不再仅停在 `5a58cae8` WIP：目录句柄、实际句柄 ACL/身份、协作事务锁、文件内容 flush 后同卷发布，失败/残留拒绝及 Unknown 保留。无跨卷复制 fallback；WRITE_THROUGH 同卷 rename 不等同 POSIX 目录 fsync，突然断电耐久性未证明。**实现整合不等于 Windows 编译或功能已通过**。
- 新接入 Windows 精确门禁：11 项 storage 与 10 项 ownership/manifest/ACL/Preview 状态及 staged Rust→SDK 假 key store/delete→CLI ensure_session 夹具。先核验测试发现结果，再逐个 --exact 且要求 1 passed/0 failed/0 ignored；隐藏 checkout node_modules，不发 prompt、不访问真实账户。失败保留运行时夹具目录。首次 Actions 已启动，尚待实际测试结果；打包成功也不代表原生窗口、iframe 或安装升级通过。
- 历史暂停状态及资源限制见 [管理 SDK 暂停交接](pause-handoff-management-sdk.md)，其未合并状态以本节为准。

## 目前没有发生的切换

- 正式产品仍启动 Next；未删除旧后端、未启用正式 Rust 调度循环。
- 静态前端沿用原组件/UI，不把安全拒绝或空占位当功能完成。
- 上次暂停已核验推送主线 `5f322f56`、desktop-services `7335bd79`、mcp `69a8d636`。恢复后的整合现通过独立 Preview 分支 `6a23b2e3` 推送并启动 Actions，没有 force-push，也未更新生产默认分支、发布产品、修改更新仓库或签名策略。
- 本地托管 pi、SDK symlink、浏览器桥及 `tauri::test::mock_app` 都不是 standalone/native WebView/安装升级证明。

## 最新架构决定（尚待实现验证）

- 用户已明确允许：**管理侧独立使用官方 pi SDK 源码／模块发行版，与打包 CLI 严格同版本，不用于对话**。对话继续仅由 CLI 持有 AgentSession；不得把 CLI 的运行时对象交给另一 SDK 图使用。后续管理运行时可以有自己的单一、固定依赖图与受限协议，不再要求管理 SDK 与 CLI 内置 SDK 的对象具有跨运行时 class identity；仍需各自的版本、来源、模块根与协议边界校验。这不是授权修改／fork SDK、升级 SDK或增加第二个对话引擎，也不是已有 standalone 测试通过的证明。
- 用户已明确接受内部使用的风险边界：**外部 pi CLI、其他非协作实例／程序同时修改同一目录或数据，其冲突风险由用户承担**，与直接使用多个 pi 的情况相同。不要求普遍证明外部 writer 已停止，不再以无法排除任意外部写入作为 M5 完成或正常功能可用的阻断条件；后续维护、恢复、删除和调度接管应据此调整旧的外部排他前提，而不是永久 fail-closed。应用仍须协调自身管理的会话／任务／写入者及协作实例，保留路径授权、文件／事务保护、备份和必要确认；自身未决结果不能凭超时／leader 退出假称成功或自动清除。这个支持边界决定不等于已实现功能、SDK fork 授权或正式发布／切换验收。

## 已集成的实现

| 领域 | 当前范围 | 仍需区分的边界 |
|---|---|---|
| 会话基础 | 原 UI 创建/发送/流式/停止/队列编辑与立即发送、重开历史；目录/上下文投影、普通 fork/clone/navigate、rename/search/export；扩展 pending UI/回复/取消、fleet、thinking、prompt 与有证据的状态 | 自动命名已接 live registry、运行中/队列兼容和持久 rename fence；DELETE、带摘要分支及其关联 Stop 尚未完成；历史工具图片 resolver/URL 生命周期与安全 bash 下载已接线，原生验收未做；RPC custom UI 不支持，不伪造替代 |
| Chat | 解锁读写、继续到宿主已授权项目；旧 child 确认退出、固定短寿命文件 writer、source/target 持久 fence | 正式启动与 harness 默认拒绝解锁；原生主窗口/iframe ACL、Windows mutation、本应用协作宿主协调及未决结果恢复未验/未完成（非协作外部并发按用户承担风险） |
| 模型 | 列表/默认/启用模型最小编辑、models.json 读写、catalog/discover/test/nonchat/refresh/provider usage | 保留手动目录刷新及原配置校验，真实账户/付费请求未参与测试 |
| Provider 认证 | provider 列表/API key/类型安全删除/logout、OAuth 进度流及关联 task-input/取消；有界观察、原 task 重连、当前交互恢复和实验 static-host observer 关闭报告 | SDK 内置 OAuth callback 仍在 Node；Rust loopback 尚未接内置 provider；SDK abort race 不证明底层 writer 停止，未决 flow/ledger 不释放；真实账户及 native/standalone 未验 |
| MCP | 配置 CRUD/undo、项目 MCP 列表、本地 Test、OAuth start/status/input/cancel/signout；静态 IPC 的 OAuth loopback 由 Rust 持有、SDK 公共引擎处理协议；trust.set 与 fresh-folder 写入经过 policy 独占、受影响旧会话退出、持久 pending marker 和结果核对 | OAuth 超时/取消显示远端 token 不确定性，保留 15 秒期限及迟到本地写保护；canonical/legacy/config/generation 私有 admission 已接 JS，native ledger/reservation/probe receipt 消费已整合，但真实 MCP 链路仍失败，不能据 JS 合同或局部测试直接解除 pending；仅隔离 fake 服务及管理 child 验证，原生浏览器和跨平台待验；Next 路径仍为 SDK Node callback；非 Unix trust mutation 拒绝；重启后 pending 的产品恢复入口与本应用协作宿主协调未完成；非协作外部并发不再作为不可证明的阻断条件 |
| 插件/技能 | 列表/开关/批量技能禁用、搜索/check、install/update/remove 任务 UI/IPC | 不可取消的 SDK mutation 使用独占短寿命 pi；强停可能部分写入，结果 unknown；官方 skills CLI、真实 npm/git 安装及 Windows mutation 未验/未支持 |
| 文件/资源 | Unix root grant 保留目录对象与身份、准入复核路径、beneath-walk、目录/index/精确会话引用；普通 add 不续授已替换根，显式 native picker 可重新授权；统一 pi-resource 协议、Range/TTL/revoke、宿主内部栅格 byte grant；FileViewer/Markdown 资源、PDF/HTML/DOCX 预览与变更轮询、原生 drop/import、浏览器上传；overwrite 原子替换目录项，不截断硬链接 inode | 消息 sessionId/图片接线与 bash 下载已集成；原生保存使用有界准入、独立偏移流式读取和原子替换；reveal 路径重命名竞态待统一复审；失败暂存项不自动 unlink，可能留残件；Windows roots/read/index/pi-resource 句柄源码已接但未目标编译或原生执行，save/bash 与根外精确 session 引用仍缺；Windows index 的 Git 可见性尚未完成，故持续标记截断；Windows/Unix fallback 已加总节点、目录句柄及路径字节预算，Unix Git stdout/派生目录/响应和 cache 已有字节预算；Git 直接 child 最多 8 个预留槽、单一 reaper、宿主分域关闭报告；pre-exec 外部停止可阻塞 spawn，5 秒不是整个扫描硬期限，Git 路径重解析及后代仍不在证明内；真实 dialogs/ACL 未验 |
| Git/worktrees | status/diff/list/create/switch/delete/fetch、隔离 Git fixture | Windows runner fail-closed；macOS 尚未验证 |
| 设置 | 字体偏好/系统字体、tools/artifacts/Chat settings、自定义 CSS、状态镜像 | 非 Linux 字体与原生 UI 未验；跨版本镜像导入及升级仍需验收 |
| 终端 | Linux 真 PTY、原 TerminalPanel、输入/resize/history/ACK/lease/reconnect/close/settings | macOS/Windows 安全 cwd-handle spawn 未完成，创建 fail-closed |
| 调度器 | CRUD/preview/history/seen、marker 确认后的真实 RunSpawner、手动执行、事件、显式启动的 30s loop/租约/slot/overlap/catch-up、TS/Rust 共同事务门、scheduled-session index | 正式启动切换未做；最终关闭已区别于 pause，按共享 deadline 跟踪在途 run/claim 并保留 lease；普通 prompt 仍无请求级终态关联，正常 run 可能持续 unknown 并耗尽 128 条准入，不是调度兼容完成；旧二进制不参与新门，崩溃事务锁恢复未完 |
| 桌面服务 | 宿主原生目录选择授权、已知会话目录验证、distro/status/configure、updates.check；seed 为宿主内部操作 | 正式 seed 启动未切换；真实更新安装未执行；cwd.validate 不再授予任意前端路径权限 |
| 管理运行时 | 实例级结果 router、rid/nonce task、deadline/cancel/状态、关联输入、物理 scope 协调、插件独占实例 process-group 清理；Chat/session writer 与 trust 有持久拒绝标记 | 通用 task unknown 持久 ledger 已整合，重启恢复未完；标记不是跨进程锁；`6dafa016` 已改为 16 个普通槽 + 4 个清理/ACK 槽立即准入或 busy，不再排队等待 semaphore，但请求字节、其他流及 Tauri/WebView 内部队列仍未完成全链有界验证 |

## 当前实施工作

在各自 worktree 单 writer 实施，主代理合并共享注册点和冲突。基础类型/fixture 测试继续运行；实现完成后统一审阅，不为每个小提交反复扩展审计。

- **会话删除**：group journal、严格 scheduled 引用、session admission、直接子 header 重写、传递 subagent 级联、共享/独占 Chat 文件夹规则已整合。生产破坏性删除许可和 journal 恢复许可彼此独立，均默认不授予；DELETE 返回 `busy`，reason 为 `session_deletion_exclusive_maintenance_required`。活动的其他受影响会话、跨目录直接 fork child、无法核验的 cwd/引用仍保守拒绝，尚未达到完整旧行为。
- **会话资源消费者**：已合并工具图片 resolver、late-result revoke、Markdown sessionId 和安全 bash 下载；历史图片投影已配套启用。继续保留真实原生窗口/预览 ACL、对话框与平台验收门槛。
- **Fork/clone writer 修复**：`47a386ee` 已替换共享 child 的 `session.fork`：同门只读 live snapshot、受限短寿命 writer 私有 staging、预绑定目标和两端持久 fence、退出确认后的无覆盖发布；保留 fork_branch 的源 child/active leaf。group journal 已引入此基线，并在隔离 real-pi fixture 中验证其 pending fence 交互；policy 写锁仍不能代替本应用管理的未知 writer 的终止证明，协作宿主协调与用户恢复未完成；不再要求普遍排除非协作外部 writer。
- **未决结果与生命周期**：在 `073815f2` 基础上整合截至 `ca23c638` 的 registry/management/短 writer 关闭、内存 prompt receipt、已验证结果的 resolved fence 与 cleanupWarning，以及实验 static host 的 IPC drain、scheduler 和 child 关闭链。共用绝对 deadline；实际准入先关闭，报告/生命周期锁忙不阻塞、保留失败，重复调用不重放 FnOnce。若首次无法取得 callbacks，失败永久保留，不自动补清理。resolved 只证明运行时结果已知，不证明 SDK 数据断电耐久，也不授予恢复权。prompt receipt 尚非跨重启证据；`a38b2bf5` 保留原 exited/unknown 并增加结构化诊断，分别表达未决 receipt、leader 退出未确认及锁忙/在途范围。实验 harness 的 available 仅表示取得报告，缺报告返回 null/unknown，不是空成功。无关联 start/terminal 观测和 leader 退出均不清历史 unknown；旧宿主、脱管 writer、正式 bootstrap/seed/scheduler 和产品恢复仍未完成。
- **PTY 关闭门禁（提案及测试，非生产实现）**：[pre-exec 身份绑定提案](pty-preexec-binding-proposal.md) 来自 `c06be727`，独立测试控制器 `d242addc` 已单独纳入；没有吸收 observation-only `shutdown()` 回退或 vendor 实现。Linux fixture 以 post-open nonce 验证独立 pidfd、实际观测 SIGSTOP，证实截止时间不使 spawn worker 自动回收，随后由测试控制器安全终止并等待线程完成。它依赖正常调度、内核调用返回和受信 fixture；不证明生产绑定前任意停止可回收。vendor fd sweep 的异步信号安全及 spawn-error FD 风险仍开放，不能把测试变成生产终止授权。
- **Terra 并行续作**：按领域使用隔离工作树实施生命周期、会话 SDK、OAuth、独立打包、平台文件、传输、自动命名和 PTY/Git；本轮两路认证续作已交付并整合，不代表所有领域或验收完成。小提交不等于功能交付；源码未接生产调用者的 primitive 不列已完成。用户已允许同版本官方 SDK 独立用于管理，不用于对话；SDK 修改／fork 未获准。非协作外部 writer 并发风险已由用户明确接受；不得继续当作普遍排他证明门禁，具体内部协调和恢复实现仍需验证，详见上方最新架构决定。
- **自动命名**：`963f20fd` 接通 live child 的实际 model registry 和专用纯 helper bundle，`50714c76` 恢复运行中及 queued follow-up 的原行为；同分支正常追加不作 stale，模型/树 ABA、名称或 child 实例变化拒绝。改名使用公开 `pi.setSessionName`，不调用只读 extension context 未暴露的写方法；写前持久 marker，只有关联成功或明确写前拒绝清除，ACK 丢失/append 异常保留。最多 64 KiB 的 source 前缀仅为诊断，不冻结已准入运行。真实 90 秒 deadline 和原生 UI 仍待验。
- **独立打包与待整合续作**：生命周期与包装线至 `ca23c638` 的源码已整合，但不激活产品入口。固定官方 pi 的 relocation/manifest 和部分 session/cron/DOCX/OAuth 探针有 lane 证据，完整 standalone MCP 仍因第二 SDK 图 identity guard 失败，不得移除该 guard。transport 的 management ledger/reservation/probe receipt、running/scheduled 流预算、结构化关闭诊断、索引字节预算和 PTY 测试已分批整合（详见验证记录），但完整生命周期与原生验收仍未闭环。平台 `0c61b276` 已作为 `ef075806` 合入 Windows roots/read/index/资源句柄及 Unix 嵌套根回退修复；Windows 未目标编译。整合检查确认的空目录无界队列已在 `e099bbf3` 修复：最多物化 50,000 个条目、最多 64 个待处理目录句柄，当前目录及临时枚举句柄另计；耗尽保留 partial/truncated。该修复不代替 Windows 目标编译或原生验收。MCP lane 的 probe mode admission/局部 guard/私有 receipt 已接 native 消费，真实 MCP 测试仍未通过；stdio/provider-auth/`!command` 的宽 scope 不作为只读放行。这些均不是正式 bootstrap 或 M5 验收。
- **Composer 技能列表**：已复用 `skills-client` seam（Next fetch / 静态 IPC），保留 cwd 与取消守卫，不再在组件里直接请求 `/api/skills`。

## 集成验证记录（不是全量/跨平台验收）

- 原生入口至 `ad76f0d4` 的 lane Linux 定向验证包括资源清单 4 项、隔离状态/禁用操作 1 项、导航 1 项、child env 1 项及本地 CLI+SDK 不发 prompt 的竖向夹具 1 项；修订 ACL/关闭模式/PTY 拒绝三个精确测试各 1 passed，无 ignored。不是 Windows 或原生窗口证据。存储 `43feff98` 的两个 Linux 精确回归通过，Windows 11 项尚未编译/执行，普通退出测试不是强杀或断电。
- 父级补齐 Windows CI 精确门禁与真实 staged fake-key 夹具，并修正 manifest 测试对 Windows canonical 路径前缀的比较。父级 `windows-static-preview.test.mjs` **4 passed / 0 failed / 0 skipped**，`git diff --check` 通过；仅 Node 配置/接线检查，新增 Windows Rust 夹具与 PowerShell 执行仍待 runner 验证。

- 恢复后的开发管理 SDK 与 writer：整合至 `45cbda86`，父级审阅了显式 launcher、路径／版本绑定、受限 writer 接线、输入槽释放和模式环境剥离。修复普通 128 槽挤占控制通路的问题，Node 另留 4 控制槽；credential_type_mismatch 使用固定脱敏提示。lane 本轮精确 Node 3 项与 Rust 4 项各实际通过，library+harness check 通过；更早的 `7335bd79` 最小链路另有 Node 7／Rust 1 的 lane 证据，不合并为独立场景总数。首次 auth 夹具超时和 legacy 环境剥离测试失败保留在交付报告；父级没有把未重复运行的相同 Rust 测试称为父级执行。Windows 原生／standalone 尚未验证。
- `392157f0` 前端自动化：lane 相关 Node 17 项通过、无 skip，静态 TypeScript 通过；首次修复前 2 fail／1 cancellation 如实保留。使用真实数据接口加 fake IPC／hook harness，不是原生 WebView。父级审阅后整合，未重跑未变化的同一测试集。
- Windows Preview CI 准备至 `1add5581`：父级退回并核对修正了 NSIS 资源清理路径、独立主程序名、probe 输出预算及真实退出确认、SHA 版本后缀和 CI 产物统计。lane 最终相关 8 项通过、无 skip，最后 workflow 修改另跑 3 项；manifest 异版本校验另有此前 6 项通过证据，不重复累计。首次 js-yaml 导入错误及 Windows 路径断言失败保留。CI 的 staging 树仍有 1 GiB 上限；完整 Cargo/Tauri target 等另计并报告，不能把该上限称为整个 runner 峰值磁盘上限。本机唯一旧 bundle 未修改；没有运行 Actions、Windows 编译或安装升级。

- 整合 `27ed8685` 与修订 `69a8d636`：auth observer 与 session/running/scheduled 共用原始关闭 deadline；先关闭实际准入，计数覆盖 open/启动/绑定/登记清理，锁忙和阻塞 Channel 保留 unknown。增加 `auth.inFlight` / `auth.registryBusy`，缺报告仍 null/unknown；observer 结束不取消或证明 credential writer 已停。父级审阅发现登记前测试同步竞态，以及 unwind 可能留下 registration 却释放 permit；修订采用清理先于 reservation 释放的 RAII，poison 不二次 panic且保持不可检查。
  - 父级合并树首跑 auth 关闭测试 **7 pass / 1 fail**（新建临时可执行脚本出现 `ETXTBSY`）；改用固定只读 `test-fixtures/auth-relay.py`，同时修复 poison 测试对两个计数释放顺序的瞬时假设。重跑 auth 关闭 **8 passed / 0 failed / 0 ignored**，既有三流关闭 **4 passed / 0 failed / 0 ignored**；harness 构建和生命周期 HTTP 测试 **1 passed / 0 skipped**。日志中的两处 controlled panic 是显式异常夹具。Rust 测试有 2 条 deprecated warnings，harness 构建另有 7 条 dead-code warnings；target 3.9 GiB。仅覆盖受跟踪应用清理与报告，不证明 OS 线程、SDK writer、上游监听器或 Tauri/WebView 队列回收，生产 `RunEvent::Exit` 未改。

- 已整合 `5e7a2a51`，provider-auth 剩余两个本地真实 CLI 夹具改用小型 projection（lane 计量 5,630,803 bytes）与只读依赖；类型拒绝使用独立 agentDir，保留 Unknown 和凭据类型保护，不改变生产规则。父级在合并树分别以完整测试名 + `--exact` 运行，两项均 **1 passed / 0 failed / 0 ignored，无内部 skip**。未重跑旧输入测试或全套测试。子代理此前错误使用宽过滤词，误跑 31 项得到 **12 pass / 19 fail**，并违反禁止 SDK closure 复制的约束；父级保存了输出、核查列出的 staging 目录清理情况，完整失败清单与保留的 8 KiB Chat 残件见 [本地 CLI 失败记录](local-cli-failure-record.md)。除此次修复的 auth 项外，其余 **18 项失败未关闭**；不得把目标通过当整套通过。

- Provider-auth relay 已整合 `f9e30118` / `0f86cc39` / `d0193e75`，保留 `36b5d027` 的输入关闭门禁。真实 invoke ACK 保存原 flow/task 身份；首 snapshot / subscription / epoch / 连续 seq 验证后才 ACK 与续命；截断历史用最多 16 个、≤60 KiB 的当前交互恢复，Node 再检查 token 活性。observer detach 不取消写任务；显式 Cancel 保留最佳努力 abort，但 SDK `Models.login` 的 abort race 不能证明底层 provider 已退出，未决 flow 不释放容量，**SDK取消闭环仍未完成**；auth observer 最终关闭已由后续整合补齐（见上条），不等于 credential writer 完成性证明。
  - 父级合并树 JS 首轮 **56 pass / 1 fail**（旧断言要求原始 provider 错误）；改为明确验证脱敏错误及伪凭据不泄漏后 **57 pass / 0 fail / 0 skip**。静态及 source-only TypeScript、API inventory 检查通过。Next auth service/routes 无改动。
  - 父级 Linux Rust 定向输出为 9 pass，但其中 `login_input_bypasses_scope_mutation_isolation_and_enforces_task_guards` 内部因缺少 `PI_CLI_BIN` 返回，故只计 **8 项实际通过 + 1 内部跳过**；包含 Node login composition → fake RPC → Rust Channel → static service fixture，不是 native WebView/standalone。显式提供本地 CLI 单独运行该旧测试后 **1 fail**：`management agent directory differs from host agent directory`，未进入输入行为。当时该旧夹具还使用整树 staging；此失败作为历史记录保留，修复结果见下条，不把当时的失败回算为通过。另两项 `real_pi_*` 测试本轮未运行。两个 deprecated atomic warnings 保留。
  - 后续整合 `8696938a`，仅修复上述真实本地 CLI 输入夹具：host 绑定临时 agentDir；构建小型 projection 并只读引用本地依赖，不再复制 SDK closure，不放宽 managed-root/SDK identity 检查。正常、失败、取消分用隔离 agentDir，验证 pending 时阻止第二个 mutation、原 Running task 可继续输入，以及失败/取消保持 Unknown 和拒绝后续写入。当前真实 auth 准入不能构造“同 scope 一个 Running login 加另一个 Unknown mutation”，不为旧测试绕过 ledger，也不泛化到所有 management task 类型。
    父级合并树显式设置本地 `PI_CLI_BIN`、临时 HOME、`PI_OFFLINE=1` 重跑更名后的 `login_input_respects_pending_ledger_and_task_guards`：**1 passed / 0 failed / 0 ignored / 382 filtered**，无内部 skip；子代理也单独运行该项通过。两者是同一夹具的两次验证，不计作两项不同测试。未重跑未变化的 JS/其他 Rust，也不是 standalone/native 或真实账号认证验收。另两项旧 `real_pi_*` 夹具尚未改造、未运行。

- 父代理补齐 task-input 关闭门禁：`submit_task_input` 原先未读取共享 host-closing fence；现在在同一个实例状态临界区检查关闭并登记 activity，覆盖验证、派发及响应等待。使用独立 **4 槽/实例** 输入准入，避免 128 个普通 activity 饱和时阻断任务完成所需的输入；关闭前已准入但未发送的输入仍进入 unknown 统计，不把输入返回当凭据 writer 停止。新增真实 Rust→fake management child 定向回归 **4 passed / 0 failed / 0 ignored**，覆盖旧引用、锁等待后关闭、发送前在途及普通饱和/输入饱和；不是真实认证或跨平台验收。

- `09029072` 三类 relay 关闭整合：父代理检查了准入先关闭、共享绝对 deadline、预留跨登记/启动/清理保留、独立于 registry 的 shutdown 检查、阻塞 Channel 与锁忙 unknown，以及可选报告缺失时的 null/unknown。代码树与 lane 测试提交一致；lane 定向 Rust **23 passed**、harness JS **1 passed**，不重复称作父代理测试。父代理另跑合并树 running 回归 **12 passed / 0 failed / 0 ignored**，其中两项使用真实本地 pi 与隔离假模型端点；Tauri `--locked` 测试构建通过（1 条 deprecated warning），target **3.6 GiB**。报告仅覆盖受跟踪应用工作清理，不证明 OS 线程或 WebView 内部队列回收；auth relay、上游监听器及生产关闭仍不在覆盖内。
- MCP 补充调查（lane `e35f6fe0`，父代理未重复实验）：复用唯一 **428 MiB** bundle，以隔离 HOME、无仓库挂载的 bwrap 分别运行固定 Node 的公开 CLI bin 与公开 rpc-entry；两次 RPC handled，disk public/internal `createMcpExtension` 相等，而 `ctx.sessionManager instanceof` disk public `SessionManager` 为 false。这些是身份探针，不是 MCP 功能通过证据，也没有断言 CLI 内部 MCP factory 的身份；不能把旧 fixture 改指 bundle 就认定单图安全。此前 standalone Bun identity guard 的红门禁保留，未修改 SDK、正式入口或根路径校验。

- `303da5bc` 及其管理账本/MCP admission/probe 依赖整合：保留共享 host-closing fence、in-flight operation 计数、Session 结构化诊断及 recovery 的 `sessionWriterCleanup`、`managementOperations` 两项。父代理管理 crate **31 passed / 0 failed / 0 ignored**（明确设置本地 `PI_CLI_BIN`，隔离 HOME）；session crate **49 passed / 0 failed / 1 ignored**（scan-report fixture）；Tauri 定向集最终 **40 passed、2 个 MCP 测试仍失败**。旧任意 operation-name 测试已换成正式只读操作；错误 nonce 注入仍必须不能消费 pending rid；持久 mutation uncertainty 的断言仍由 ledger tests 保留。两项真实 running 测试补宿主侧 fixture 根授权后通过，未放宽前端路径权限。
- MCP 红门禁：真实 IPC config/OAuth 两项及 JS management 一项尚失败。JS 复现的明确原因为 `@earendil-works/pi-mcp resolved outside the managed tree`：旧 fixture 用依赖符号链接，不满足此前包装层新增的管理树边界。未删除该检查、SDK identity guard 或用第二 SDK 图绕过。不能沿用 lane 的历史通过结论宣称当前合并树 MCP 通过；安全边界/fixture 图与真正 standalone 的 SDK 实例问题需分开解决。JS 初轮 **159 passed / 0 failed / 1 skipped**，随后启用真实 pi 的那一项 **0 passed / 1 failed / 0 skipped**。初次直接运行 Rust test binary 的 4 项曾因 cwd 错误失败，改用 Cargo 对应 cwd 后才暴露上述实际问题。
- static/source-only TypeScript 与 API inventory（90 routes / 126 methods）通过。Rust 单 crate 测试使用各自离线开发锁，正式 Tauri manifest 构建使用 `--locked`；没有 npm 安装或修改共享依赖。target **3.5 GiB**。`93e5cffe` 当时尚未把 session/running/scheduled 长寿命 relay 纳入 static-host 共用 deadline；该缺口由上述 `09029072` 增量补充，仍不能宣称全部服务已收束。provider-auth lane `0f86cc39` 已交付、待父代理审阅，并非已验收。

- `c4b46e72` 索引预算整合：父代理保留 Session 结构化诊断和 index-child 独立报告，合并 harness 最小静态 fixture 冲突；index unknown 计数明确是预留槽而非精确进程数。合并后 Linux 定向 Rust **38 passed / 0 failed / 0 ignored**（文件资源 25、tracker 2、static-host 11）；harness 构建通过（7 条 dead-code warning），生命周期 HTTP 测试 **1 passed / 0 skipped**。使用空 Tauri resources 和临时 HTML，不是独立包/原生验收。复用已空闲 resource-ui target，完成后 **3.4 GiB**；临时 HOME 已清理。8 MiB stdout/路径/派生与响应预算、32 MiB cache 估算上限不涵盖 Tauri/WebView 内部队列；spawn 不可返回及 Git 路径重解析门禁保留。

- `d242addc` PTY 测试单独选入：父代理审阅 nonce 时序、未绑定不发信号、停止状态观测和清理路径；只纳入测试/文档，不合入 vendor 或终止实现。lane Linux **2 passed / 0 failed**，本次日志无 SKIP；fixture 在 pidfd 不支持时会打印 SKIP 并提前返回，Rust 会把这种返回计作 pass，因此以后必须检查日志，不能仅凭测试总数宣称故障实际执行。父代理未重跑该未改变的 fixture。

- `a38b2bf5` 结构化关闭报告：父代理审阅 receipt phase/去重、原字段兼容、缺报告序列化和锁文件（只增加已有 serde 的直接依赖/derive），确认合并后代码目录与 lane 完全一致。lane shutdown **8**、prompt lifecycle **2**、static-host **10**、harness **1** 通过；harness 首次因固定静态 bundle 缺失失败，改为测试自有空静态目录后通过，仅验证报告 HTTP 接线、不验证静态资源；序列化补充断言另行重跑。父代理未重复相同 Rust 构建，这些不证明 SDK 终态关联或 native 验收。

- `ca23c638` 生命周期／实验关闭链整合：父代理确认合并后 `crates/`、`src-tauri/`、`lib/`、`scripts/`、`static-frontend/` 与该固定 lane 提交一致，未重复未变的 Rust 重构建。父代理定向 JS **18 passed / 0 failed / 0 skipped**，静态 tsc 与 root source-only tsc 通过；其中 3 个 session-action 测试只是待实现 SDK 合同 fixture，不是已实现分支取消证明。lane 锁竞争回归 lifecycle **5**、static host **9**，均无失败/忽略，library+harness check 通过（7 条 dead-code warning）。先前 lane fence **10**、cleanup/recovery JS **3**、mock harness **1** 是分别执行的证据；全部不代表正式 bootstrap、standalone MCP 或原生安装验收。

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
4. 本应用管理的调度器／协作实例运行协调、崩溃事务门安全恢复、后台/隐藏窗口运行和退出中的 active run 语义。引用检查和删除不能分离到门外；用户自行启动的非协作外部 writer 风险按已批准支持边界处理，不要求普遍排他证明。
5. Rust 拥有 OAuth loopback：MCP 静态路径已采用公开协议引擎及 Rust listener，仍需原生和平台验收；provider SDK 当前未暴露 callback 注入点，provider PoC 不算接入。
6. Windows 缺失的安全存储／文件／进程／PTY 实现与实际平台证据为本轮重点；Preview 对尚未支持项必须如实提示，不以 Linux 测试代替 Windows 证明。macOS 后续单独验收，不阻塞本轮 Windows Preview。
7. Windows 固定 SDK 管理树的 genuine standalone 布局、原生 WebView/preview ACL、官方安装工具行为、系统 dialogs、NSIS 升级与状态迁移验收。Linux 不作为本轮发行目标。
8. 完成统一 review/修复和回归后，才切换产品启动、启用正式 Rust scheduler、删 Next/backend-only 依赖与代码。当前没有声称到达此步。
