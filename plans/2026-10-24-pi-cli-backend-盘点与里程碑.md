# pi CLI 后端切换:调用面盘点与差距表(v1)

状态:主体完成(M0-M3 全部落地,M4 清理与 fleet 监控为后续;见文末进度)
分支:wip/pi-cli-backend
决策(用户已确认):一步到位,**不留 pi-sdk 进程内路径**。本表是重写地图,按里程碑推进。

## 一、替换目标

`lib/rpc-manager.ts` 的 `AgentSessionWrapper`(~2000 行)包装进程内 SDK session(`AgentSessionLike`,见 lib/pi-types.ts)。新后端:每个 pi-web 会话 = 一个 `pi --mode rpc [--no-session]` 子进程,JSONL over stdio(pi v1.4.0 协议,docs/rpc.md)。

## 二、方法调用面映射(AgentSessionLike → RPC 命令)

### A. 直接映射(有对应命令,重写为命令调用)

| AgentSessionLike | RPC 命令 | 备注 |
|---|---|---|
| prompt() | `prompt` | disposition: handled/queued/started;options.images 待确认参数名 |
| steer()/followUp() | `steer` / `follow_up` | 返回 handled/queued |
| abort() | `abort` | |
| clearQueue() | `clear_queue` | |
| setModel() | `set_model` | 参数为完整 model 对象 |
| model 运行时枚举 | `get_available_models` | 返回完整 Model 对象(含 cost) |
| setThinkingLevel() | `set_thinking_level` | |
| getAvailableThinkingLevels() | `get_available_thinking_levels` | |
| setSteeringMode/setFollowUpMode | `set_steering_mode` / `set_follow_up_mode` | |
| compact() | `compact` | |
| abortCompaction() | `abort`(compaction 中)| 文档确认 compaction 的 abort 语义 |
| setAutoCompactionEnabled | `set_auto_compaction` | |
| setAutoRetryEnabled | `set_auto_retry` | |
| abortRetry() | `abort_retry` | |
| executeBash()/abortBash() | `bash` / `abort_bash` | 流式输出走 bash_execution_update 事件(带命令 id) |
| getSessionStats() | `get_session_stats` | 字段几乎 1:1(tokens/cost/contextUsage) |
| getLastAssistantText() | `get_last_assistant_text` | |
| setSessionName() | `set_session_name` | |
| navigateTree(无 summarize) | `get_tree` + `get_entries`/`get_messages` 定位 | 见 D 区复杂项 |
| — | `fork` / `clone` / `switch_session` / `new_session` | pi-web 的 session-replacement.ts(fork/clone 写文件)改走命令 |
| — | `get_commands` | 替代 promptTemplates/skills 枚举(source: prompt/skill/extension) |

### B. 状态读取(轮询/事件维护替代属性)

AgentSessionLike 的同步属性(isStreaming/isCompacting/isIdle/model/pendingMessageCount/steeringMode...)改为:
- 启动时 `get_state` 全量拉取
- 之后由事件流增量维护(agent_start/agent_end/agent_settled/message_*/queue_* 事件,json.md 的 Event sequence 就是状态机)
- 必要时 get_state 重对账(每次 agent_settled 后)

### C. 事件流(subscribe(listener) 的替代)

json.md 事件 ↔ AgentSessionEvent 映射:agent_start/turn_start/message_start/message_update/message_end/turn_end/agent_end/agent_settled/tool 事件/queue 事件/compaction 事件/retry 事件/extension_error。**结构高度同源**(两者本来就是同一套 SDK 事件),预期 adapter 是字段级微调而非翻译。
RPC 额外:bash_execution_update(带命令 id 关联)、extension_ui_request(独立子协议)。

### D. 差距项(无直接命令,需设计)

