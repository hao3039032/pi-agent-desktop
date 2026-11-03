#!/usr/bin/env bash
# Exact macOS platform gates: no filtered-out/ignored test may count as a pass.
# Mirrors scripts/migration/test-windows-preview.ps1: list the tests, require
# every listed name to exist, then run it --exact and require its own
# "1 passed; 0 failed; 0 ignored" line. A green gate here is native-host
# evidence for the staged tree, never window/iframe/install acceptance.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This gate requires a real macOS runner" >&2
  exit 1
fi

export CARGO_TARGET_DIR="$PWD/src-tauri/target"
export HOME="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-preview-rust-test-home"
export PI_OFFLINE=1
mkdir -p "$HOME"
unset PI_PACKAGE_DIR PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT JITI_ALIAS NODE_OPTIONS NODE_PATH || true
# `tauri::generate_context!` reads this at compile time; without it the ACL and
# capability assertions would test the production config instead of Preview's.
export TAURI_CONFIG="$(cat src-tauri/tauri.preview.conf.json)"
export PI_PREVIEW_TEST_BUNDLE="$(cd src-tauri/resources/static-preview && pwd -P)"

summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"

run_exact_tests() {
  local manifest="$1" features="$2"
  shift 2
  local -a args=(test --locked --manifest-path "$manifest" --lib)
  if [[ -n "$features" ]]; then args+=(--features "$features"); fi
  local list available name output summary
  if ! list="$(cargo "${args[@]}" -- --list 2>&1)"; then
    printf '%s\n' "$list" >&2
    echo "Failed to list tests: $manifest" >&2
    return 1
  fi
  available="$(printf '%s\n' "$list" | sed -n 's/^\(.*\): test$/\1/p')"
  for name in "$@"; do
    if ! grep -Fxq -- "$name" <<<"$available"; then
      echo "Required macOS test missing: $name" >&2
      return 1
    fi
    if ! output="$(cargo "${args[@]}" "$name" -- --exact --nocapture --test-threads=1 2>&1)"; then
      printf '%s\n' "$output" >&2
      echo "macOS test failed: $name" >&2
      return 1
    fi
    printf '%s\n' "$output"
    summary="$(printf '%s\n' "$output" | grep -E '^test result:' | tail -n 1)"
    case "$summary" in
      "test result: ok. 1 passed; 0 failed; 0 ignored;"*) ;;
      *)
        echo "macOS test did not execute exactly one passing test: $name" >&2
        return 1
        ;;
    esac
    echo "PASS $name" >> "$summary_file"
  done
}

# The unix ledger and ownership tests are the platform's storage evidence: the
# Windows run covers the windows crate's ledger instead, and the Linux-only
# management-ledger tests are not part of this gate.
#
# The Darwin ledger and target key reach their pinned directory with
# openat/mkdirat/renameat/unlinkat (crates/management-host/src/darwin_storage.rs)
# instead of Linux's /proc/self/fd. These names pin that storage: key stability,
# read-only inspection, finish/revoke transitions and the real-child admission
# path the Preview depends on.
run_exact_tests 'crates/management-host/Cargo.toml' '' \
  'ledger_tests::target_key_is_private_stable_and_never_regenerated_beside_a_ledger' \
  'ledger_tests::target_fingerprint_matches_hmac_sha256_contract' \
  'ledger_tests::read_only_inspection_never_creates_or_clears_evidence' \
  'ledger_tests::pending_survives_reopen_and_success_finishes_only_own_record' \
  'ledger_tests::bad_record_and_unsafe_directory_fail_closed' \
  'ledger_tests::capacity_is_bounded_without_discarding_pending' \
  'ledger_tests::confirmed_local_revocation_is_monotonic_and_allows_new_generation' \
  'ledger_tests::partial_mutation_result_stays_pending' \
  'ledger_tests::real_child_success_and_exit_after_admission_preserve_evidence'

run_exact_tests 'src-tauri/Cargo.toml' 'static-preview' \
  'host_ownership::tests::ownership_child' \
  'host_ownership::tests::cooperative_hosts_exclude_until_real_holder_exit' \
  'host_ownership::tests::killed_holder_releases_kernel_lock_without_removing_file' \
  'host_ownership::tests::unsafe_lock_entries_are_rejected' \
  'preview_bundle::tests::preview_bundle_binds_roles_files_and_mixed_sdk_versions' \
  'preview_bundle::tests::preview_bundle_rejects_symlinked_resource' \
  'preview_bundle::tests::preview_bundle_rejects_role_and_sdk_version_mismatches' \
  'preview_bundle::tests::preview_bundle_rejects_escapes_aliases_and_extra_files' \
  'preview::tests::preview_close_behavior_rejects_unsupported_tray_mode' \
  'preview::tests::preview_generated_acl_grants_registered_commands_and_keeps_login_local' \
  'preview::tests::preview_navigation_keeps_external_origins_out_of_the_webview' \
  'static_host::tests::preview_state_uses_isolated_home_and_refuses_updates' \
  'static_host::tests::preview_staged_macos_runtime_stores_fake_key_and_starts_cli'
