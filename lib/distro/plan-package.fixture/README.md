# Test fixture: the bundled /plan prompt-template package

Byte-identical copy of `npm:@codella/pi-prompt-plan` at the version pinned in
`distro/distro.json` (`packages`). The gitignored bundle copy
(`src-tauri/resources/pi-seed/…`) only exists after `npm run distro:seed`, so
`lib/distro/plan-package.test.mjs` stages this copy into its own throwaway
`pi-seed` to drive the real SDK loader against the same files the release
ships. When the pinned version in `distro/distro.json` is bumped, refresh this
directory from the installed package — the test fails on a version mismatch.