| 能力 | 现状用途 | 候选方案 | 风险 |
|---|---|---|---|
| **setActiveToolsByName**(动态工具白名单) | chat-only 模式、chat-unlock、setRpcSessionTools | **实测(2026-10-24):spawn 层已解**——pi 有 `--tools +/-name` 相对语法与 `--no-builtin-tools`;运行时切换 = 重启子进程(与 pi-web 现有的重启模式同构)。上游 PR(set_active_tools)仍值得提,消除重启成本 | 中(已降) |
| **navigateTree({summarize})**(分支摘要) | 会话树导航 UI | 无 RPC 命令 | 功能暂缺或提 PR |
| sendCustomMessage | 自定义消息类型注入 | 无 RPC 命令 | 使用面盘点后定 |
| getExtensions()/resourceLoader(扩展加载结果) | pi-subagents 检测(preferPiSubagents) | extension_ui/extension_error 事件里带 path;get_commands 的 sourceInfo 部分覆盖 | 中 |
| systemPrompt(渲染后的系统提示) | 设置页展示 | 无直接命令;get_entries 可能含 system 消息 | 低(展示功能) |
| promptTemplates/skills 完整列表 | 命令面板 | get_commands 覆盖大部分(sourceInfo 结构不同) | 低 |
| reload() | 会话重载(信任变化等) | **switch_session 或杀进程重启**(会话文件在磁盘,RPC resume 恢复) | 中,行为语义变化 |
| dispose() | 会话销毁 | 关 stdin(有序关停,文档明确)+ 兜底 kill | 直接 |
| sessionManager/settingsManager 直访 | 会话列表、设置读写 | **已验(2026-10-24)**:会话文件双进程共享可行——pi-web 先写 header(自选 id/parentSession/自定义条目),子进程 `--session <path>` 无缝接手并追加;pi-web 侧每次访问重新 open 读盘(FileSessionManagerView);settingsManager 用进程内 SDK 实例读同一份 settings.json;信任经共享 trust.json 自动互通(pi-web 信任对话框写的决定,子进程直接认) | 已解(文件层) |

### E. 67 个 runtime import 的处置分类(不含 rpc-manager 本体)

1. **仅类型**(32 个 type-only):改本地声明或从 pi npm 包仅 import type(类型可以留依赖?——不留 pi-sdk = 运行时依赖删除;类型依赖保留与否见里程碑 M0 决策)
2. **配置/文件工具类**(getAgentDir、SettingsManager、SessionManager、loadMcpConfig、主题等):改为 pi-web 自己实现文件读写(~/.pi/agent 的 jsonl/json 格式已稳定,pi-web 已有 session-reader 等平行实现)或走 RPC 命令
3. **扩展工厂**(createCodemodeExtension/createMcpExtension/createToolSearchExtension + pi-web 宿主扩展群):**迁移为 pi CLI 加载的扩展文件/包**。RPC extension_ui 子协议支持 dialog + fire-and-forget(实测事件流通),但 ctx.mode="rpc" 下部分 UI API 降级(custom/theme 等 no-op,见 rpc-extension-ui.md Limitations)
4. **模型/Provider 定义**(models 配置读取):get_available_models 返回完整 Model 对象(含 baseUrl/cost),大部分场景够用;自定义模型配置写盘(~/.pi/agent/models.json)pi CLI 自己会读

### F. MCP host(mcp-host.ts)

pi CLI 自带 MCP 加载(mcp.json);pi-web 的进程内 transport 包装(wrapTransportFactory)失效。MCP 服务器连接/代理职责移交 pi CLI 子进程;pi-web 只保留 mcp.json 的配置读写 UI。**净效果是简化**。

### G. subagent 体系

pi-subagents 扩展在 pi CLI 子进程内运行(实测 standalone 加载用户 ~/.pi 扩展 OK);pi-web 的 pi-subagents-rpc.ts(进程内 EventBus RPC)改为走 extension_ui/事件流转发。上游 wip 分支(c44a1d2c)的 "RPC adapter groundwork" 可参考。

## 三、里程碑(分支内推进,不留旧路径)

