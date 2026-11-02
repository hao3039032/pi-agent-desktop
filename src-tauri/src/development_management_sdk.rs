//! Development-only binding of the selected CLI to checkout installation metadata.
//! This does not authenticate unpacked files or establish a packaged distribution.
use std::path::{Path, PathBuf};
use management_host::ManagementSdkRuntime;
use serde_json::Value;

pub struct DevelopmentManagementSdk {
    pub checkout: PathBuf,
    pub node: PathBuf,
    pub entry: PathBuf,
    pub sdk_root: PathBuf,
    pub projection: PathBuf,
}

struct VerifiedCliBinding { executable: PathBuf }

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|_| "development metadata unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid development metadata".into())
}

fn bind_cli(checkout: &Path, selected: &Path) -> Result<VerifiedCliBinding, String> {
    if !checkout.is_absolute() || !selected.is_absolute() { return Err("development paths must be absolute".into()); }
    let checkout = checkout.canonicalize().map_err(|_| "development checkout unavailable")?;
    let lock = read_json(&checkout.join("package-lock.json"))?;
    let pins = read_json(&checkout.join("scripts/release-component-pins.json"))?;
    if lock.pointer("/packages/node_modules~1@earendil-works~1pi-coding-agent/version").and_then(Value::as_str) != Some("1.4.0")
        || pins.pointer("/pi/version").and_then(Value::as_str) != Some("1.4.0") {
        return Err("development CLI version metadata mismatch".into());
    }
    let package = checkout.join("node_modules/@earendil-works/pi-coding-agent").canonicalize().map_err(|_| "development CLI package unavailable")?;
    let install_root = checkout.join("node_modules").canonicalize().map_err(|_| "development installation unavailable")?;
    if !package.starts_with(&install_root) || package == install_root { return Err("development CLI package outside installation".into()); }
    let manifest = read_json(&package.join("package.json"))?;
    if manifest.get("name").and_then(Value::as_str) != Some("@earendil-works/pi-coding-agent") || manifest.get("version").and_then(Value::as_str) != Some("1.4.0") {
        return Err("development CLI package identity mismatch".into());
    }
    let bin = manifest.pointer("/bin/pi").and_then(Value::as_str).ok_or("development CLI bin missing")?;
    let executable = package.join(bin).canonicalize().map_err(|_| "development CLI bin unavailable")?;
    if !executable.starts_with(&package) || executable == package || !executable.is_file()
        || selected.canonicalize().map_err(|_| "selected CLI unavailable")? != executable {
        return Err("selected CLI does not match development package".into());
    }
    Ok(VerifiedCliBinding { executable })
}

impl DevelopmentManagementSdk {
    pub(crate) fn verify(&self, selected: &Path) -> Result<(ManagementSdkRuntime, PathBuf), String> {
        let binding = bind_cli(&self.checkout, selected)?;
        for path in [&self.node, &self.entry, &self.sdk_root, &self.projection] {
            if !path.is_absolute() { return Err("development runtime paths must be absolute".into()); }
        }
        let entry = self.entry.canonicalize().map_err(|_| "management entry unavailable")?;
        let assets = entry.parent().ok_or("management entry directory unavailable")?;
        if assets.join("management-sdk-entry.mjs").canonicalize().map_err(|_| "management entry unavailable")? != entry {
            return Err("untrusted management entry".into());
        }
        for (name, expected) in [
            ("management-sdk-entry.mjs", include_bytes!("../../lib/pi-rpc/assets/management-sdk-entry.mjs").as_slice()),
            ("management-stdio.mjs", include_bytes!("../../lib/pi-rpc/assets/management-stdio.mjs").as_slice()),
            ("pi-web-management.mjs", include_bytes!("../../lib/pi-rpc/assets/pi-web-management.mjs").as_slice()),
        ] {
            if std::fs::read(assets.join(name)).map_err(|_| "management asset unavailable")? != expected { return Err("untrusted management asset".into()); }
        }
        Ok((ManagementSdkRuntime {
            node: self.node.canonicalize().map_err(|_| "management Node unavailable")?, entry,
            dependency_root: self.sdk_root.canonicalize().map_err(|_| "management SDK root unavailable")?,
            projection_root: self.projection.canonicalize().map_err(|_| "management projection unavailable")?,
            cli_version: "1.4.0".into(),
        }, binding.executable))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn development_cli_binding_rejects_identity_path_and_version_mismatches() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let package = root.join("node_modules/@earendil-works/pi-coding-agent");
        std::fs::create_dir_all(package.join("dist")).unwrap();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        let selected = package.join("dist/cli.js");
        std::fs::write(&selected, "fixture").unwrap();
        std::fs::write(root.join("outside.js"), "fixture").unwrap();
        let lock = |version: &str| std::fs::write(root.join("package-lock.json"), json!({"packages":{"node_modules/@earendil-works/pi-coding-agent":{"version":version}}}).to_string()).unwrap();
        let pins = |version: &str| std::fs::write(root.join("scripts/release-component-pins.json"), json!({"pi":{"version":version}}).to_string()).unwrap();
        let manifest = |name: &str, version: &str, bin: &str| std::fs::write(package.join("package.json"), json!({"name":name,"version":version,"bin":{"pi":bin}}).to_string()).unwrap();
        lock("1.4.0"); pins("1.4.0"); manifest("@earendil-works/pi-coding-agent", "1.4.0", "dist/cli.js");
        assert_eq!(bind_cli(root, &selected).unwrap().executable, selected.canonicalize().unwrap());
        assert!(bind_cli(root, &root.join("outside.js")).is_err());
        manifest("wrong", "1.4.0", "dist/cli.js"); assert!(bind_cli(root, &selected).is_err());
        manifest("@earendil-works/pi-coding-agent", "9.0.0", "dist/cli.js"); assert!(bind_cli(root, &selected).is_err());
        manifest("@earendil-works/pi-coding-agent", "1.4.0", "../../../outside.js"); assert!(bind_cli(root, &root.join("outside.js")).is_err());
        manifest("@earendil-works/pi-coding-agent", "1.4.0", "dist/cli.js");
        lock("9.0.0"); assert!(bind_cli(root, &selected).is_err());
        lock("1.4.0"); pins("9.0.0"); assert!(bind_cli(root, &selected).is_err());
    }
}
