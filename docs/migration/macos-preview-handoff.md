# macOS Preview（Apple Silicon）

用户要求：也构建 arm macOS 的 Preview，runner 可用 `macos-15`。产物仅 CI artifact（dmg），不发布 Release／tag／updater，也不切换正式入口。

## 落地

- `.github/workflows/macos-static-preview.yml`：`macos-15`、`aarch64-apple-darwin`，`workflow_dispatch` 或推送 `preview/macos-static` 触发。与 Windows Preview 共用同一 staged 资源树、同一独立管理 SDK、同一 native static host；差异只在打包目标与平台可执行文件名。带有完整压缩的 Cargo/Tauri target 生成字节统计（仅告警，非峰值磁盘）。
- `src-tauri/tauri.preview.macos.conf.json`：只把 `bundle.targets` 覆盖为 `app` + `dmg`。共享的 `tauri.preview.conf.json` 里 `targets: ["nsis"]` 是 Windows 专用；identifier／productName／mainBinaryName／`plugins.updater: null`／`createUpdaterArtifacts: false` 仍由共享覆盖提供，macOS 覆盖不重复声明身份或更新器。
- `scripts/migration/test-macos-preview.sh`：**22 项** `--exact` 门禁——9 项 management ledger/target key（键稳定性、只读 inspect 不建不留、finish 只结自己的记录、坏记录与不安全目录 fail closed、容量上限不丢 pending、revocation 单调、部分结果保持 pending、真实子进程 admission 证据）、4 项 unix host ownership（含子进程与 kill 释放锁）、4 项 bundle 清单校验（含 symlink 拒绝）、3 项原生 Preview 状态（关闭行为、ACL 能力、导航白名单）、2 项 static host（隔离 home + staged runtime 假 key store/delete → 真实 CLI ensure_session）。每项都要求自身 `1 passed; 0 failed; 0 ignored;`，缺失或过滤即失败。脚本导出 `TAURI_CONFIG`，使 `tauri::generate_context!` 在编译期读到 Preview 配置（标识符、capability 选择）。
- `scripts/migration/macos-static-preview.test.mjs`：契约测试——workflow 仅 artifact、禁止 `secrets.`／`next build`／`--no-sign` 等；门禁名单与源文件中的 `fn` 一一对应且不含 Windows 专属项；staged 角色名在 Rust 校验器与 JS stager 之间按平台一致。
- `src-tauri/src/preview_bundle.rs`：角色文件名改为按平台（Windows `node/node.exe` + `pi/pi.exe`，其它平台 `node/node` + `pi/pi`），`managementRuntime` 的 `node`/`cli`、`pi-distribution.json` 的 `binary`、必需文件清单与 `PreviewBundle` 路径全部随之；测试夹具按平台生成，`child_process_path` 简化仍在。
- `src-tauri/src/static_host.rs`：Windows 的 staged runtime 测试主体抽成 `staged_preview_runtime_fixture()`，新增 `preview_staged_macos_runtime_stores_fake_key_and_starts_cli`；Windows 的既有测试名保持不变（Windows 门禁脚本按名锁定）。
- `crates/management-host/src/darwin_storage.rs` + `ledger.rs`/`target_key.rs` 的 `#[cfg(target_os = "macos")]` 实现：Darwin 没有 procfs，Linux 用 `/proc/self/fd/<fd>` 表达「永远相对 pinned 目录」，macOS 改用 `openat`/`mkdirat`/`renameat`/`unlinkat`/`statat`（`rustix`，已经是锁文件里的既有依赖）直接对目录描述符操作；路径只在打开目录时解析一次，之后祖先被 rename 或换成 symlink 都无法把读、建、发布重定向出去。权限/所有权/硬链接校验（`uid`、`mode & 0o077|0o022`、`nlink == 1`）、`O_NOFOLLOW`/`O_EXCL`/`O_NONBLOCK`、临时文件 + `rename` + 目录 `fsync` 与 Linux/Windows 同规则。`ledger_tests` 由 Linux-only 扩到 Linux+macOS。
- `.github/workflows/windows-static-preview.yml` 的契约步骤同时运行 macOS 契约测试，避免两侧约定漂移。

## 边界（未验证的部分）

- 本地（Linux）只证明 Linux 侧不回归：management-host 37 passed（唯一失败项是本机 `pi` 为 1.5.0、测试钉 1.4.0 的既有版本不匹配）、`preview_bundle`(4)、`preview`(3)、`static_host::preview_state_*`(1)、迁移契约 23 passed。macOS 代码只用 `cargo check/test --no-run --target aarch64-apple-darwin` 做了类型检查（本地无 darwin SDK 无法链接），**没有 macOS 执行证据**；22 项门禁与 dmg 构建以实际 Actions 结果为准。
- Darwin ledger 的耐久性边界：`fsync` 在 macOS 不刷盘缓存（需要 `F_FULLFSYNC`），断电仍可能丢掉最新记录；这与 Windows `WRITE_THROUGH` 发布的 caveat 同类，记录为限制，不声称等同 POSIX 目录 fsync。
- dmg 为 ad-hoc 签名（`APPLE_SIGNING_IDENTITY="-"`，`--no-stapling`），不是可分发签名或公证产物；未做真实安装、升级、Gatekeeper、原生窗口、iframe IPC 或用户数据隔离验收。
- Preview 仍拒绝 `terminal.create`、托盘隐藏、调度执行/接管；SDK/CLI 固定 1.4.0，未升级依赖，未改正式 updater／发布路径。
- `macos-15` 链接 macOS SDK 15，AppKit 会沿用旧式交通灯窗口样式；正式 macOS 分发用 SDK 26（见 `mac-build-test.yml`）。此处只是预览构建，不声称与正式外观一致。

## 如何运行

```bash
# 手动触发
gh workflow run macos-static-preview.yml --repo hao3039032/pi-agent-desktop
# 或推送专用分支
git push origin HEAD:preview/macos-static
```

artifact 名：`macos-static-preview-<run number>-<sha>`，内含 `*.dmg`、`SHA256SUMS.txt`、`preview.json`。