- **M0 地基**:PiRpcClient(JSONL 分帧,id 关联,事件订阅,extension_ui 子协议,退避重连);pi.exe 定位/下载(distro 组件);类型基线(type-only import 迁移策略)。**产出可运行 smoke:spawn→get_state→prompt→事件流→回复。**
- **M1 会话核**:RpcAgentSession 实现 AgentSessionLike 的 A/B/C 区(A 命令 + B 状态机 + C 事件 adapter);rpc-manager 的 wrapper 换内芯;API routes 不动。
- **M2 会话树/管理**:fork/clone/switch/new_session 替换 session-replacement;会话列表走文件直读(session-reader 已有);E2 类工具收编。
- **M3 扩展迁移**:宿主扩展群(E3)改造成 pi CLI 扩展文件;chat-unlock/permission-system 的策略执行点迁移。
- **M4 清理**:删 pi-sdk runtime 依赖(package.json、node_modules、distro 打包);67 个 import 归零(E 分类完成);文档。
- **M5 集成**:三平台打包、distro 组件(pi-cli)、updater 链路、回归。

## 四、已实测验证(2026-10-24)

- pi.exe 1.4.0 RPC:0.7-0.9s 净启动、3.1s 全扩展;get_state/bash/prompt/agent_settled/get_last_assistant_text 全通;用户 ~/.pi 扩展生态在子进程内激活;stdin 关闭有序退出。
- extension_ui_request 事件流(实测 setWidget/setStatus)正常到达客户端。

### M1 后半实测(2026-10-24,lib/pi-rpc/factory.test.mjs;评审后修复批次见下)

- **真 wrapper 换芯**:未改动的 `AgentSessionWrapper.send()/onEvent()/start()` 驱动子进程跑完整会话(prompt→事件流→settled→get_state/get_tools/get_commands/stats),含工具锁定(spawn `--tools +read,+bash,-edit,...`)与 resume(同一文件、同一 session id、转录保留)。
- **文件所有权**:pi-web 写 header(自选 id/parentSession/tool-selection 条目)→子进程 `--session` 接手追加;两进程一文件,pi-web 侧 fresh-open 读盘。
- **prompt 语义对齐**:pi 的 prompt 响应=受理;SDK 的 prompt promise=run 完全 idle 才 resolve。RpcAgentSession 用 run-epoch 计数补齐(started 等下一 epoch settle,queued 等当前 epoch;epoch 必须在发送前捕获——响应与 agent_start 同一 stdout chunk 时,await 续体晚于两者处理)。wrapper.send 本就受理即返,不受影响。
- **UI 桥**:子进程 extension_ui_request(同源 wire 形状)经 wrapper 新增的 relayExternalUiRequest/relayExternalUiEvent 复用 pending-UI 机制(SSE 重放、Stop 取消、超时回 cancelled),响应回传 client.respondUi;fire-and-forget 同步维护 extensionStatuses/extensionWidgets 供 get_state。client.test.mjs 的探针扩展(确定性、无 LLM)验证全链。
- **模型恢复(勘误)**:本节首版声称"已验",系被假绿掩盖——实际上存在三重 bug(get_available_models 的 `{models}` 形状解析错、set_model 应发扁平 `{provider,modelId}`、modelRuntime 缓存每次访问重建),resume 测试因保存模型==默认模型而恰好绕过。评审循环修复后由 session.unit.test.mjs 的形状/缓存单测锁定,e2e 尚未断言"恢复到不同模型"(待 M2 接线时补,需要第二个已配凭据的模型)。

### 评审循环修复批次(2026-10-24,两轮)

第 1 轮 3 评审找出 8 组 P1(client id 展开顺序、waitForSettle 同 chunk 竞态、工厂 spawn 失败挂起、write-after-end 崩溃、settle 后对账竞态、模型路径三重死、powershell 丢失、宿主变量泄漏)与若干 P2;修复 worker + 父循环补修后,第 2 轮 3 评审验证全部 RESOLVED(集成侧 PARTIAL 仅因文档未记,本批次补齐)。测试新增 session.unit.test.mjs(fake client、无二进制、CI 可跑)与 UI 探针 e2e;e2e 全部改用 sessionDir 沙箱(测试会话不再进入真实会话库)。

### 已知分歧与推迟项(记档)

