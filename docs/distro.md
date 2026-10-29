# Distro：本 fork 的发行层

本仓库是 [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) 的 fork，目标是让目标用户**装一个安装包就能用**：不需要 Node.js、npm、git，不需要跑任何脚本。所有 fork 改动集中在新文件里，对上游文件的修改只有十几行调用，方便合并上游。

## 用户得到什么

- 7 个扩展包（pi-subagents、pi-web-access、pi-model-images、pi-omp-advisor、pi-plan-vanguard、@gotgenes/pi-permission-system、@erichll/pi-auto-review）已预装，首次启动自动接入；子代理默认运行时限 60 分钟（pi-subagents 内置 30 分钟，通过 `extensions/subagent/config.json` 的 `timeoutMs: 3600000` 覆盖，并在截止前 5 分钟启用收尾检查点）；Code mode 默认常开（一次性种入 `+codemode` 到全局 `defaultTools`，仅当用户没有自己的选择；分类器/图像模型只能从 codemode 脚本调到）；MCP 不再走 pi-mcp-adapter，改用 pi 官方内置 MCP（设置 → MCP 管理 `~/.pi/agent/mcp.json`），老安装升级时自动迁移（见下）；
- 权限系统（@gotgenes/pi-permission-system 门禁 + @erichll/pi-auto-review 模型裁判），默认配置首次种入 `extensions/pi-permission-system/config.json` + `extensions/pi-auto-review/config.json`（已存在的不动；配置在 session_start 读取，改完需重载会话）：
  - **决策链**：默认先 YOLO（`yoloMode: true`，只把 ask 重写为放行、不弹窗；deny 硬拒不受影响）、`authorizerChain: ["pi-auto-review"]`。`read/grep/find/ls/path` 直接放行；关闭 YOLO 后（`/permission-system` 可切）其余 ask 由裁判模型 `lw/gemini-3.5-flash-lite`（已加入 provider 模型表，`google-generative-ai` + `/v1beta`）审核，裁判不可用/失败时直接拒绝（`failureMode: deny`，fail-closed，也是包默认）。落到人工的弹窗 `promptTimeoutMs: 120000` 后无人应答即判否——子会话的弹窗没有人看得到，不设定时会把子代理挂死。`/auto-review-approve` 可精确重试非 critical 否决，`/auto-review-break-glass` 是 critical 否决的唯一人工出口。
  - **确定性硬拒**（bash 面，全锚定通配、区分大小写）：`rm` 删 POSIX `/`、`~`、Git Bash 盘符挂载 `/c` `/c/`、任意盘根 `?:\`；`mkfs*`；`dd` 写 `/dev/*` 或 `\\.\` 物理盘；`format ?:`、`Format-Volume`、`Clear-Disk`、`Remove-Partition`、`Remove-Item … ?:\`（PowerShell 不区分大小写，各列常见、全小写、全大写三种拼法）。`shellTools` 把 `powershell` 映射进 bash 执法栈（pi 的 PowerShell 工具输入参数同为 `command`）。**未覆盖的拼法落到 ask→裁判，不是放行**：绝对路径写的家目录（`rm -rf /home/<user>`、`C:\Users\<user>`，glob 写不出用户名；裁判自己的硬拒只认 `/`、`~`、`$HOME`）、其他大小写混写。
  - **子会话覆盖**（`lib/permission-system-package.ts`）：子会话默认不加载 ambient 扩展，三条创建路径各自显式带上门禁 + 裁判——Pi Web 内置子代理（`lib/subagent-runtime.ts`）与子代理会话重开（`lib/rpc-manager.ts`）把包目录作为 `additionalExtensionPaths` 注入（`noExtensions` 下只加载这些 CLI 通道路径）；pi-subagents 包用自己的加载器建子会话，前台子代理从不加载 ambient 扩展，故由 `lib/required-child-extensions.ts` 在每个非 Chat-only 会话启动时用它的宿主 API `registerRequiredChildExtensions` 登记入口文件（前台/后台/嵌套/恢复启动都会加载，`extensions: []` 也去不掉；会话销毁时注销）。用户卸载门禁后不再注入，reviewer 不会脱离 gate 单独加载；这两个安全包无视条目级资源过滤器。已知残留：用户若在 `extensions/subagent/config.json` 配了 pi-subagents 自己的 `permissions` 规则，它会在 `agentDir/extensions/pi-permission-system`（只有种入的 config，无 `package.json`）找门禁包并报错——发行版不种入该字段，默认不触发。
  - **审计**：权限审查日志在 `extensions/pi-permission-system/logs/`，裁判决策统计在 `extensions/pi-auto-review/policy-audit.sqlite`（脱敏聚合，`/auto-review-policy-audit` 查报告）。
  - **信任边界**：裁判在包根目录落在会话工作区内时拒绝加载；Windows 上应用装在用户目录下，工作区选家目录或盘根时会误中，因此服务启动时设 `PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1`（`lib/distro/runtime-env.ts`，显式设 `0` 可恢复严格检查）。代价：发行配置 `path: allow` 下写操作本就不经 ask，裁判的 protected-write 硬拒够不到，agent 可以改写两份安全配置（门禁自己的 config 本就不在任何保护清单里）；要堵住得收紧 `path` 规则，这时应同时把该变量设回 `0`。
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
| `scripts/pi-cli-release.mjs` | 发版时按 **Rust target triple** 挑上游 pi 发版的归档（darwin/linux 为 `pi-*/{arm64,x64}.tar.gz`，Windows 为 `pi-*.zip`），用该发版自己的 `SHA256SUMS` 校验后解包；包里布局不同（tar 是 `pi/pi`，zip 是扁平的 `pi.exe`），脚本统一落到 `resolvePiExecutable()` 认的文件名并导出 `PI_CLI_SOURCE` |
| `scripts/distro-reset-revision.mjs` | 合并上游后若版本变化，把 `distro.json` 的 `revision` 重置为 1（revision 按上游版本分别计数，`distro-sync.yml` 自动执行，也并入 merge commit） |
| `lib/distro/` | 运行时：PATH 注入（npm shim、Git Bash）、首次启动种子（packages 重写、默认值、`pi-plan-vanguard.json`、`WATCHDOG.yml`）、服务配置读写、一次性迁移（`mcp-migration.ts`、`lazy-tool-activation.ts`） |
| `components/distro/` | 首次启动弹窗 + 设置里的服务配置表单 |
| `app/api/distro/` | `GET/PUT /api/distro`：服务配置状态与保存（不回传 key） |
| `.github/workflows/distro-release.yml` | 发版：三平台四目标构建（macOS 双架构交叉编译）、签名、上传（fork 自有，上游的 release.yml 未动） |
| `.github/workflows/distro-sync.yml` | 每日检查上游 release，合并→跑检查→推送→触发发版 |

构建产物 `resources/pi-seed/`、`resources/git/`、`tauri.distro.conf.json` 均在 `.gitignore` 中，不进仓库。

## 运行时行为细节

- **种子**：服务启动时（`instrumentation-node.ts` → `initDistro()`）检测 `resources/pi-seed/manifest.json`，把用户 `settings.json` 的 packages 指向包内副本。匹配规则见 `lib/distro/packages.ts`：npm/git 源忽略版本号，本地路径按 `/pi-seed/<相对路径>` 识别（换安装目录也能跟上）；用户手动删掉的包不会自动加回来（记录在 `~/.pi/agent/desktop-distro.json`）；**从发行包里移除的包**会把指向包内副本的条目剪掉（不留悬空路径），且不当作「用户删过」记仇，将来重新捆绑时会重新种入。`agentFiles` 只在目标文件不存在时写入；`legacyAgentFiles` 列出的旧文件（如 `pi-plan-mode.json`）已存在时跳过种入，由 pi-plan-vanguard 自己读取并在下次保存时迁移，避免遮蔽用户配置。imagegen 的配置 `pi-model-images.json` 同样只在缺失时从已配置的服务地址（`+ /v1`）和 key 种入，已存在的不动，后续地址变更由服务表单同步。
- **一次性迁移（Code mode 常开，revision 9）**：`settings.json` 没有 `defaultTools` 键时种入 `["+codemode"]`（`lib/distro/seed.ts`，记录在 `migrations.defaultTools`，在 SettingsManager flush 之后写入，避免内存快照覆盖）。用户自己选过工具列表（键存在）则完全不动；之后在 GUI 里切回「automatic」会删键，迁移不重跑，不会覆盖用户选择。
- **一次性迁移（工具懒加载，v0.7.402，当前上游版本周期内的 revision 2）**：pi-subagents 与 pi-web-access 默认 `toolActivation: "auto"`，而 auto 只在「模型 `compat` 声明支持中途加工具」时才用加载器；本发行版的 LW 模型走 `anthropic-messages` 的 HTTP 端点、`compat` 里没有 `supportsMidConvoToolChanges` 一类声明，auto 因此在它们身上退化成 eager：**首个请求**就声明 `subagent`/`bg_wait`/`subagent_supervisor`/`contact_supervisor` 与四个 web 工具（八个 tool schema，此后每个请求都要付），而多数会话根本用不到。`lib/distro/lazy-tool-activation.ts` 把已存在的 `<agentDir>/web-search.json` 与 `<agentDir>/extensions/subagent/config.json` 补上 `toolActivation: "dynamic"`：新会话只声明 `web_enable` / `subagents_enable`，模型调用加载器后真工具**在下一个 model request 生效**——那一次请求的工具列表变了，整段对话重发、丢掉缓存前缀（一次 prompt cache miss）。auto 在 compat 没有声明「支持中途改工具」的模型上选择 eager，正是为了省掉这一次 miss；`dynamic` 让所有模型都走加载器并付这一次 miss，换来此前每个请求不再背那八个 schema。pi-subagents 在 `dynamic` 下还会给**已恢复的老会话**补一次 `subagents_enable`，代价同样是那一次 tool-list 变化（cache miss）。把生效推到「下一个**用户**提示」的只有「把工具交给另一个 agent SDK 的 bridge」那一类 provider（pi-subagents 文档如此描述，并建议这类用户用 `--exclude-tools subagents_enable` 让 `subagent` 一开始就可用）；本发行版的 `lw` provider 不是 bridge，不属于此类。**这是一次性种子，不是会反复回来的默认值**，两个守卫各管一段：`migrations.toolActivation` 管所有情形——跑过就不再执行，所以用户**删掉键**回到扩展自己的 `auto` 会一直保持；值检查只管**用户显式写下的值**（特意选的 `eager`、将来新增的取值），即使 `desktop-distro.json` 损坏丢了标记也不会被改回。删掉的键与「从没种过」在文件层面无法区分，所以标记丢失（`seed.ts` 的 `readState` 返回 null）等同一次全新种子，与 `mcpAdapter` / `defaultTools` 迁移同一语义。新装用户的 pi-subagents 配置由 `distro.json` 的 `agentFiles` 在文件缺失时写入同一个键；`web-search.json` **不种裸文件**——pi-web-access 按 `<agentDir>/web-search.json`（存在才用）→ `~/.pi/web-search.json`（legacy）→ 兜底 的顺序解析，种一个裸文件会把只有 legacy 配置的用户静默切到 agent 目录、丢掉他们的 provider/apiKey。判别词是**没有用户动作时我们不写任何东西**：「用户主动保存服务表单」有权创建并写入这个文件，「启动即静默种入」无权。改由服务表单在**首次创建**该文件时写入这个键，因此用户**把整个 `web-search.json` 删掉**后，下次保存服务配置会当作首次创建重建并写回该键——删文件等价于「重置」，是他自己的动作，不是默认值反复回灌。反过来，从没保存过服务表单的机器（首启弹窗点了 “Later”）上 `<agentDir>/web-search.json` 不存在，pi-web-access 保持扩展自己的 `auto`（即这些机器上仍然是 eager）。该键**刻意不放在 `webSearch.defaults` 里**：那批键在每次服务配置保存时都会被合并进 `web-search.json`，会把用户删掉的键又加回来。`toolActivation` 在 pi-subagents 的 fail-closed 键表里（`src/extension/config.js` 的 `FAIL_CLOSED_CONFIG_KEYS`，与发行版早已种入的 `checkpointBeforeDeadlineMs` 同一份列表）：该文件里任何校验错误都会让扩展整体不加载，而不是回落默认值——所以它不是新增的失效类别。
- **一次性迁移（Plan 模式委托工具，当前上游版本周期内的 revision 3）**：revision 2 的工具懒加载让新会话只声明 `subagents_enable` 加载器，而 pi-plan-vanguard 的 Plan 策略只放行 `defaultPlanTools` 选中的工具（它自带的只读委托逐次放行发生在白名单检查**之前**，不需要条目）——加载器是没有 `readOnlyHint` 的扩展工具，归类为「需用户主动选择」，revision 2 种下的列表没点名它，于是 Plan 工作流里调用 `subagents_enable` 被拦（"not selected by the Plan policy"），委托彻底不可用。`lib/distro/plan-tools-migration.ts` 把已存在的 revision-2 `pi-plan-vanguard.json` 种子列表补上三个名字：`subagents_enable`（加载器必须可调用，`subagent` 才会出现）、`subagent`（不点名时只有**验证过只读**的代理、plan-scout 与 `planAdmittedAgents` 能跑；点名后任意代理都可调用——子代理在 Plan 沙箱**外**执行，点名它等于像在 `/plan tools` 里勾选一样显式接受这一点）、`subagent_supervisor`（父会话应答子代理提问的通道，不点名则子代理在 Plan 工作流中提问永远无人应答）。`bg_wait` **刻意不进列表**：pi-plan-vanguard 0.62.x 让它在 Plan 模式保持屏蔽，提示词也会告诉模型「子代理结果自动送达，不要轮询」。守卫与工具懒加载迁移同一语义：`migrations.planTools` 跑过即不再执行；值检查只改写与旧种子**逐项一致**（不计顺序）的列表——用户改过（增删、重排、删键）的列表是他对同一权衡的答案，永不覆盖；文件缺失交给 `agentFiles` 种子（legacy `pi-plan-mode.json`/`plan-mode.json` 存在时同样跳过，两条路径不会分叉）。新装用户由 `agentFiles` 直接写入含三个委托名的当前列表，drift 测试（`lib/distro/config.test.mjs`）钉住「旧列表 + 三个委托名 = 种子列表」这一分解。
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
3. 全部目标构建成功后 draft 自动转正；部分失败保持 draft，会在 job summary 里报警，不要手工发布。

## macOS Runner 选择与容量不足

`distro-release.yml` 的手动触发界面提供两个独立的 choice 参数；省略参数的自动触发仍使用 `macos-26`：

| 参数 | 默认 | 可选 Runner |
|---|---|---|
| `macos_arm64_runner`（Apple Silicon 包） | `macos-26` | `macos-26`、`macos-15` |
| `macos_x64_runner`（Intel 包） | `macos-26` | `macos-26`、`macos-15` |

`macos-15` 显式选择预装的 `/Applications/Xcode_26.3.app`；不存在就失败，不回退到旧 Xcode。所有 Mac 构建仍要求 **macOS SDK ≥ 26**，不因 Runner 系统版本或 CPU 架构降低门槛，以保留新版 AppKit 窗口控件。此选择不改变安装包的最低运行系统版本。

Intel 包一律在 ARM Runner 上交叉编译并换入 x64 Node（原生 `*-intel` Runner 选项已移除：hdiutil/bundle_dmg 在 Intel 跑机上挂死，且镜像正被淘汰；v0.7.705 的 Intel 包即由 macos-26 交叉编译产出）。该路径保留随包运行时架构校验、`desktop:verify`、签名及全部平台成功才发布的门槛。新增 Runner 的实际可用性须由对应 CI 构建验证，本地工作流测试不等同于 Mac 打包通过。

遇到 `The job was not acquired by Runner of type hosted` 时，可新建一次运行选择备用镜像，例如：

```bash
gh workflow run distro-release.yml --ref main -f macos_arm64_runner=macos-15 -f macos_x64_runner=macos-15
```

工作流修改须先推送到所选分支。旧运行的 **Re-run** 沿用旧提交和输入，不能切换 Runner；需要新的 workflow dispatch。若旧运行仍排队，先确认是否取消它，否则发布工作流的 concurrency 队列会让新运行继续等待。候选列表不是自动抢占/故障转移；不同 ARM 镜像仍可能同时缺资源。保持 `max-parallel: 1`，避免各目标覆盖同一个 `latest.json`；不完整的 draft 不得手动转正。

## macOS 双架构（Intel 支持）

随包的 pi CLI 与 Node 运行时一样按 **target triple** 选：`scripts/pi-cli-release.mjs` 用 `matrix.target`（`aarch64-apple-darwin` / `x86_64-apple-darwin`）查上游发版归档，而不是 runner 的架构——Intel 包正是跑在 Apple Silicon runner 上。这一步曾经按 `matrix.platform` 写死一个上游从未发布的 `pi-macos-x64.zip`，两个 macOS 目标都在下载处 404，等于近几版没有 mac 安装包；现在下载的名字只来自脚本里的映射表（Map，`constructor`/`__proto__` 不是 triple），`SHA256SUMS` 里查不到该名字就直接失败（上游改名不会被静默当成空归档），并校验整个归档的 sha256 后才解包（自写的 tar.gz/zip 读取器遇到 PAX/GNU 扩展头、越界长度、路径逃逸、symlink 直接拒绝）。

**随包的 pi 是整个发行目录，不只是一个可执行文件**：归档里 darwin/linux 还带 `pi/photon_rs_bg.wasm`、`pi/theme/`（Windows zip 是扁平的 `pi.exe`+`theme/`）。`scripts/pi-cli-release.mjs` 导出 `PI_CLI_SOURCE`（可执行文件）与 `PI_CLI_DISTRIBUTION_DIR`（解包出来的发行目录），`scripts/prepare-desktop.mjs` 通过 `scripts/pi-cli-distribution.mjs` 把整个目录树拷进 `src-tauri/resources/pi/` 并写 `pi-distribution.json` 清单；只给 `PI_CLI_SOURCE`（单可执行文件）仍是明确支持的旧输入，清单里记 `complete: false`（本地开发树用；发版工作流 `PI_DESKTOP_REQUIRE_PI=1` 下直接拒绝，`scripts/verify-packaged-frontend.mjs` 还会断言 `complete: true`）。清单核对不在 `desktop:verify`，在 `scripts/verify-packaged-frontend.mjs`：按清单逐个核对最终 resources，缺一个文件就不放行。可执行文件名与权限按 **target** 而非 host 判断（交叉构建不用 host 平台的 `pi.exe`）。

默认在 Apple Silicon runner 上用 Rust 交叉编译 `x86_64-apple-darwin`（也可选择 Intel runner 原生构建）；交叉构建还需要处理随包分发的 Node 运行时：`scripts/prepare-desktop.mjs` 默认复制构建机正在运行的 `process.execPath`，交叉构建时由工作流从 nodejs.org 下载同版本 `darwin-x64` Node，并通过两个环境变量交给打包脚本：

- `PI_DESKTOP_TARGET_TRIPLE`：本次构建的目标（如 `x86_64-apple-darwin`），不设则取构建机自身的平台/架构；
- `PI_DESKTOP_NODE_BINARY`：要打包的 Node 二进制路径，替代 `process.execPath`。

打包末尾有 Mach-O 架构校验：darwin 目标的随包 Node 若不含目标 cpu type（x86_64 / arm64），构建直接失败，不会把 ARM 包静默发给 Intel 机器（否则到目标机上启动 server 就报 `Bad CPU type in executable`）。node-pty 预编译两种架构本就随包携带，Code mode 沙箱是 WebAssembly，均与架构无关。`mac-build-test.yml` 的 `target` 输入可选架构，用于给 Intel 机器手出测试安装包；ARM runner 自带 Rosetta，`desktop:verify` 能在构建时验证 x64 包。

## 一次性设置

- Secrets（Settings → Secrets and variables → Actions）：
  - `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` / `TAURI_UPDATER_PUBLIC_KEY`：`npm exec tauri signer generate` 生成，公钥由 workflow 注入；
  - `DISTRO_SYNC_TOKEN`：fine-grained token（仅本仓库，Contents + Workflows 读写）。上游每次发版都改 workflow 文件，`GITHUB_TOKEN` 推不上去。缺它时 sync 会报错退出，手动发版不受影响。
- `pi-agent-desktop-package.json` 提交的是上游版本号；distro 版本号只在 CI 检出里改写，避免合并冲突。

## 已知限制

- macOS 未做签名/公证（与上游相同），首次打开需要 系统设置 → 隐私与安全性 → 仍要打开；
- Windows 未做 Authenticode 签名，SmartScreen 可能提示一次「更多信息 → 仍要运行」；
- 上游的 `release.yml`、`component-updates.yml` 仍在仓库里但不会自动跑；合并上游时若它们改动了 `tauri.conf.json` 的 resources 列表，`distro-build-config.mjs` 会读取最新列表再附加 distro 资源。
