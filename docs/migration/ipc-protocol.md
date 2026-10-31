# IPC 协议规范（M0 冻结版）

去 Next.js 迁移的静态前端 ↔ Rust 宿主之间唯一的通信契约。本文件由计划 §四（前端与 IPC 契约）细化而来；`docs/migration/api-inventory.json` 是 124 个既有 HTTP 方法到 IPC 操作的完整映射清单。实现入口：前端唯一底层接线在 `lib/desktop-native.ts`；Rust 侧为封闭操作枚举（M2 起逐步落地，见 `crates/pi-host`）。

## 1. 请求/响应信封

一次请求携带协议版本、requestId、具名操作及校验后的参数：

```jsonc
// 请求（WebView → Rust）
{
  "v": 1,                       // 协议版本（整数，当前 1）
  "id": "req-7f3a…",            // 客户端生成，单调递增，一次性使用
  "op": "agent.command",        // 具名操作，封闭枚举（见 api-inventory.json）
  "args": { … }                 // 每操作的 schema（TypeScript 类型 + Rust serde 双端校验）
}

// 成功
{ "v": 1, "id": "req-7f3a…", "ok": true, "data": { … } }

// 失败
{
  "v": 1, "id": "req-7f3a…", "ok": false,
  "error": {
    "code": "agent_child_exited",   // 稳定机器码（下节枚举）
    "message": "…",                 // 可诊断文本（英文；UI 不解析）
    "reason": "session_closed",     // 保留现有业务 reason / i18n key（可选）
    "retryable": false,
    "details": { … }                // 可选结构化补充
  }
}
```

规则：

- **未知操作直接拒绝**（`unknown_op`），不提供“任意 shell”“任意 URL”“任意 SDK 函数名”式通用执行接口。操作枚举在 Rust 侧是穷举 match，新增操作必须同时改清单。
- **文件授权只由宿主侧事实派生**：会话扫描得到的 cwd/项目根、对话框选择、验证过的 cwd。**不存在前端可调用的 `files.allowRoot`**——WebView 不能自我扩权；`resources.grantFile` 只接受宿主自己提出过的路径。写入授权走解析后的父目录包含检查（symlink 逃逸拒绝，见 `src-tauri/src/file_access.rs`）。
- requestId 由前端单调生成；宿主按 id 关联响应。**超时不意味着操作没发生**：prompt、安装、文件写入等不得自动重发；通过 requestId + 状态查询（`sessions.runState`、`tasks.runs` 等）确定结果。
- 版本不匹配 → `version_mismatch` 错误，携带宿主支持的版本区间。桌面产品前后端同包发布，正常情况下版本恒等；该检查防御的是更新中断、旧 WebView 缓存等边角。
- 参数在双端 schema 校验失败 → `invalid_args`，`details` 指出字段。前端不得发送未校验的用户输入。

## 2. 错误码（初始集，按需扩充；`retryable` 仅是提示）

| code | 场景 | retryable |
|---|---|---|
| `unknown_op` | 封闭枚举外的操作 | false |
| `version_mismatch` | 协议版本不符 | false |
| `invalid_args` | 参数校验失败 | false |
| `unauthorized_scope` / `access_denied` | 路径/资源超出授权范围或需要可信桌面 | false |
| `outcome_unknown` | 副作用结果不确定；禁止自动重试，持久栅栏保留 | false |
| `partial_success` | 副作用已确定但恢复或清理失败；禁止重复执行 | false |
| `not_found` | 会话/任务/条目/订阅不存在 | false |
| `no_host` | 前端无宿主桥（浏览器直开静态页） | false |
| `busy` | 目标被独占（如安装进行中） | true |
| `timeout` | 宿主等待下游（pi 子进程、git）超时；**副作用可能已发生** | 视操作 |
| `not_supported` | 命令存在但宿主侧语义尚未迁移（如 `fork`、`get_tools` 的主机层逻辑） | false |
| `agent_child_exited` | 会话子进程退出（对齐 `pi-host` 的 `ErrorKind::Exit`） | false |
| `agent_child_timeout` | 子进程命令超时但子进程仍在（`ErrorKind::Timeout`） | false |
| `agent_child_error` | 子进程拒绝命令（`ErrorKind::Command`） | false |
| `agent_spawn_failed` | 会话子进程启动失败（冷启动恢复路径） | false |
| `agent_handshake_failed` | 会话握手失败（身份不一致/bridge 未注册） | false |
| `management_unavailable` | 管理实例不可用/正在回收 | true |
| `io` | 文件系统/进程 IO 失败 | 视操作 |

现有业务的 reason/i18n key（如 MCP 掩码、信任对话框的具体拒绝理由）放进 `error.reason`/`details`，UI 不再解释 HTTP 状态码。

## 3. 流（Tauri Channel）

