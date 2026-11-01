# 暂停交接：独立管理 SDK 运行时

用户要求暂时中断，明日再继续。本次仅保存与推送，不继续实现或扩大测试。

## 分支与提交

- 主线：`migrate/static-tauri-host`，功能／决策基线 `736ed53a`；本交接文件另提交在其后。
- 已集成：`16ab5e9a`（真实 CLI auth 夹具及失败记录）、`2dd37466`（四类 observer relay 关闭和异常清理）、`402d6e19`／`736ed53a`（下述用户决定）。
- **尚未合入主线**：`migrate/lane-desktop-services` 的 `18e7b900` + `7335bd790368a54cb32c06e6876f6b5703f6039a`，工作树 `/home/hao/projects/pi-agent-migration-worktrees/desktop-services`。
- 认证关闭 lane：`migrate/lane-mcp` 的 `69a8d636` 已被主线整合；原工作树保留。
- 暂停检查时所有现存工作树的 tracked 文件均干净；主线用户自有未跟踪 `plans/*` 不提交。保留 lane 的 node_modules 链接和 target。

## 已明确的用户决定

1. 管理侧可独立使用官方 pi SDK 源码／模块发行版，与打包 CLI **严格同版本**，当前固定 1.4.0；**不用于对话**。对话仍仅 CLI AgentSession。两个运行时各自单一 SDK 图，不跨图传运行时对象；不再要求跨运行时 class identity 相等。各自的根、版本、来源和同图校验保留。没有授权修改／fork SDK或增加第二对话引擎。
2. 内部 PC 工具的用户自行承担非协作外部 CLI／其他实例／程序并发修改相同目录或数据的风险。不要再要求证明所有外部 writer 都停止，也不要因此永久拒绝正常功能。应用仍负责自己管理的任务、协作实例、路径授权和事务保护；自身 Unknown 不能伪报成功。
3. 生产仍启动 Next；尚未批准最终切换／发布、正式 seed/scheduler、恢复／DELETE 激活。边界决定不是实现或验收完成。

## 未合并的管理 SDK 检查点

`7335bd79` 在 `ManagementHost::with_sdk_runtime` 显式选择 Node 管理入口，`PiRpcClient::spawn_program` 不添加对话 CLI 参数。入口验证显式 SDK 根 realpath、包名、SDK及依赖版本，使用 Node `registerHooks` 将管理入口与 projection 的 SDK 导入绑定到同一图。开发依赖根可为 checkout 的真实 node_modules；不是 standalone 证明。

新文件主要为：
- `lib/pi-rpc/assets/management-stdio.mjs`：固定管理 prompt 白名单、帧／输出队列／在途请求上限。重复在途 RPC ID 关闭通道，不再用同 ID 错误误消费原请求。
- `lib/pi-rpc/assets/management-sdk-entry.mjs` 及精确 Node 测试。
- `crates/management-host/src/sdk_runtime_tests.rs`：实际 Rust→Node→管理 SDK 路径。
- 相关改动：`crates/management-host/src/lib.rs`、`crates/pi-host/src/client.rs`、`pi-web-management.mjs`、`lib/pi-sdk-internals.ts` 和 projection 构建脚本的 `--sdk-runtime` 模式。

子代理报告：精确 JS **7 pass / 0 fail / 0 skip**；Rust **1 pass / 0 fail / 0 ignored**，35 filtered、无内部 skip。覆盖 capabilities、modelsConfig.get、session.readHeader、MCP config 和 fake HTTP MCP Test；JS fake stdio MCP可连接，但 Rust broad stdio probe仍被现有 admission 拒绝，不能称完整 MCP 接线。过程中的错误字段断言、直接 probe Unknown 和 broad preflight 拒绝均为真实历史失败，不回算通过。

