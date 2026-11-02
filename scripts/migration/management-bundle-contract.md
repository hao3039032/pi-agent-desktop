# Experimental management SDK bundle contract

This is a preparation/verification contract, not a production packaging entry point. The trusted host/build chooses the resource root; never accept it from the WebView. `bundle-manifest.json` version 1 may contain `managementRuntime` version 1, with exact roles `node`, `entry`, `dependencyRoot`, `projectionRoot`, `cli` and `piVersion`. The roots are `managed/node_modules` and `managed`; the entry is `server/lib/pi-rpc/assets/management-sdk-entry.mjs`. Windows uses `node/node.exe` and `pi/pi.exe`; the other pair is `node/node` and `pi/pi`. Both runtimes are pinned to 1.4.0. Paths are resource-relative, with exact case and forward slashes, including when resources are installed under an NSIS installation directory. The installation location itself is not encoded here.

All listed files are checked against their size and SHA-256; symlinks and extra files are rejected. The pi distribution list must exactly describe the files under `pi/` other than its own manifest. SDK checks bind the coding-agent package and its recursively declared `@earendil-works/*` dependencies to their actual package manifests and 1.4.0, including the projection's pi-ai and pi-mcp. This does **not** prove the complete non-SDK dependency closure, source graph or executable identity. Hashes demonstrate consistency with the selected manifest, not independent official provenance: the build must separately authenticate the release distribution and SDK inputs and protect/select the manifest.

After the SDK lane is integrated (including the entry/stdio assets and `buildProjectionInto(out, { sdkRuntime: true })` support), a Windows build environment may stage a fresh experimental resource directory:

```
node scripts/migration/prepare-static-bundle.mjs --out <new-resources-dir> --pi-dir <verified-pi-dir> --node <node.exe> --npm-dir <npm-dir> --frontend <static-frontend-dir> --management-sdk
node scripts/migration/verify-static-bundle.mjs <resources-dir> --management-sdk
```

The preliminary source capability check is only an integration guard, not proof of the generated graph. The SDK option explicitly requires the metadata; absent metadata fails instead of falling back. Without the option, older manifests remain valid, but metadata, if present, is always validated. Default preparation remains legacy. No existing resource directory is overwritten by preparation.

This contract does not build an installer, validate NSIS installation/upgrade behavior, run an isolated no-repository bundle, or establish native/WebView acceptance. Windows CI must use the actual integrated static frontend and host, not an old Next package; Linux standalone acceptance is not a prerequisite for a Windows preview. Integration, fresh bundle staging, no-repository execution, Windows native installation and independent provenance validation remain separate work.
