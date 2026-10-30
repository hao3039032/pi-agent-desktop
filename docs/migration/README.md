# 去 Next.js 迁移（静态前端 + Tauri/Rust 应用宿主）

总计划见 `plans/2026-10-31-去-next-js-静态前端-tauri-rust-应用宿主完整迁移计划.md`。本目录存放迁移的落地工件；按里程碑（M0–M5）推进，每个阶段的验证门槛以计划 §八–§九 为准。

## 当前状态（M0 进行中）

| 项 | 状态 | 工件 |
|---|---|---|
| 124 个 HTTP 方法 → IPC 完整映射 | ✅ 完成 | `api-inventory.json` + `scripts/migration/api-inventory-mapping.mjs`（守卫测试 `scripts/migration/api-inventory.test.mjs`：89 文件/124 方法冻结、op 唯一、无遗漏） |
| IPC 协议规范（信封/错误码/流/资源通道） | ✅ 冻结初版 | `ipc-protocol.md` |
| Rust→pi 握手/桥接/退出（最高风险项） | ✅ PoC 验证通过 | `crates/pi-host`：20 个确定性协议测试 + 3 个真实 pi 集成测试（`PI_CLI_BIN` 门控，隔离 `PI_CODING_AGENT_DIR` 沙箱） |
| 管理依赖加载（实际打包布局） | ⬜ 未开始 | 需要 `desktop:prepare` 产物布局验证；验证不通过则不进入正式切换（计划 §五） |
| 扩展 provider 枚举 / MCP transport 实例一致性 | ⬜ 未开始 | 依赖上一项 |
| 模拟 OAuth 取消/回调 | ⬜ 未开始 | |
| PTY（portable-pty） | ⬜ 未开始 | M4 主项，M0 仅需可行性确认 |
| 无权限资源预览（自定义资源协议） | ⬜ 未开始 | |

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
