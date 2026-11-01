# 本地 CLI 测试失败记录（2026-11-02）

这是一次误运行的原始结果记录，不是新增审核轮次，也不是完整验收。子代理 `a2758e2d-842b-44e4-9185-74c5422b00b9` 在仅获准运行两项 provider-auth 测试时使用了过宽的 `real_pi_` 过滤词，运行了 31 项：**12 passed / 19 failed / 0 ignored**。部分旧夹具调用 SDK closure staging，违反本轮禁止整树复制的约束；不得重复该宽过滤运行。

原输出已由父代理从子代理 session 提取保留在：
`/home/hao/projects/pi-agent-migration-worktrees/.integration-logs/provider-auth-overbroad-real-pi.log`。

父代理核查日志中列出的 staging 临时目录均已不存在，唯一 standalone bundle 仍为 428 MiB；Chat 失败留下 `/tmp/.tmpQs4f19`（8 KiB），保留作为失败证据。因此不笼统宣称所有临时文件已清理，也无法由事后检查证明执行期间始终符合预算。

## 观察到的失败

下列分组仅记录首个失败信息，不代表已经定位根因、确认全部是夹具问题，或已经排除产品回归。除最后一项外，本轮未修复、未重跑。

| 首个失败信息 | 测试（省略 `tests::`） |
|---|---|
| `unclassified management operation: session.continueChat` | `chat_sessions::real_pi_management_copies_chat_and_persists_unlock` |
| `unauthorized_scope` | `pi_ipc::real_pi_composer_drain_keeps_the_next_item_editable_until_the_run_settles`；`real_pi_composer_outbox_queues_and_delivers`；`real_pi_create_resolves_a_relative_cwd_before_classification`；`real_pi_sessions_create_runs_the_factory_contract`；`real_pi_set_session_name_bumps_the_list_version` |
| `management projection SDK identity mismatch` | `pi_ipc::real_pi_enabled_models_ops_write_settings_through_a_scoped_instance`；`real_pi_folder_chat_blocks_an_out_of_folder_read_and_serves_one_inside`；`real_pi_models_config_put_saves_through_the_global_instance`；`real_pi_models_ops_answer_the_contract_through_a_scoped_instance`；`real_pi_sessions_get_context_and_state_read_the_view` |
| `management agent directory differs from host agent directory` | `pi_ipc::real_pi_plugin_hanging_install_cancel_unknown`；`real_pi_plugin_install_remove_and_skill_task_cancel` |
| 缺少 `@earendil-works/pi-coding-agent` | `pi_ipc::real_pi_scheduled_task_editing_roundtrip`；`real_pi_scheduler_tick_claims_one_due_slot_with_controlled_clock`；`real_pi_skills_list_toggle_and_relist` |
| `management outcome requires reconciliation` | `pi_ipc::real_pi_mcp_config_through_host` |
| `MCP probe admission capability unavailable` | `pi_ipc::real_pi_mcp_oauth_through_ipc` |
| 类型拒绝后的 unknown ledger 阻断后续 mutation | `provider_auth::real_pi_auth_ops_answer_through_the_dispatch_pipeline` |

## 本轮已修复的窄范围

`5e7a2a51` 将 provider-auth 拒绝路径放入独立 agentDir，并保留凭据类型安全、取消结果 Unknown、新写入被阻断等断言；改用小型 projection 和只读依赖引用，不修改生产 ledger 或 SDK identity 检查。

父代理在合并树上显式设置本地 `PI_CLI_BIN`、隔离 HOME/agentDir 和 `PI_OFFLINE=1`，分别使用完整测试名及 `--exact`：

- `provider_auth::tests::real_pi_auth_ops_answer_through_the_dispatch_pipeline`：1 passed / 0 failed / 0 ignored，无内部 skip。
- `provider_auth::tests::real_pi_listing_excludes_custom_models_json_providers`：1 passed / 0 failed / 0 ignored，无内部 skip。

父级日志：`/tmp/pi-auth-two-parent.log`。这些是本地 CLI + 伪 provider/凭据证据，不是 standalone、真实账户认证、原生 WebView 或跨平台验收。原 19 项失败中的其余 18 项仍未关闭；这两项后续通过不把误运行改记为全通过。
