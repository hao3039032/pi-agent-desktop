# macOS Preview（Apple Silicon）

用户要求：也构建 arm macOS 的 Preview，runner 可用 `macos-15`。产物仅 CI artifact（dmg），不发布 Release／tag／updater，也不切换正式入口。

## 落地

- `.github/workflows/macos-static-preview.yml`：`macos-15`、`aarch64-apple-darwin`，`workflow_dispatch` 或推送 `preview/macos-static` 触发。与 Windows Preview 共用同一 staged 资源树、同一独立管理 SDK、同一 native static host；差异只在打包目标与平台可执行文件名。带有完整压缩的 Cargo/Tauri target 生成字节统计（仅告警，非峰值磁盘）。
- `src-tauri/tauri.preview.macos.conf.json`：只把 `bundle.targets` 覆盖为 `app` + `dmg`。共享的 `tauri.preview.conf.json` 里 `targets: ["nsis"]` 是 Windows 专用；identifier／productName／mainBinaryName／`plugins.updater: null`／`createUpdaterArtifacts: false` 仍由共享覆盖提供，macOS 覆盖不重复声明身份或更新器。
- `scripts/migration/test-macos-preview.sh`：13 项 `--exact` 门禁——4 项 unix host ownership（含子进程与 kill 释放锁）、4 项 bundle 清单校验（含 symlink 拒绝）、3 项原生 Preview 状态（关闭行为、ACL 能力、导航白名单）、2 项 static host（隔离 home + staged runtime 假 key store/delete → 真实 CLI ensure_session）。每项都要求自身 `1 passed; 0 failed; 0 ignored;`，缺失或过滤即失败。脚本导出 `TAURI_CONFIG`，使 `tauri::generate_context!` 在编译期读到 Preview 配置（标识符、capability 选择）。
- `scripts/migration/macos-static-preview.test.mjs`：契约测试——workflow 仅 artifact、禁止 `secrets.`／`next build`／`--no-sign` 等；门禁名单与源文件中的 `fn` 一一对应且不含 Windows 专属项；staged 角色名在 Rust 校验器与 JS stager 之间按平台一致。
- `src-tauri/src/preview_bundle.rs`：角色文件名改为按平台（Windows `node/node.exe` + `pi/pi.exe`，其它平台 `node/node` + `pi/pi`），`managementRuntime` 的 `node`/`cli`、`pi-distribution.json` 的 `binary`、必需文件清单与 `PreviewBundle` 路径全部随之；测试夹具按平台生成，`child_process_path` 简化仍在。
- `src-tauri/src/static_host.rs`：Windows 的 staged runtime 测试主体抽成 `staged_preview_runtime_fixture()`，新增 `preview_staged_macos_runtime_stores_fake_key_and_starts_cli`；Windows 的既有测试名保持不变（Windows 门禁脚本按名锁定）。
- `.github/workflows/windows-static-preview.yml` 的契约步骤同时运行 macOS 契约测试，避免两侧约定漂移。

## 边界（未验证的部分）

- 本轮只有 Linux 侧证据：`preview_bundle`(4)、`preview`(3)、`static_host::preview_state_*`(1) 本地通过，5 个迁移契约文件 22 passed；macOS 的编译、13 项门禁与 dmg 构建以实际 Actions 结果为准，未运行前不得当作已通过。
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
