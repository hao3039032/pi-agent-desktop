# Exact platform gates: no filtered-out/ignored test may count as a pass.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This gate requires a real Windows runner' }
if (-not $env:CARGO_HOME) { $env:CARGO_HOME = Join-Path $env:USERPROFILE '.cargo' }
if (-not $env:RUSTUP_HOME) { $env:RUSTUP_HOME = Join-Path $env:USERPROFILE '.rustup' }
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'src-tauri/target'
$env:HOME = Join-Path $env:RUNNER_TEMP 'preview-rust-test-home'
$env:USERPROFILE = $env:HOME
$env:PI_AGENT_HOME = $env:HOME
$env:PI_CODING_AGENT_DIR = Join-Path $env:HOME '.pi/agent'
$env:PI_OFFLINE = '1'
New-Item -ItemType Directory -Force $env:HOME | Out-Null
Remove-Item Env:PI_PACKAGE_DIR,Env:PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,Env:JITI_ALIAS,Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue
$env:TAURI_CONFIG = Get-Content src-tauri/tauri.preview.conf.json -Raw
$env:PI_PREVIEW_TEST_BUNDLE = (Resolve-Path src-tauri/resources/static-preview).Path

function Invoke-ExactTests($manifest, $features, $names) {
    $arguments = @('test', '--locked', '--manifest-path', $manifest, '--lib')
    if ($features) { $arguments += @('--features', $features) }
    $listed = @(& cargo @arguments -- --list 2>&1 | ForEach-Object { Write-Host $_; "$_" })
    if ($LASTEXITCODE -ne 0) { throw "Failed to list tests: $manifest" }
    $available = @($listed | ForEach-Object { if ("$_" -match '^(.+): test$') { $Matches[1] } })
    foreach ($name in $names) {
        if ($name -cnotin $available) { throw "Required Windows test missing: $name" }
        $output = @(& cargo @arguments $name -- --exact --nocapture --test-threads=1 2>&1)
        $output | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "Windows test failed: $name" }
        $summaries = @($output | Where-Object { "$_" -match '^test result:' })
        if ($summaries.Count -eq 0 -or "$($summaries[-1])" -notmatch '^test result: ok\. 1 passed; 0 failed; 0 ignored;') {
            throw "Windows test did not execute exactly one passing test: $name"
        }
        "PASS $name" | Out-File -Encoding utf8 -Append $env:GITHUB_STEP_SUMMARY
    }
}

Invoke-ExactTests 'crates/management-host/Cargo.toml' '' @(
    'windows_ledger_tests::windows_key_stays_stable_and_missing_or_corrupt_key_with_ledger_fails_closed',
    'windows_ledger_tests::windows_ledger_pending_survives_reopen_and_blocks_mutations',
    'windows_ledger_tests::windows_hardlinked_target_key_is_rejected',
    'windows_ledger_tests::windows_untrusted_dacl_on_agent_is_rejected',
    'windows_ledger_tests::windows_key_handle_rejects_untrusted_read_acl',
    'windows_ledger_tests::windows_failed_no_replace_publish_preserves_both_files',
    'windows_ledger_tests::windows_transaction_lock_excludes_other_openers',
    'windows_ledger_tests::windows_competing_ledger_instances_admit_only_one_mutation',
    'windows_ledger_tests::windows_unfinished_publication_fails_closed',
    'windows_ledger_tests::windows_reparse_storage_directory_is_rejected',
    'windows_ledger_tests::windows_unknown_survives_process_exit'
)
Invoke-ExactTests 'src-tauri/Cargo.toml' 'static-preview' @(
    'host_ownership::windows_tests::ownership_is_exclusive_and_keeps_lock_file',
    'preview_bundle::tests::preview_bundle_binds_roles_files_and_mixed_sdk_versions',
    'preview_bundle::tests::preview_bundle_simplifies_windows_runtime_paths',
    'preview_bundle::tests::preview_bundle_rejects_windows_ordinal_path_aliases',
    'preview_bundle::tests::preview_bundle_rejects_role_and_sdk_version_mismatches',
    'preview_bundle::tests::preview_bundle_rejects_escapes_aliases_and_extra_files',
    'preview::tests::preview_close_behavior_rejects_unsupported_tray_mode',
    'preview::tests::preview_generated_acl_grants_registered_commands_and_keeps_login_local',
    'preview::tests::preview_navigation_keeps_external_origins_out_of_the_webview',
    'static_host::tests::preview_state_uses_isolated_home_and_refuses_updates',
    'static_host::tests::preview_staged_windows_runtime_stores_fake_key_and_starts_cli'
)
