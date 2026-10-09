# Distro：本 fork 的发行层

本仓库是 [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) 的 fork，目标是让目标用户**装一个安装包就能用**：不需要 Node.js、npm、git，不需要跑任何脚本。所有 fork 改动集中在新文件里，对上游文件的修改只有十几行调用，方便合并上游。

## 用户得到什么

- 5 个扩展包（pi-subagents、pi-web-access、pi-model-images、pi-omp-advisor、pi-plan-vanguard）已预装，首次启动自动接入；子代理默认运行时限 60 分钟（pi-subagents 内置 30 分钟，通过 `extensions/subagent/config.json` 的 `timeoutMs: 3600000` 覆盖，并在截止前 5 分钟启用收尾检查点）；Code mode 默认常开（一次性种入 `+codemode` 到全局 `defaultTools`，仅当用户没有自己的选择；分类器/图像模型只能从 codemode 脚本调到）；MCP 不再走 pi-mcp-adapter，改用 pi 官方内置 MCP（设置 → MCP 管理 `~/.pi/agent/mcp.json`），老安装升级时自动迁移（见下）；
- pi-omp-advisor 的模型与设置沿用开发机：WATCHDOG.yml（首次种入，`main: false`，按需 `/advisor on`），advisor 模型 `lw/gemini-3.8-flash`（已加入 provider 模型表）；
- 首次启动弹窗填写服务地址（Base URL）和 API Key，之后在 设置 → 通用 → 服务配置 修改。地址变更只改一处，`models.json` 和 `web-search.json` 同步更新；弹窗里的「使用国内 npm 镜像」勾选把 `registry.npmmirror.com` 写进 `settings.json` 的 `npmCommand`（插件安装走它），并镜像到进程环境 `npm_config_registry`（`npx skills add` 继承），服务启动时从 settings 恢复，用户自己设过的环境变量优先；
- Windows 自带 Git Bash（pi 的 bash 工具和 `git:` 扩展包需要）；
- 应用内安装/升级插件不再需要系统 npm。

## 布局

| 路径 | 作用 |
|---|---|
| `distro/distro.json` | 唯一配置入口：provider（LW）的模型表、扩展包列表、默认值、web-search 默认值、`pi-plan-vanguard.json` 等随包 JSON（`agentFiles`）、`WATCHDOG.yml` 等文本文件（`agentTextFiles`）、`app`（改名、更新指向）、`revision`（发行修订号） |
| `scripts/distro-seed.mjs` | 构建时把扩展包装进 `src-tauri/resources/pi-seed/`，并写 `manifest.json`（含 `seedVersion`）和 `bin/npm` shim。git 包去掉 peer 依赖和 `.map`/`.d.ts` 以减小体积 |
| `scripts/distro-portable-git.mjs` | Windows 构建时下载 PortableGit（版本和 sha256 写死在脚本里），解压、裁剪文档/翻译后放进 `resources/git/`。`post-install.bat` 保留，由运行时执行 |
| `scripts/distro-build-config.mjs` | 发版时生成 `tauri.distro.conf.json`（改名、identifier、updater 指向本仓库、附加 resources），并把版本号写成 上游X.Y.Z×100+revision |
| `scripts/distro-reset-revision.mjs` | 合并上游后若版本变化，把 `distro.json` 的 `revision` 重置为 1（revision 按上游版本分别计数，`distro-sync.yml` 自动执行，也并入 merge commit） |
| `lib/distro/` | 运行时：PATH 注入（npm shim、Git Bash）、首次启动种子（packages 重写、默认值、`pi-plan-vanguard.json`、`WATCHDOG.yml`）、服务配置读写、pi-mcp-adapter → 官方 MCP 的一次性迁移（`mcp-migration.ts`） |
| `components/distro/` | 首次启动弹窗 + 设置里的服务配置表单 |
| `app/api/distro/` | `GET/PUT /api/distro`：服务配置状态与保存（不回传 key） |
| `.github/workflows/distro-release.yml` | 发版：三平台构建、签名、上传（fork 自有，上游的 release.yml 未动） |
| `.github/workflows/distro-sync.yml` | 每日检查上游 release，合并→跑检查→推送→触发发版 |

构建产物 `resources/pi-seed/`、`resources/git/`、`tauri.distro.conf.json` 均在 `.gitignore` 中，不进仓库。

## 运行时行为细节