- 每个订阅一条 Channel：`agent.subscribeEvents`、`agent.subscribeRunning`、`terminal.subscribeOutput`、`tasks.subscribeEvents` 等。
- 消息统一形状：

```jsonc
{
  "subscriptionId": "sub-…",     // 订阅建立时分配
  "epoch": 12,                    // 宿主纪元：宿主重启/重置后递增
  "seq": 4815,                    // 单调序列（每订阅独立，从 1 开始）
  "kind": "snapshot" | "event" | "reset",
  "payload": { … }
}
```

- **订阅建立时原子交付快照与后续事件**：`kind:"snapshot"` 先到，之后 `kind:"event"` 顺序追加。快照与事件之间不允许丢失或重排。
- `kind:"reset"`：有界队列超限或纪元变化时发出；前端收到后必须丢弃本地状态、用新 requestId 重新取快照（不重放业务操作）。
- **`agent.subscribeRunning` 的有界重放语义（Terra P2-1）**：运行集的每次转换（start/settle/子进程退出/移除）记录在宿主内有界环（512 条，`RunningSignal`）。若一条帧的发送被阻塞期间发生了 start+settle，relay 放行后按转换顺序重放中间集合（相邻相同集合合并、每帧之间重查停止标志）——短 run 不会被“最终集合未变”吞掉。环溢出（超过 512 条未消费转换）不重放中间态，而是强制发送一帧当前全量观察（resync）；客户端以整集替换语义消费帧，即完成恢复。帧载荷不变（`{type:"running", runningSessionIds, sessionListVersion}`）。重放游标是独立的密集转换序号（仅 wake 的版本 bump 不消耗它，也不会伪造 gap）。
- **取消契约（`agent.unsubscribeEvents`，Terra P2-2）**：宿主置停标志并**唤醒**等待中的 relay 线程（不等待 30 s 探测）：静默取消后线程即刻结束、注册项回收。取消时刻之后最多再投递**一帧**（已在发送中的在途帧；多帧重放在每帧之间重查停止标志）。客户端收到取消 ACK 后不得假设存在后续帧，也不得依赖“取消后无帧”做同步。
- 取消：前端 drop 订阅、页面刷新（WebView 重载）、窗口销毁均释放订阅；宿主侧以 `subscriptionId` 注销（`agent.unsubscribeEvents`），无泄漏。
- `agent.subscribeEvents` 的第一帧 `kind:"snapshot"` 的 payload 是宿主快照 `{epoch, settledEpoch, state}`，**不是 AgentEvent**；前端适配层把它翻译成连接层等待的 `connected` AgentEvent（`lib/agent-event-stream.ts` 的首个 data 事件语义），后续 `kind:"event"` 帧的 payload 才是真实事件记录。
- 消费确认与有界队列：工具中间输出可合并（coalesce）；最终消息、错误、UI 确认（extension dialog 请求/回复）不可静默丢弃。隐藏窗口不订阅时，宿主只为仍在运行的对象保留状态，不为无人消费的流无限堆积。
- 会话事件内容沿用 pi RPC 事件记录（`agent_start`、`message_*`、`agent_settled`、`extension_ui_request`…），包一层 envelope；扩展 UI 请求经 `agent.respondUi` 回传，语义与 `crates/pi-host` 的 UI 子协议一致（到达序重放、超时/溢出取消而非同意）。

## 4. 二进制与资源通道

- 附件读取、图片、文件内容等二进制数据走 raw IPC / 分块传输（Tauri 的字节通道），不 base64 进 JSON。
- 媒体与无脚本文件预览走独立自定义资源协议（随机句柄、限定文件/目录范围、请求时重校验、MIME/Range 支持、句柄过期与撤销）；该协议无任何 IPC capability（见计划 §六）。
- 原生文件导入直接磁盘复制，无本地字节上限（沿用现有行为）。

## 5. 明确禁止的实现方式

- **不全局 monkey-patch `fetch`/`EventSource`** 伪装旧服务器；逐领域替换调用点（`lib/agent-client.ts` 等）到类型化 IPC。
- 图片、下载链接、stylesheet、iframe `src` 等非 fetch 的 `/api` 地址必须一并迁移（资源协议或内联）。
- 生产前端不得出现本地 `/api/*`、`EventSource`、Next 路由/图片优化请求（发布验收项）。
- 前端不得自行拼装 shell 命令或直接触达 SDK；一切经封闭操作枚举。

## 6. 与 pi-host 子进程协议的边界

`crates/pi-host` 管的是宿主 ↔ pi CLI 的 JSONL RPC（LF 帧、id 关联、UI 子协议、bridge 信封）；本文件管的是 WebView ↔ 宿主的 IPC。两层各自版本化；会话事件从子进程记录映射为 envelope 事件时保持字段名兼容（`hooks/useAgentSession.ts` 的消费逻辑在 M2 迁移时以此为准）。
