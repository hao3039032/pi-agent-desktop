# Distro：本 fork 的发行层

本仓库是 [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) 的 fork，目标是让目标用户**装一个安装包就能用**：不需要 Node.js、npm、git，不需要跑任何脚本。所有 fork 改动集中在新文件里，对上游文件的修改只有十几行调用，方便合并上游。

## 用户得到什么

- 5 个扩展包（pi-mcp-adapter、pi-subagents、pi-plan-mode fork 版、pi-web-access、pi-model-images）已预装，首次启动自动接入；
- 首次启动弹窗填写服务地址（Base URL）和 API Key，之后在 设置 → 通用 → 服务配置 修改。地址变更只改一处，`models.json` 和 `web-search.json` 同步更新；
- Windows 自带 Git Bash（pi 的 bash 工具和 `git:` 扩展包需要）；
- 应用内安装/升级插件不再需要系统 npm。

## 布局

| 路径 | 作用 |
|---|---|
| `distro/distro.json` | 唯一配置入口：provider（LW）的模型表、扩展包列表、默认值、web-search 默认值、`pi-plan-mode.json` 等随包文件、`app`（改名、更新指向）、`revision`（发行修订号） |
| `scripts/distro-seed.mjs` | 构建时把扩展包装进 `src-tauri/resources/pi-seed/`，并写 `manifest.json`（含 `seedVersion`）和 `bin/npm` shim。git 包去掉 peer 依赖和 `.map`/`.d.ts` 以减小体积 |
| `scripts/distro-portable-git.mjs` | Windows 构建时下载 PortableGit（版本和 sha256 写死在脚本里），解压、裁剪文档/翻译后放进 `resources/git/`。`post-install.bat` 保留，由运行时执行 |
| `scripts/distro-build-config.mjs` | 发版时生成 `tauri.distro.conf.json`（改名、identifier、updater 指向本仓库、附加 resources），并把版本号写成 上游X.Y.Z×100+revision |
| `lib/distro/` | 运行时：PATH 注入（npm shim、Git Bash）、首次启动种子（packages 重写、默认值、`pi-plan-mode.json`）、服务配置读写 |
| `components/distro/` | 首次启动弹窗 + 设置里的服务配置表单 |
| `app/api/distro/` | `GET/PUT /api/distro`：服务配置状态与保存（不回传 key） |
| `.github/workflows/distro-release.yml` | 发版：三平台构建、签名、上传（fork 自有，上游的 release.yml 未动） |
| `.github/workflows/distro-sync.yml` | 每日检查上游 release，合并→跑检查→推送→触发发版 |

构建产物 `resources/pi-seed/`、`resources/git/`、`tauri.distro.conf.json` 均在 `.gitignore` 中，不进仓库。

## 运行时行为细节

- **种子**：服务启动时（`instrumentation-node.ts` → `initDistro()`）检测 `resources/pi-seed/manifest.json`，把用户 `settings.json` 的 packages 指向包内副本。匹配规则见 `lib/distro/packages.ts`：npm/git 源忽略版本号，本地路径按 `/pi-seed/<相对路径>` 识别（换安装目录也能跟上）；用户手动删掉的包不会自动加回来（记录在 `~/.pi/agent/desktop-distro.json`）。
- **升级**：`seedVersion` 变化时会用 distro.json 里的模型表刷新 LW provider 的模型列表（不动用户的 baseUrl/apiKey），并重写包路径。
- **PATH**：npm shim（`pi-seed/bin`）只有在系统没有 npm 时才追加；Git Bash（`resources/git/bin`）在 Windows 上且系统没有 Git for Windows 时前置。
- **PortableGit**：`post-install.bat` 在用户机器上首次启动时静默执行一次（脚本自删）。
- **安全**：`models.json`、`web-search.json`、`desktop-distro.json` 以 `0600` 权限原子写入；`/api/distro` 的 GET 不返回 key。

## 发版流程

1. 改动 distro 层（模型表、扩展包列表、PortableGit 版本等）后：把 `distro/distro.json` 的 `revision` +1；
2. 手动触发 `distro-release.yml`，或等 `distro-sync.yml` 在上游发新 release 后自动触发；
3. 三平台构建全部成功后 draft 自动转正；部分失败保持 draft，会在 job summary 里报警，不要手工发布。

## 一次性设置

- Secrets（Settings → Secrets and variables → Actions）：
  - `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` / `TAURI_UPDATER_PUBLIC_KEY`：`npm exec tauri signer generate` 生成，公钥由 workflow 注入；
  - `DISTRO_SYNC_TOKEN`：fine-grained token（仅本仓库，Contents + Workflows 读写）。上游每次发版都改 workflow 文件，`GITHUB_TOKEN` 推不上去。缺它时 sync 会报错退出，手动发版不受影响。
- `pi-agent-desktop-package.json` 提交的是上游版本号；distro 版本号只在 CI 检出里改写，避免合并冲突。

## 已知限制

- macOS 未做签名/公证（与上游相同），首次打开需要 系统设置 → 隐私与安全性 → 仍要打开；
- Windows 未做 Authenticode 签名，SmartScreen 可能提示一次「更多信息 → 仍要运行」；
- 上游的 `release.yml`、`component-updates.yml` 仍在仓库里但不会自动跑；合并上游时若它们改动了 `tauri.conf.json` 的 resources 列表，`distro-build-config.mjs` 会读取最新列表再附加 distro 资源。