- **种子**：服务启动时（`instrumentation-node.ts` → `initDistro()`）检测 `resources/pi-seed/manifest.json`，把用户 `settings.json` 的 packages 指向包内副本。匹配规则见 `lib/distro/packages.ts`：npm/git 源忽略版本号，本地路径按 `/pi-seed/<相对路径>` 识别（换安装目录也能跟上）；用户手动删掉的包不会自动加回来（记录在 `~/.pi/agent/desktop-distro.json`）；**从发行包里移除的包**会把指向包内副本的条目剪掉（不留悬空路径），且不当作「用户删过」记仇，将来重新捆绑时会重新种入。`agentFiles` 只在目标文件不存在时写入；`legacyAgentFiles` 列出的旧文件（如 `pi-plan-mode.json`）已存在时跳过种入，由 pi-plan-vanguard 自己读取并在下次保存时迁移，避免遮蔽用户配置。imagegen 的配置 `pi-model-images.json` 同样只在缺失时从已配置的服务地址（`+ /v1`）和 key 种入，已存在的不动，后续地址变更由服务表单同步。
- **一次性迁移（Code mode 常开，revision 9）**：`settings.json` 没有 `defaultTools` 键时种入 `["+codemode"]`（`lib/distro/seed.ts`，记录在 `migrations.defaultTools`，在 SettingsManager flush 之后写入，避免内存快照覆盖）。用户自己选过工具列表（键存在）则完全不动；之后在 GUI 里切回「automatic」会删键，迁移不重跑，不会覆盖用户选择。
- **升级**：`seedVersion` 变化时会用 distro.json 里的模型表刷新 LW provider 的模型列表（不动用户的 baseUrl/apiKey；模型条目里指向默认服务地址的绝对 baseUrl 会改写成用户配置的地址，如 `…/v1beta`），并重写包路径。
- **一次性迁移（pi-mcp-adapter → 官方 MCP）**：`lib/distro/mcp-migration.ts`，每个 agent 目录至多跑一次（记录在 `desktop-distro.json` 的 `migrations.mcpAdapter`）：
  1. 删除 `packages` 里手写形式的 pi-mcp-adapter 条目（`npm:pi-mcp-adapter` / 带版本号；包内路径形式由种子剪除逻辑处理）；
  2. 移除 `extensions` 里的 `-builtin:mcp`（adapter 首次启动写入的内置 MCP 关闭标记），恢复官方 MCP；
  3. 把只有 adapter 会读的服务器定义合并进 `~/.pi/agent/mcp.json`（已有同名条目优先，不删任何东西）：`~/.pi/agent/mcp-adapter.json`、`~/.config/mcp/mcp.json`、`~/.agents/mcp.json`、`~/.agents/mcp/mcp.json`。字段转换：`disabled` → `enabled:false`、`requestTimeoutMs`（毫秒）→ `timeout`（秒）、`directTools:true`/`"search"`/名单 → `exposure:"direct"`/`"deferred"`/`toolExposure`、`excludeTools` → `toolExposure{hidden}`、`oauth.redirectUri` → `oauth.callbackUrl`；`type:"sse"` 条目跳过；adapter 专属调优（lifecycle、approveTools、scriptMode 等）无对应项丢弃。OAuth 登录态存在系统钥匙串里迁不走，涉及的服务器需要重新 `/mcp login <server>` 一次。
- **PATH**：npm shim（`pi-seed/bin`）只有在系统没有 npm 时才追加；Git Bash（`resources/git/bin`）在 Windows 上且系统没有 Git for Windows 时前置。
- **shellPath 钉入**：pi 解析 bash 走 `where.exe` 扫 PATH，而 `where` 不会在首个命中处短路——公司机器 PATH 里一条失效的网络映射盘就能烧穿它 5 秒的超时，误报 No bash shell found。因此在 Windows 上且系统没有 Git for Windows 时，还会把 `settings.json` 的 `shellPath` 直接钉到捆绑 bash（`lib/distro/shell-path.ts`，pi 的最高优先级解析，纯 existsSync，不经过 PATH）。归属记录在 `desktop-distro.json` 的 `managedShellPath`：应用换目录安装时自动改指、捆绑 git 不存在时自动摘除，用户自己设的路径永不覆盖。
- **PortableGit**：`post-install.bat` 在用户机器上首次启动时静默执行一次（脚本自删）。
- **安全**：`models.json`、`web-search.json`、`desktop-distro.json` 以 `0600` 权限原子写入；`/api/distro` 的 GET 不返回 key。

## 发版流程

1. 改动 distro 层（模型表、扩展包列表、PortableGit 版本等）后：把 `distro/distro.json` 的 `revision` +1。`revision` 按上游版本分别计数：合并上游后版本变了就重置为 1（`distro-sync.yml` 自动执行 `scripts/distro-reset-revision.mjs` 并并入 merge commit），所以 0.4.805 之后同步到 0.5.2，下一个版本是 0.5.201 而不是 0.5.206；上游版本不变时才需要手动 +1。手动 `git merge <上游tag>` 解冲突后自己跑一次 `node scripts/distro-reset-revision.mjs`（默认以 HEAD^1 为合并前基线）并把改动并入 merge commit。上游 `X.Y.0` 版本用 prerelease 后缀编码：`X.Y.0-rev.R`（如 0.6.0 → 0.6.0-rev.1），因为 `X.Y.(0×100+R)` 会撞上上游自己的 patch 号；后缀按 semver 排序，升级链依然单调（0.5.209 < 0.6.0-rev.1 < … < 0.6.0-rev.99 < 0.6.101），Tauri 更新器默认就是纯 semver 比较；
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
