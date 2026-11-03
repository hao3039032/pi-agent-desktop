# Windows Preview 今日收尾交接

## 停止约定

用户要求：本次提交并触发下一次打包后结束今日工作。本提交是今日最后一次构建尝试；若 CI 仍失败，留待下次，不追加修复或重新触发。没有本机后台构建或需要继续运行的子代理；远端 Actions 可继续运行。

> 2026-11-03 续：用户次日要求继续处理该失败，因此上述“不追加修复”约定只对 2026-11-02 生效。续做结果见文末。

## 提交范围与已知结果

- 原生 Preview 至 `ad76f0d4` 和 Windows management storage 至 `43feff98` 已整合；正式入口仍是 Next。
- 第一次 CI [41506970519](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41506970519)：latest CLI 已变成 1.5.0，staging 的 1.4.0 检查正确拒绝。Node contracts 15 通过，Rust/NSIS 未运行。
- `5d722365` 明确从官方 v1.4.0 release 下载 CLI 和 SHA256SUMS，未升级 SDK、未放宽版本校验。
- 第二次 CI [41507814085](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41507814085)：版本阻断消除，但生成管理入口的 Windows 路径被 JS 字符串转义，esbuild 报 42 个解析失败。Node contracts 15 通过，Rust/NSIS 仍未运行。
- 本次修复 projection/title 入口的路径字符串编码，未改变 SDK external 边界，源码模块仍须实际打包。新增测试使用 esbuild 解析 Windows drive/UNC 与特殊字符路径；真实 projection/title 在内存构建，无 SDK closure 复制。相关本地测试 **9 passed / 0 failed / 0 skipped**；无 Windows 执行证明。
- 本提交推送 `preview/windows-static` 后自动触发新的 Windows 构建。提交前还没有本轮运行结果，不能记作成功或声称已有安装包。

## 下次从这里继续

1. 查询本提交的 Actions，不重跑前两次失败提交：
   ```bash
   gh run list --repo hao3039032/pi-agent-desktop --branch preview/windows-static --limit 5 \
     --json databaseId,url,headSha,status,conclusion
   ```
   必须显式写 `--repo`，避免 gh 默认选择直接上游。
2. 若失败，先读取最后一次运行的失败日志，只修第一个实际阻断。若成功，核验精确 Windows Rust 门禁实际执行及 NSIS artifact，再向用户提供真实 artifact 链接。
3. 构建/单元测试不等于真实原生窗口、iframe IPC 边界、安装/升级或用户数据隔离验收。禁止改用 Next/harness 冒充 Preview。

## 保持的边界

- 独立 identifier/product/executable/data；不自动读取生产 `~/.pi/agent`，不启用正式 updater、调度、DELETE 或恢复权限。
- SDK/CLI 保持 1.4.0；管理 SDK 与对话 CLI 分离，对话仍仅使用 CLI。
- Windows ledger 的同卷 rename 不声称等同 POSIX 目录 fsync；断电耐久性、强杀重启及完整原生验收仍开放。
- Preview 暂不支持终端创建、托盘隐藏、调度执行/接管，明确拒绝，不算功能完成。18 项历史 real-CLI 失败仍未关闭。
- 不升级依赖、不在本机安装 Windows 工具链、不复制 SDK/依赖树、不动唯一旧 bundle。继续遵守工作树、heavy lock 和空间限制。
- 用户未跟踪的 `plans/*` 保持不动。完整当前状态及历史失败见 [status.md](status.md)。

## 2026-11-03 续：失败已解除，门禁全绿

四个提交，每次只修当前第一个实际阻断，四轮 Actions 依次推进：

| 运行 | 结论 | 首个阻断 |
|---|---|---|
| [41599368815](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41599368815) | 失败 | `files_list_marks_a_directory_symlink_pointing_outside` 用 `std::os::unix::fs::symlink` 却未 cfg 限定，Windows 上整库 lib test 编译报 `E0433`，`cargo test --list` 直接失败（`d407c31c` 加 `#[cfg(unix)]`） |
| [41601074109](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41601074109) | 失败 | 门禁首次真正执行：`preview_staged_windows_runtime_stores_fake_key_and_starts_cli` 在首个 `sys.capabilities` 就报 `management prompt failed: pi process exited unexpectedly (1)`，无 stderr（`d2ec87e7` 让管理实例保留子进程 stderr 并附在失败信息后） |
| [41602556636](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41602556636) | 失败 | 诊断给出根因：`EISDIR: illegal operation on a directory, lstat 'D:'`，`child command: \\?\D:\…\node.exe \\?\D:\…\management-sdk-entry.mjs`（`0c1dddb4` 补全 40 行 banner 与实际命令行） |
| [41602849795](https://github.com/hao3039032/pi-agent-desktop/actions/runs/41602849795) | **成功** | — |

根因：`preview_bundle::verify` 先 `canonicalize()`，而 Rust 在 Windows 返回 verbatim `\\?\D:\…` 形式；Node 的主入口解析（`realpathSync` → `lstat`）不做 verbatim 处理，把 argv[1] 归约成裸盘符 `D:`。`lib.rs` 的 `child_process_compatible_path` 早已为桌面 server 记录过同一坑。`0dc971c2` 用 `dunce::simplified` 统一简化所有跨进程路径（argv 与环境），并新增同源回归 `preview_bundle_simplifies_windows_runtime_paths`。

成功运行的实际证据：

- 精确门禁 **22 项**（11 项 Windows ledger storage + 11 项 ownership/manifest/ACL/Preview/staged runtime），每项 `--exact` 且 `1 passed; 0 failed; 0 ignored`，无过滤通过。
- 版本 `0.0.7-preview.g0dc971c2b278`，NSIS 安装包构建成功，artifact `windows-static-preview-7-0dc971c2b278`（75,963,461 字节，含 `SHA256SUMS.txt` 与 `preview.json`）。
- 生成字节统计（非峰值磁盘）：staging 354,670,215 + Cargo/Tauri target 5,316,888,267 + Vite 7,537,186 + pi 下载 118,674,315 = 5,797,769,983，按既有约定仅告警并上报父级。

边界未变：这是测试 artifact，不是正式 Release／updater／tag；未做真实安装、升级、原生窗口、iframe IPC 与用户数据隔离验收；Preview 仍拒绝终端创建、托盘隐藏、调度执行/接管；SDK/CLI 仍固定 1.4.0，未升级依赖；18 项历史 real-CLI 失败仍未关闭。
