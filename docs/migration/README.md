# 去 Next.js 迁移（静态前端 + Tauri/Rust 应用宿主）

总计划见 `plans/2026-10-31-去-next-js-静态前端-tauri-rust-应用宿主完整迁移计划.md`。本目录存放迁移的落地工件；按里程碑（M0–M5）推进，每个阶段的验证门槛以计划 §八–§九 为准。

## 当前状态（M0 进行中）

| 项 | 状态 | 工件 |
|---|---|---|
| 124 个 HTTP 方法 → IPC 完整映射 | ✅ 完成 | `api-inventory.json` + `scripts/migration/api-inventory-mapping.mjs`（守卫测试 `scripts/migration/api-inventory.test.mjs`：89 文件/124 方法冻结、op 唯一、无遗漏） |
| IPC 协议规范（信封/错误码/流/资源通道） | ✅ 冻结初版 | `ipc-protocol.md` |
| Rust→pi 握手/桥接/退出（最高风险项） | ✅ PoC 验证通过 | `crates/pi-host`：20 个确定性协议测试 + 3 个真实 pi 集成测试（`PI_CLI_BIN` 门控，隔离 `PI_CODING_AGENT_DIR` 沙箱） |
| 管理依赖加载（隔离固定版本模块树，绝对路径导入） | ✅ 机制验证通过（本机 pi 1.4.0 托管安装 = release 目录布局，linux-x64） | `scripts/migration/management-deps-loading.test.mjs`：vendored croner 10.x 在子进程内解析、执行、回报 URL；空 NODE_PATH + 临时 cwd。已随 `PI_CLI_BIN=… npm test` 全量回归（3629/3629，0 跳过）。⚠️ 其余三个发行目标的打包布局（desktop:prepare 产物）验证仍待做 |
| 扩展 provider 枚举 | ✅ 验证通过 | `crates/pi-host/tests/real_pi.rs::real_pi_management_instance_enumerates_extension_providers`：管理形态 child（`--mode rpc --no-session`）加载 pi.registerProvider fixture 后，标准 `get_available_models` RPC 枚举出该 provider 的模型；`--no-session` 不写会话文件 |
| 模拟 OAuth 取消/回调 | ✅ 验证通过 | `crates/oauth-loopback`：OS 随机端口的 127.0.0.1 监听、唯一 `/callback` 端点（路径外的都 404）、state 不匹配绝不是成功、PKCE S256 挑战独立复算一致（verifier 只留宿主侧）、完成/取消后监听关闭、百分号解码。7 测试 + 1 显式忽略的超时长路径 |
| PTY（portable-pty） | ✅ 可行性验证通过 | `crates/pty-host`：幂等创建（同 id 返回同一实例）、输入/resize 串行、128 Ki UTF-16 历史窗口 + 游标后缀读 + 过旧游标 reset/有界重放、退出码传播（exit 7 实测）、Unicode 分块、关闭后输入显式失败。120 秒租约与 Tauri 接线是 M4 |
| 无权限资源预览（自定义资源协议） | ✅ 逻辑层验证通过 | `crates/resource-protocol`：随机 128 位句柄、单文件/目录授权、请求时重校验（canonical 一致 + 目录包含检查拒绝穿越/绝对路径/反斜杠/树内逃逸 symlink）、授权绑定解析后的目标（symlink 重定向不动授权；锚点被换成 symlink 则拒绝）、MIME/Range、过期与撤销。Tauri 协议注册是 M3 |

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