- **attachUiRelay 启动窗口**:relay 在握手+refreshState+refreshCommands 之后才注册,启动期(秒级)子进程扩展的对话框会被 client 自动 cancel。M2 接线时缓冲启动期 UI 记录。
- **autoRetryEnabled 初值**:get_state 无此字段,初值 true 未经证实(事件 auto_retry_start 才会校正);见 core.ts initialCoreState 注释。
- **"handled" disposition 与扩展自启 run**:扩展命令可自行启动 run(不经 prompt promise 约束),与进程内 SDK "完全 idle 才 resolve"语义不同;session.unit.test.mjs 锁定当前行为,M2 接线时复审是否需要宽限期等待。
- 并发 get_available_models refresh 无去重(重复 IO,无害);fake client 不模拟退出后 command 拒绝与退出码传递(单测若断言这些再修);双重 SettingsManager 读(factory 与 core 各一次,同快照语义)。

### 仍开放的差距(更新)

- **无 get_tools RPC**:工具选择器展示编码工具静态名单(PRESET_FULL+powershell,active=shell 映射后的 spawn 选集),子进程里激活的扩展/MCP 工具不可见——上游 PR 候选(get_tools)。
- **reload() 未实现**:RPC 模式下 reload=杀进程重拉(文件在盘);信任变更后需重生。M2。
- navigateTree/fork/clone/sendCustomMessage:维持 D 区原判,M2 起逐个收编(FileSessionManagerView 对应方法显式 throw PiRpcUnsupportedError,fork/clone 不会以 TypeError 崩)。
- 测试待补(P2):factory get_commands 确定性断言、FileSessionManagerView 纯单测、resume 工具重锁定断言。

## 五、给上游提 PR 的候选清单(增强 pi CLI RPC,反哺生态)

set_active_tools、navigate_tree(+summarize)、send_custom_message、get_extensions、get_system_prompt。这些能让 pi CLI 成为完整的桌面后端,对 OpenClaw 等集成同样有价值。

## 六、M2/M3 落地记录(2026-10-24,提交 0ee3583c..59380f0a)

- **桥接扩展**(assets/pi-web-bridge.mjs):/pi-web:navigate(含 summarize)与 /pi-web:reload 经 ExtensionCommandContext 驱动子进程内建 navigateTree/reload——RPC 1.4.0 的协议缺口由扩展命令补上;工厂验证命令已注册,未加载则拒绝会话。MCP 只读策略与 artifacts 提示词段一并移植入桥接。
- **路由切换**:startRpcSession 将普通项目会话、chat-only pin、聊天工作区全部交给 CLI 引擎;进程内路径只剩 subagent 子会话(SUBAGENT_CONTROLLER,孤儿化待 M4 删)。
- **会话树**:fork/clone 经文件手术(view 支持 isPersisted/getLeafId/getSessionDir/createBranchedSession);navigate 经桥接;工具锁定变更 = 重生(canLiveSwitchTools)。
- **聊天策略资产**(assets/pi-web-chat.mjs):chat-workspace-policy/chat-file-access/chat-downloads-tool 的完整移植,grants 在子进程内从共享会话条目计算;PI_WEB_CHAT_MODE/PI_WEB_CHAT_FILES 环境变量配置;save_to_downloads 工具随行。
- **打包**:prepare-desktop 经 PI_CLI_SOURCE/PI_CLI_BIN 把 pi.exe 布进 resources/pi(distro 资源清单已加);resolvePiExecutable 依次找 PI_CLI_BIN→打包位(cwd/resources/pi、../pi)→PATH。
- **测试**:单测(session/bridge/chat-policy 共 23)+ 真二进制 e2e(12)+ 生命周期(61,其中 5 项需 PI_CLI_BIN、无则 skip)全绿。

### M4/后续待办
- 删 SUBAGENT_CONTROLLER 与进程内会话构造路径(startRpcSession 的 in-process 分支、exact-system-prompt/chat-workspace-policy/mcp-host 等宿主扩展接线);67 个 runtime import 清点。
- fleet 监控(subagents API)对 CLI 会话降级为 unavailable——待上游 RPC adapter 或经子进程扩展总线重建。
- e2e 恢复到不同模型的断言(需第二个已配凭据模型);get_commands 确定性断言;FileSessionManagerView 纯单测。
