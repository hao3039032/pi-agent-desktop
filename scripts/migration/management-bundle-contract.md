# Experimental management SDK bundle contract

This is a preparation/verification contract, not a production packaging entry point. The trusted host/build chooses the resource root; never accept it from the WebView. `bundle-manifest.json` version 1 may contain `managementRuntime` version 1, with exact roles `node`, `entry`, `dependencyRoot`, `projectionRoot`, `cli` and `piVersion`. The roots are `managed/node_modules` and `managed`; the entry is `server/lib/pi-rpc/assets/management-sdk-entry.mjs`. Windows uses `node/node.exe` and `pi/pi.exe`; the other pair is `node/node` and `pi/pi`. Both runtimes are pinned to 1.4.0. Paths are resource-relative, with exact case and forward slashes, including when resources are installed under an NSIS installation directory. The installation location itself is not encoded here.

All listed files are checked against their size and SHA-256; symlinks and extra files are rejected. The pi distribution list must exactly describe the files under `pi/` other than its own manifest. SDK checks bind coding-agent to 1.4.0 and its recursively declared `@earendil-works/*` dependencies to their own exact declared versions and actual package manifests, including the projection's pi-ai and pi-mcp. This does **not** prove the complete non-SDK dependency closure, source graph or executable identity. Hashes demonstrate consistency with the selected manifest, not independent official provenance: the build must separately authenticate the release distribution and SDK inputs and protect/select the manifest.

After the SDK lane is integrated (including the entry/stdio assets and `buildProjectionInto(out, { sdkRuntime: true })` support), a Windows build environment may stage a fresh experimental resource directory:

```
node scripts/migration/prepare-static-bundle.mjs --out <new-resources-dir> --pi-dir <verified-pi-dir> --node <node.exe> --npm-dir <npm-dir> --frontend <static-frontend-dir> --management-sdk
node scripts/migration/verify-static-bundle.mjs <resources-dir> --management-sdk
```

The preliminary source capability check is only an integration guard, not proof of the generated graph. The SDK option explicitly requires the metadata; absent metadata fails instead of falling back. Without the option, older manifests remain valid, but metadata, if present, is always validated. Default preparation remains legacy. No existing resource directory is overwritten by preparation.

## Windows preview workflow

`.github/workflows/windows-static-preview.yml` is a separate artifact-only Windows workflow, triggered by dispatch or a push to `preview/windows-static`; it does not publish a release or updater metadata. Dispatch may be unavailable until the workflow reaches the default branch. It requires the SDK entry and SDK-mode projection builder, and the separately integrated native `static-preview` feature, which must load `resource_dir/static-preview`, disable updater registration/installation and isolate preview-owned data from production. The overlay supplies the preview identity, maps only the static resource tree, removes updater configuration/capability and uses a preview-only NSIS payload cleanup hook. Those settings alone do not establish the native feature's behavior.

CI downloads the official Windows CLI with the existing SHA256SUMS verifier, checks its executable version during staging, installs locked dependencies, builds the actual Vite frontend and stages one resource tree. The offline smoke invokes staged pi RPC and the independent staged Node management SDK from a temporary working directory and HOME; it is not a test of an installed application. A resource-plus-installer 1 GiB budget is enforced. The artifact contains an unsigned NSIS installer, checksum and version/commit record. A successful CI build is not an installer, upgrade, native UI, updater-isolation or standalone acceptance. SHA256SUMS from the release and the bundle manifest are consistency checks, not independent source authentication.

No preview may be represented by an old Next package or a mock harness. Linux standalone acceptance is not a prerequisite for a Windows preview. SDK/native integration, an actual Windows CI run, installed no-repository execution, Windows native installation/upgrade and independent provenance validation remain separate work.
