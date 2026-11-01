# 设备重启交接

用户要求立即停止工作、提交并推送，稍后继续。本次仅保存检查点，不代表 M5 完成。

## 已停止与保存

- 主分支：`migrate/static-tauri-host`；本交接提交之前为 `d7b87a84`。
- 唯一仍运行的包装线 `e18bdf7b-89b8-49dd-987d-ed18819ada69` 已停止；未启动后续工作。
- 包装线被中断的 3 个已跟踪文件已单独保存为 **`66257c05`**，分支 `migrate/lane-desktop-services`。这是 **WIP，未验证**，不要据此称 deadline 修复完成。
- 保存时未发现运行中的 cargo test/check/build 或 rustc 编译进程。各 migration 工作树其他已跟踪文件无未提交修改。
- 用户的未跟踪 `plans/*` 保持原样，不纳入提交；构建 target、node_modules 链接和暂存 bundle 也不纳入 Git。

## 恢复时先做什么

1. 阅读 `docs/migration/status.md` 与本文件；不要启用生产静态宿主、删除 Next、启用 seed/scheduler、授予恢复/删除权限。
2. 先检查包装线 `66257c05` 的中断修改（`host_lifecycle.rs`、`static_host.rs`、`bin/static-ui-harness.rs`）：原问题是 shutdown callback 发布报告时阻塞式 `report.lock()`，以及生命周期进入/最终发布时 `inner.lock()` 可突破共享 deadline。确认锁竞争前关闭实际准入、锁忙有界返回、失败诊断保留、FnOnce 不被重放；补报告 guard 与内部状态锁竞争测试。**这 3 个文件没有完成父代理审阅或测试。**
3. 包装线原已测试提交 `29cf8f76` 接入实验 scheduler 最终关闭：static-host 7、writer-fence 10、cleanup/recovery JS 3、mock harness 1。均为 lane 结果，不是主线或原生安装验收。
4. 包装线相对主线约 49 个文件的整合尚未进行，包含生命周期、短 writer、prompt receipt、resolved fence、scheduler 与独立 bundle 改动。逐项审阅后再整合，不整块覆盖主线接口。
5. transport `069e92e5` 仍待父代理审阅/整合；合并 recovery UI 时同时保留 managementOperations 和 sessionWriterCleanup，不能互相覆盖。

## 分支检查点

| 分支 | 提交 | 状态 |
| --- | --- | --- |
| migrate/lane-desktop-services | 66257c05 | 中断的锁 deadline 修复 WIP；此前 29cf8f76 为已测实验接线 |
| migrate/lane-session-ui | 806ad547 | scheduler lease 安全修复；普通 run 仍 unknown，可能耗尽 128 条准入，不是兼容完成 |
| migrate/lane-chat-access | 1966375e | 生命周期/短 writer/prompt receipt/resolved fence；包装线已吸收 |
| migrate/lane-session-deletion | 069e92e5 | management ledger、合作撤权、probe receipt、部分流预算；尚未主线整合 |
| migrate/lane-mcp | ff3157de | MCP probe guard/receipt；未完整主线整合 |
| migrate/lane-resource-ui | fd9d0ba8 | 资源句柄/index 预算已整合；Windows 未编译/原生验证 |
| migrate/lane-m5-pty | c06be727 | 提案；实现未整合，旧 shutdown 观测式回退不可作为兼容实现 |
| migrate/lane-m5-title | 68c7f471 | 已整合，并由父代理修正公开 pi.setSessionName 调用和 fixture |

## 必须保留的门禁

- SDK 最小补丁/固定可复现 fork 与合作式外部 writer 支持范围两项仍未获用户批准；本次“提交推送”不是这些功能变更的批准。
- 普通 agent_settled 不关联具体 prompt；不能清除未知结果或把写入 failed/succeeded 记录当作 writer 停止证明。
- PTY 提案见 `pty-preexec-binding-proposal.md`：绑定前 SIGSTOP 可令 std::Command::spawn 线程不可回收；固定线程池不解决该问题。尚无安全清理故障 fixture，未运行 SIGSTOP 注入。
- 完整 standalone MCP 仍受第二 SDK 图 identity guard 阻断；不能移除 guard 冒充通过。
- Next 仍是正式启动方式；没有原生安装、升级、跨平台或全域 WebView 验收。

## 资源与测试约束

工作树根 `/home/hao/projects/pi-agent-migration-worktrees`。重型构建共用 `.heavy-build.lock`；每 target 8 GiB 上限，jobs=2、dev/test debug=0、incremental=0。主仓库历史 `src-tauri/target` 约 26 GiB，不用于新构建，不擅自删除。单 bundle/暂存总预算 1 GiB，禁止复制源码/node_modules 做临时完整副本。测试隔离 HOME/agentDir，清除 PI_PACKAGE_DIR、PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT、JITI_ALIAS；只用假凭据/本地 fake provider，不触碰真实用户数据。空 resources/mock 结果不算独立或原生验收。