**尚未实现**：实验 Tauri 静态宿主的配置解析仍选旧管理模式；专用 session-file writer仍走旧 CLI。`ManagementSdkRuntime.cli_version` 仍要求调用方独立验证，不是 runtime自己证明 CLI 身份。未更新唯一 bundle、未做来源完整性／standalone／native 验收。该检查点未被父级接受为完整交付。

## 父级审阅进度与明日顺序

- 已阅读 launcher、入口、stdio修复、SDK internals和projection差异，尚未完成 review。
- 父级额外隔离探针确认：临时全局扩展注册的 `parent-sdk-fixture` 出现在新入口 `auth.providers` 结果中；没有调用登录或生成。
- 同一探针确认：`auth.apiKeyDelete` 类型拒绝返回 `code: credential_type_mismatch`，但新模式把原有可解释错误统一成 `Management operation failed`。需要区分安全的应用自有类型化拒绝与可能含凭据的 SDK 原始错误，复核／修复兼容性；**不要为恢复提示而直接回显所有原始错误**。
- 探针脚本保留：`/home/hao/projects/pi-agent-migration-worktrees/.integration-logs/sdk-extension-probe.mjs`；其临时 HOME已清理。这是父级额外探针，不是上述7项的父级重跑。
- 明日先完成本检查点剩余审阅；交回缺陷时继续剩余审阅，再看修复差异，不另开泛化审核轮次。
- 然后继续已授权的受信宿主配置与显式管理模式接线、专用 writer迁移及必要回归。CLI版本应来自受信分发元信息／独立核验，不接受WebView字符串；不可将根扩大到共同祖先以绕过边界。打包树更新另行裁决。
- SDK 无法提供的真实能力不得伪造；必须保留 writer Unknown、ledger、输入4槽、rid/nonce、MCP credential/probe guards与关闭时限。live title／对话上下文留在原CLI。

## 子代理恢复

最新已完成 run：`696d5336-bbb4-4e10-9e3d-fc074c04083f`（worker，原模型 `lw/gpt-6.1-terra`）。暂停时工具显示 active async 为0，已观察到进程结束；没有启动后续任务，也未观察到在运行的 cargo/rustc。

恢复时用此最新 run ID；`action: resume` 自动继承模型，**不能传 model 覆盖参数**。原会话：
`/home/hao/.pi/agent/sessions/--home-hao-projects-pi-agent-desktop--/2026-10-30T18-28-07-856Z_01a18e11-b630-76d9-8402-e757da2411b0/bfce41b7-17c8-4c15-bc7f-06f1aa71e8bf/run-0/session.jsonl`。

继续基于 lane `7335bd79`，不能 reset 到主线丢失未合并实现。主代理负责最终审阅／整合；无递归委派。

## 测试与资源边界

- 临时 HOME/agentDir，fake provider/credentials，PI_OFFLINE=1；清除 PI_PACKAGE_DIR、PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT、JITI_ALIAS；SDK入口还应清 NODE_OPTIONS/NODE_PATH。
- 用完整测试名与 `--exact`（Node用等效精确匹配），先核对测试列表；禁止再次使用 `real_pi_` 宽过滤。
- 上次误运行的 **12 pass / 19 fail** 及剩余 **18 项未关闭失败**见 `local-cli-failure-record.md`；不得被新SDK局部成功覆盖。
- 禁止 SDK/node_modules/source整树复制、共享依赖安装及 next build。测试源输出 <100MiB。
- Heavy lock：`/home/hao/projects/pi-agent-migration-worktrees/.heavy-build.lock`，非阻塞；jobs2、dev/test debug0、incremental0。隔离HOME时显式CARGO_HOME/RUSTUP_HOME。
- 复用各自已有target且≤8GiB；parent使用resource-ui/target约3.9GiB，desktop-services lane约3.6GiB。不得使用历史main src-tauri/target。
- 唯一standalone bundle在desktop-services/target/m5-static-bundle约428MiB；不得复制或擅自改动；打包／暂存合计预算1GiB。
