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
- requestId 由前端单调生成；宿主按 id 关联响应。**超时不意味着操作没发生**：prompt、安装、文件写入等不得自动重发；通过 requestId + 状态查询（`sessions.runState`、`tasks.runs` 等）确定结果。
- 版本不匹配 → `version_mismatch` 错误，携带宿主支持的版本区间。桌面产品前后端同包发布，正常情况下版本恒等；该检查防御的是更新中断、旧 WebView 缓存等边角。
- 参数在双端 schema 校验失败 → `invalid_args`，`details` 指出字段。前端不得发送未校验的用户输入。

## 2. 错误码（初始集，按需扩充；`retryable` 仅是提示）

| code | 场景 | retryable |
|---|---|---|
| `unknown_op` | 封闭枚举外的操作 | false |
| `version_mismatch` | 协议版本不符 | false |
| `invalid_args` | 参数校验失败 | false |
| `unauthorized_scope` | 路径/资源超出授权范围（文件、终端、聊天文件夹） | false |
| `not_found` | 会话/任务/条目不存在 | false |
| `busy` | 目标被独占（如安装进行中） | true |
| `timeout` | 宿主等待下游（pi 子进程、git）超时；**副作用可能已发生** | 视操作 |
| `agent_child_exited` | 会话子进程退出（对齐 `pi-host` 的 `ErrorKind::Exit`） | false |
| `agent_child_timeout` | 子进程命令超时但子进程仍在（`ErrorKind::Timeout`） | false |
| `bridge_op` | bridge 操作被子进程拒绝（携带 `details.code`） | false |
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
- 取消：前端 drop 订阅、页面刷新（WebView 重载）、窗口销毁均释放订阅；宿主侧以 `subscriptionId` 注销，无泄漏。
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
