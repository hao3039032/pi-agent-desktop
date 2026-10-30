//! Guarded auto-update installer.
//!
//! The webview only asks for "install the update you find". It never supplies a
//! download URL, mirror list, signature, target or installer path: the endpoint
//! list comes from this build's Tauri configuration, and the repository, tag
//! and asset name are checked against values compiled into the shell.
//!
//! What a mirror can and cannot do: an update *manifest* is fetched over HTTPS
//! but is **not** signed, so a mirror that answers the metadata request can
//! name any asset URL. Nothing is fetched from that URL until it passes
//! [`canonical_asset_error`], which pins the repository, the release tag that
//! matches the announced version, and a single plain file name — and minisign
//! verification of the downloaded bytes is what finally decides whether
//! anything is installed.
//!
//! Each attempt calls the updater plugin's own `Update::download()`, which
//! verifies the minisign signature before the bytes are handed back. A
//! signature, target or install failure ends the run: it is never retried
//! against another host and never turned into a manual-install escape hatch.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use url::Url;

/// Mirror origins, comma separated, injected at release time from
/// `distro/distro.json`'s `updateMirrors` (see scripts/distro-build-config.mjs).
/// A local build has none and only ever uses the manifest's own URL.
const MIRRORS: Option<&str> = option_env!("PI_AGENT_DESKTOP_UPDATE_MIRRORS");

/// The public key is what makes any update installable; the shell registers the
/// updater plugin only when it is present, so its absence also means the plugin
/// state this command needs does not exist.
const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("PI_AGENT_DESKTOP_UPDATER_PUBLIC_KEY");

/// The repository this build installs from. Also `distro/distro.json`'s
/// `app.repository` and `lib/branding.ts`'s `APP_REPOSITORY`; a cross-language
/// test pins the three together.
const REPOSITORY: &str = "hao3039032/pi-agent-desktop";

const PROGRESS_EVENT: &str = "pi-update-progress";

/// One manifest request must not hold the dialog open on a dead endpoint.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
/// All manifest attempts together, so a slow list cannot stall the check.
const METADATA_DEADLINE: Duration = Duration::from_secs(45);
/// A whole installer may legitimately take a long time on a slow mirror, but it
/// still needs a ceiling so a stalled transfer cannot hang forever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// Progress is throttled: a 100 MB installer arrives in thousands of chunks and
/// every chunk would otherwise cross the IPC bridge.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
/// Public mirrors churn, and the list also bounds the retry budget.
const MAX_MIRRORS: usize = 3;
/// The canonical manifest plus one per mirror.
const MAX_ENDPOINTS: usize = 1 + MAX_MIRRORS;

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    /// `downloading` or `installing`.
    phase: &'a str,
    /// `github.com` for the canonical asset, otherwise the mirror origin.
    source_host: &'a str,
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_version: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_host: Option<String>,
}

/// How the run ended, in terms the UI can act on without parsing English.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFailure {
    /// `transport`, `manifest`, `signature`, `unavailable`, `install` or `busy`.
    kind: &'static str,
    message: String,
    attempted_hosts: Vec<String>,
}

impl InstallFailure {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            attempted_hosts: Vec::new(),
        }
    }

    fn with_hosts(mut self, hosts: Vec<String>) -> Self {
        self.attempted_hosts = hosts;
        self
    }
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    phase: &'static str,
    source_host: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    target_version: Option<&str>,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress {
            phase,
            source_host,
            downloaded_bytes,
            total_bytes,
            target_version,
        },
    );
}

/// One mirror origin is `host` or `host:port`; nothing else is accepted, so a
/// configured value can never become a path, credentials or a second URL.
///
/// The same rules live in `lib/update-mirrors.ts` and
/// `scripts/distro-build-config.mjs`; the three lists of rejected shapes are
/// kept identical by tests on each side, so a value accepted by the release
/// build cannot be silently dropped here.
fn is_valid_mirror_host(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    if let Some(port) = port {
        if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        match port.parse::<u32>() {
            Ok(value) if (1..=65535).contains(&value) => {}
            _ => return false,
        }
    }
    let labels: Vec<&str> = name.split('.').collect();
    // A single label is not a host: it would resolve through a search domain.
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// `https://gh-proxy.com/` -> `gh-proxy.com`; anything else -> `None`.
fn normalize_mirror_host(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = without_scheme.trim_end_matches('/').to_ascii_lowercase();
    is_valid_mirror_host(&host).then_some(host)
}

/// Validated mirror origins in try order: trimmed, de-duplicated, capped.
fn parse_mirrors(raw: Option<&str>) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for part in raw.unwrap_or("").split(',') {
        let Some(host) = normalize_mirror_host(part) else {
            continue;
        };
        if !hosts.contains(&host) {
            hosts.push(host);
        }
        if hosts.len() == MAX_MIRRORS {
            break;
        }
    }
    hosts
}

fn configured_mirrors() -> Vec<String> {
    parse_mirrors(MIRRORS)
}

/// Why `asset` cannot be the installer for `version`, or `None` when it can.
///
/// A manifest is not signed, so this is the only thing standing between a
/// hostile mirror and an arbitrary download: the asset must be this
/// repository's release asset for the tag that matches the announced version,
/// a single plain file name, over https, with no port, credentials, query,
/// fragment or encoded path separator.
fn canonical_asset_error(asset: &Url, version: &str) -> Option<&'static str> {
    if asset.scheme() != "https" {
        return Some("the update asset URL is not https");
    }
    if asset.host_str() != Some("github.com") {
        return Some("the update asset URL is not on github.com");
    }
    if asset.port().is_some_and(|port| port != 443) {
        return Some("the update asset URL names a non-default port");
    }
    if !asset.username().is_empty() || asset.password().is_some() {
        return Some("the update asset URL carries credentials");
    }
    if asset.query().is_some() || asset.fragment().is_some() {
        return Some("the update asset URL carries a query or fragment");
    }
    let path = asset.path();
    for escape in ["%2f", "%2F", "%5c", "%5C"] {
        if path.contains(escape) {
            return Some("the update asset URL contains an encoded path separator");
        }
    }
    let prefix = format!("/{REPOSITORY}/releases/download/v{version}/");
    let Some(name) = path.strip_prefix(&prefix) else {
        return Some(
            "the update asset is not this repository's release asset for the announced version",
        );
    };
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        return Some("the update asset name is not a single file name");
    }
    None
}

/// The mirror's view of a validated canonical asset:
/// `https://<mirror>/https://github.com/<owner>/<repo>/releases/download/...`.
///
/// The caller has already checked the asset against the announced version with
/// [`canonical_asset_error`]; this only refuses shapes that could not have
/// passed that check, so the mirror is never asked for an arbitrary URL.
fn mirror_asset_url(asset: &Url, host: &str) -> Option<Url> {
    if asset.scheme() != "https" || asset.host_str() != Some("github.com") {
        return None;
    }
    if asset.port().is_some_and(|port| port != 443)
        || !asset.username().is_empty()
        || asset.password().is_some()
        || asset.query().is_some()
        || asset.fragment().is_some()
    {
        return None;
    }
    let path = asset.path();
    if !path.contains("/releases/download/") {
        return None;
    }
    for escape in ["%2f", "%2F", "%5c", "%5C"] {
        if path.contains(escape) {
            return None;
        }
    }
    is_valid_mirror_host(host)
        .then(|| Url::parse(&format!("https://{host}/{asset}")).ok())
        .flatten()
}

/// Whether another host could plausibly succeed where this one failed.
/// Everything else — the signature, a missing target, an install error — is a
/// verdict about the update itself, not about the source.
fn is_retryable_failure(error: &UpdaterError) -> bool {
    matches!(
        error,
        UpdaterError::Reqwest(_)
            | UpdaterError::Network(_)
            | UpdaterError::Io(_)
            | UpdaterError::Http(_)
            | UpdaterError::UrlParse(_)
            | UpdaterError::Serialization(_)
            | UpdaterError::ReleaseNotFound
    )
}

/// Whether the failure came from reading metadata rather than from a network
/// transport, so the UI can say "could not read the update information".
fn is_manifest_failure(error: &UpdaterError) -> bool {
    matches!(
        error,
        UpdaterError::Serialization(_) | UpdaterError::ReleaseNotFound
    )
}

trait Retryable {
    fn retryable(&self) -> bool;
}

impl Retryable for UpdaterError {
    fn retryable(&self) -> bool {
        is_retryable_failure(self)
    }
}

/// Outcome of walking a source list, kept generic so the retry rules can be
/// tested without a network or a real plugin `Update`.
enum Sources<T, E> {
    /// A source produced a value, from the named host.
    Reached(T, String),
    /// Nothing was reached: the last error (if any) and every host tried.
    Exhausted(Option<E>, Vec<String>),
}

/// Try each source in order until one succeeds; stop early on a terminal
/// verdict (a signature or install error is not a source problem).
async fn try_sources<T, E, F>(sources: Vec<(Url, String)>, mut attempt: F) -> Sources<T, E>
where
    E: Retryable,
    F: FnMut(Url, String) -> Pin<Box<dyn Future<Output = Result<T, E>> + Send>>,
{
    let mut attempted: Vec<String> = Vec::new();
    let mut last_error: Option<E> = None;
    for (url, host) in sources {
        attempted.push(host.clone());
        match attempt(url, host.clone()).await {
            Ok(value) => return Sources::Reached(value, host),
            Err(error) => {
                if !error.retryable() {
                    return Sources::Exhausted(Some(error), attempted);
                }
                last_error = Some(error);
            }
        }
    }
    Sources::Exhausted(last_error, attempted)
}

/// Outcome of walking the manifest list.
enum Checks<T, E> {
    Found(T, String),
    /// The trusted endpoint says there is nothing to install.
    UpToDate,
    Failed(Option<E>, Vec<String>),
}

/// Try each manifest endpoint in order.
///
/// Only the first (canonical) endpoint may answer "there is no update": a
/// mirror's `204` must not be able to hide a real release. A candidate that
/// fails to parse — HTML, rate-limit page, truncated JSON — is just a dead
/// candidate and the next one is still tried, which the plugin's own
/// multi-endpoint loop does not do.
async fn try_checks<T, E, F>(sources: Vec<(Url, String)>, mut check: F) -> Checks<T, E>
where
    E: Retryable,
    F: FnMut(Url) -> Pin<Box<dyn Future<Output = Result<Option<T>, E>> + Send>>,
{
    let mut attempted: Vec<String> = Vec::new();
    let mut last_error: Option<E> = None;
    for (url, host) in sources {
        attempted.push(host.clone());
        let canonical = url.host_str() == Some("github.com");
        match check(url).await {
            Ok(Some(value)) => return Checks::Found(value, host),
            Ok(None) if canonical => return Checks::UpToDate,
            // A mirror claiming "no update" is a dead candidate, not an answer.
            Ok(None) => continue,
            Err(error) => {
                if !error.retryable() {
                    return Checks::Failed(Some(error), attempted);
                }
                last_error = Some(error);
            }
        }
    }
    Checks::Failed(last_error, attempted)
}

/// The manifest endpoints this build may use, from the app's own Tauri config
/// (the canonical `latest.json` first, then the compiled-in mirrors).
fn configured_endpoints<R: Runtime>(app: &AppHandle<R>) -> Vec<(Url, String)> {
    let mut endpoints: Vec<(Url, String)> = Vec::new();
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|value| value.as_array());
    for entry in configured.into_iter().flatten() {
        let Some(raw) = entry.as_str() else { continue };
        let Ok(url) = Url::parse(raw) else { continue };
        let Some(host) = url.host_str().map(str::to_string) else {
            continue;
        };
        endpoints.push((url, host));
    }
    endpoints.truncate(MAX_ENDPOINTS);
    endpoints
}

/// Download the announced asset, falling back to the configured mirrors when
/// the transport to `github.com` fails.
async fn download_with_fallback<R: Runtime>(
    app: &AppHandle<R>,
    update: &Update,
) -> Result<(Vec<u8>, String), (UpdaterError, Vec<String>)> {
    let version = update.version.clone();
    if let Some(reason) = canonical_asset_error(&update.download_url, &version) {
        // Fail before any request: the manifest named something this build
        // must not fetch.
        return Err((
            UpdaterError::Network(format!(
                "{reason} (announced version {version}, asset {})",
                update.download_url
            )),
            Vec::new(),
        ));
    }

    let canonical = update.download_url.clone();
    let mut sources: Vec<(Url, String)> = vec![(canonical.clone(), "github.com".to_string())];
    for host in configured_mirrors() {
        if let Some(url) = mirror_asset_url(&canonical, &host) {
            sources.push((url, host));
        }
    }

    let bytes = try_sources(sources, |url, host| {
        let app = app.clone();
        let version = version.clone();
        let mut candidate = update.clone();
        candidate.download_url = url;
        candidate.timeout = Some(DOWNLOAD_TIMEOUT);
        Box::pin(async move {
            let counters = Arc::new(Counters::default());
            // A new source starts its own progress: whatever the previous one
            // reported does not apply to these bytes.
            emit_progress(&app, "downloading", &host, 0, None, Some(&version));

            let chunk_app = app.clone();
            let chunk_host = host.clone();
            let chunk_version = version.clone();
            let chunk_counters = Arc::clone(&counters);
            let mut last_emit = Instant::now();
            let on_chunk = move |len: usize, content_length: Option<u64>| {
                chunk_counters.add(len as u64, content_length);
                if last_emit.elapsed() >= PROGRESS_INTERVAL {
                    last_emit = Instant::now();
                    let (downloaded, total) = chunk_counters.snapshot();
                    emit_progress(
                        &chunk_app,
                        "downloading",
                        &chunk_host,
                        downloaded,
                        total,
                        Some(&chunk_version),
                    );
                }
            };
            let finish_app = app.clone();
            let finish_host = host.clone();
            let finish_version = version.clone();
            let finish_counters = Arc::clone(&counters);
            let on_finish = move || {
                // Read the shared counter, not a captured copy: the download
                // has just finished, so reporting zero here would rewind the
                // progress bar right before "installing".
                let (downloaded, total) = finish_counters.snapshot();
                emit_progress(
                    &finish_app,
                    "downloading",
                    &finish_host,
                    downloaded,
                    total,
                    Some(&finish_version),
                );
            };

            candidate.download(on_chunk, on_finish).await
        })
    })
    .await;

    match bytes {
        Sources::Reached(bytes, host) => Ok((bytes, host)),
        Sources::Exhausted(error, attempted) => Err((
            error.unwrap_or_else(|| {
                UpdaterError::Network("no download source was configured".into())
            }),
            attempted,
        )),
    }
}

/// Shared byte counters for one download attempt.
#[derive(Default)]
struct Counters {
    downloaded: AtomicU64,
    /// Zero means "unknown"; a real `Content-Length` always wins.
    total: AtomicU64,
}

impl Counters {
    fn add(&self, bytes: u64, content_length: Option<u64>) {
        self.downloaded.fetch_add(bytes, Ordering::Relaxed);
        if let Some(total) = content_length {
            self.total.store(total, Ordering::Relaxed);
        }
    }

    fn snapshot(&self) -> (u64, Option<u64>) {
        let total = self.total.load(Ordering::Relaxed);
        (
            self.downloaded.load(Ordering::Relaxed),
            (total > 0).then_some(total),
        )
    }
}

fn failure_kind(error: &UpdaterError) -> &'static str {
    match error {
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) | UpdaterError::Io(_) => "transport",
        UpdaterError::Serialization(_)
        | UpdaterError::ReleaseNotFound
        | UpdaterError::UrlParse(_)
        | UpdaterError::Http(_) => "manifest",
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => "signature",
        UpdaterError::UnsupportedArch
        | UpdaterError::UnsupportedOs
        | UpdaterError::EmptyEndpoints
        | UpdaterError::InsecureTransportProtocol
        | UpdaterError::FailedToDetermineExtractPath
        | UpdaterError::InvalidHeaderValue(_)
        | UpdaterError::InvalidHeaderName(_)
        | UpdaterError::Semver(_)
        | UpdaterError::FormatDate
        | UpdaterError::Tauri(_) => "unavailable",
        _ => "install",
    }
}

/// Check, download (with mirror fallback) and install the signed update.
///
/// Returns `installed: false` when the app is already up to date.
#[tauri::command]
pub async fn install_available_update<R: Runtime>(
    app: AppHandle<R>,
) -> Result<InstallOutcome, InstallFailure> {
    if UPDATER_PUBLIC_KEY.map(str::trim).is_none_or(str::is_empty) {
        return Err(InstallFailure::new(
            "unavailable",
            "This build has no updater key, so it cannot install updates.",
        ));
    }

    // One install at a time: the renderer also guards its button, but the
    // authoritative bound belongs here, where the installer actually runs.
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(InstallFailure::new(
            "busy",
            "An update is already being installed.",
        ));
    }

    let result = run_install(&app).await;
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

async fn run_install<R: Runtime>(app: &AppHandle<R>) -> Result<InstallOutcome, InstallFailure> {
    let endpoints = configured_endpoints(app);
    if endpoints.is_empty() {
        return Err(InstallFailure::new(
            "unavailable",
            "This build has no update endpoint configured.",
        ));
    }

    let deadline = Instant::now() + METADATA_DEADLINE;
    let checks = try_checks(endpoints, |url| {
        let app = app.clone();
        Box::pin(async move {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(UpdaterError::Network(
                    "the update metadata deadline was reached".into(),
                ));
            }
            let updater = app
                .updater_builder()
                .timeout(remaining.min(MANIFEST_TIMEOUT))
                .endpoints(vec![url])
                .map_err(|error| {
                    UpdaterError::Network(format!("cannot use the update endpoint: {error}"))
                })?
                .build()?;
            updater.check().await
        })
    })
    .await;

    let update = match checks {
        Checks::Found(update, _host) => update,
        Checks::UpToDate => {
            return Ok(InstallOutcome {
                installed: false,
                target_version: None,
                source_host: None,
            })
        }
        Checks::Failed(None, attempted) => {
            return Err(
                InstallFailure::new("transport", "No update source was configured.")
                    .with_hosts(attempted),
            )
        }
        Checks::Failed(Some(error), attempted) => {
            // A manifest that could not be read is not an installation
            // failure, and not a network outage either.
            let kind = if is_manifest_failure(&error) {
                "manifest"
            } else {
                failure_kind(&error)
            };
            return Err(InstallFailure::new(kind, error.to_string()).with_hosts(attempted));
        }
    };

    let (bytes, source_host) =
        download_with_fallback(app, &update)
            .await
            .map_err(|(error, attempted)| {
                InstallFailure::new(failure_kind(&error), error.to_string()).with_hosts(attempted)
            })?;

    emit_progress(
        app,
        "installing",
        &source_host,
        bytes.len() as u64,
        None,
        Some(&update.version),
    );

    // The bytes are verified at this point. Installation is local: on Windows
    // the installer takes over and the process exits, elsewhere the caller
    // relaunches.
    update
        .install(&bytes)
        .map_err(|error| InstallFailure::new("install", error.to_string()))?;

    Ok(InstallOutcome {
        installed: true,
        target_version: Some(update.version.clone()),
        source_host: Some(source_host),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test url")
    }

    #[test]
    fn one_mirror_origin_is_a_host_and_optional_port() {
        for host in [
            "gh-proxy.com",
            "ghproxy.cn",
            "mirror.example.org:8443",
            "a-b.c-d.example",
        ] {
            assert!(is_valid_mirror_host(host), "{host} should be accepted");
        }
        // This list is mirrored in lib/update-mirrors.test.mjs and
        // scripts/distro-build.test.mjs: a value rejected by one side must be
        // rejected by all three.
        for host in [
            "",
            "localhost",
            "gh-proxy.com/",
            "https://gh-proxy.com",
            "gh-proxy.com/https://github.com",
            "user:pass@gh-proxy.com",
            "-bad.example.com",
            "bad-.example.com",
            "bad..example.com",
            "gh-proxy.com:abc",
            "gh-proxy.com:123456",
            "gh-proxy.com:0",
            "gh-proxy.com:65536",
            "with space.example.com",
        ] {
            assert!(!is_valid_mirror_host(host), "{host} should be rejected");
        }
    }

    #[test]
    fn mirrors_are_split_normalized_deduplicated_and_bounded() {
        assert_eq!(parse_mirrors(None), Vec::<String>::new());
        assert_eq!(parse_mirrors(Some("")), Vec::<String>::new());
        assert_eq!(
            parse_mirrors(Some(" Gh-Proxy.com , ghproxy.cn ,, https://nope")),
            vec!["gh-proxy.com", "ghproxy.cn"]
        );
        assert_eq!(
            parse_mirrors(Some("a.com,b.com,a.com,c.com")),
            vec!["a.com", "b.com", "c.com"]
        );
        assert_eq!(
            parse_mirrors(Some("a.com,b.com,c.com,d.com")),
            vec!["a.com", "b.com", "c.com"]
        );
    }

    #[test]
    fn only_the_announced_release_asset_may_be_downloaded() {
        let version = "0.7.801";
        let good = url(
            "https://github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/Pi.Agent_0.7.801_aarch64.dmg",
        );
        assert_eq!(canonical_asset_error(&good, version), None);
        assert_eq!(
            mirror_asset_url(&good, "gh-proxy.com").unwrap().as_str(),
            format!("https://gh-proxy.com/{good}")
        );

        // Shapes that can never be proxied at all: no mirror is ever asked.
        for (raw, reason) in [
            (
                "http://github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a.dmg",
                "not https",
            ),
            (
                "https://evil.example/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a.dmg",
                "not on github.com",
            ),
            (
                "https://github.com:8443/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a.dmg",
                "non-default port",
            ),
            (
                "https://user:pw@github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a.dmg",
                "credentials",
            ),
            (
                "https://github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a.dmg?x=1",
                "a query",
            ),
            (
                "https://github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a.dmg#x",
                "a query",
            ),
            (
                "https://github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/a%2Fb.dmg",
                "encoded path separator",
            ),
        ] {
            let asset = url(raw);
            let message = canonical_asset_error(&asset, version).expect("rejected");
            assert!(message.contains(reason), "{raw}: {message}");
            assert!(mirror_asset_url(&asset, "gh-proxy.com").is_none(), "{raw}");
        }

        // Shapes that are structurally a release asset but belong to another
        // repository or tag. The guard rejects them before any request is made,
        // so no candidate list (and no mirror URL) is ever built from them.
        for raw in [
            "https://github.com/other/repo/releases/download/v0.7.801/a.dmg",
            "https://github.com/hao3039032/pi-agent-desktop/releases/download/v0.6.0/a.dmg",
            "https://github.com/hao3039032/pi-agent-desktop/releases/latest/download/a.dmg",
            "https://github.com/hao3039032/pi-agent-desktop/releases/download/v0.7.801/../a.dmg",
        ] {
            let asset = url(raw);
            let message = canonical_asset_error(&asset, version).expect("rejected");
            assert!(message.contains("not this repository"), "{raw}: {message}");
        }
    }

    #[test]
    fn signature_failures_are_not_transport_failures() {
        for error in [
            UpdaterError::Network("Download request failed with status: 404".into()),
            UpdaterError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out",
            )),
        ] {
            assert!(is_retryable_failure(&error));
        }

        for error in [
            UpdaterError::SignatureUtf8("bad".into()),
            UpdaterError::SignedVersionMismatch {
                signed: "1.0.0".into(),
                announced: "9.9.9".into(),
            },
            UpdaterError::MissingSignedVersion,
            UpdaterError::TargetNotFound("darwin-aarch64".into()),
            UpdaterError::TargetsNotFound(vec!["darwin-aarch64".into()]),
        ] {
            assert!(!is_retryable_failure(&error), "{error}");
        }

        assert_eq!(
            failure_kind(&UpdaterError::MissingSignedVersion),
            "signature"
        );
        assert_eq!(
            failure_kind(&UpdaterError::ReleaseNotFound),
            "manifest",
            "a manifest that could not be read is not an install failure"
        );
        assert_eq!(failure_kind(&UpdaterError::EmptyEndpoints), "unavailable");
    }

    #[test]
    fn progress_counters_are_shared_with_the_finish_callback() {
        let counters = Counters::default();
        assert_eq!(counters.snapshot(), (0, None));
        counters.add(10, Some(100));
        counters.add(5, None);
        // The last `snapshot` is what the finish callback reports: it must see
        // the bytes the chunk callback added, not a stale zero.
        assert_eq!(counters.snapshot(), (15, Some(100)));
        counters.add(1, Some(200));
        assert_eq!(counters.snapshot(), (16, Some(200)));
    }

    fn transport_error() -> UpdaterError {
        UpdaterError::Network("transport".into())
    }

    fn signature_error() -> UpdaterError {
        UpdaterError::SignatureUtf8("bad signature".into())
    }

    #[tokio::test]
    async fn a_transport_failure_falls_through_to_the_next_source() {
        let sources = vec![
            (
                url("https://github.com/o/r/releases/download/v1/a"),
                "github.com".to_string(),
            ),
            (
                url("https://m1.example/https://github.com/o/r/releases/download/v1/a"),
                "m1.example".to_string(),
            ),
            (
                url("https://m2.example/https://github.com/o/r/releases/download/v1/a"),
                "m2.example".to_string(),
            ),
        ];
        let mut seen = Vec::new();
        let outcome: Sources<&'static str, UpdaterError> = try_sources(sources, |_url, host| {
            seen.push(host.clone());
            Box::pin(async move {
                if host == "m1.example" {
                    Ok("bytes")
                } else {
                    Err(transport_error())
                }
            })
        })
        .await;

        match outcome {
            Sources::Reached(value, host) => {
                assert_eq!(value, "bytes");
                assert_eq!(host, "m1.example");
            }
            Sources::Exhausted(..) => panic!("the second source should have been reached"),
        }
        // The third mirror is never contacted once one succeeds.
        assert_eq!(seen, vec!["github.com", "m1.example"]);
    }

    #[tokio::test]
    async fn a_signature_failure_stops_immediately_without_another_source() {
        let sources = vec![
            (
                url("https://github.com/o/r/releases/download/v1/a"),
                "github.com".to_string(),
            ),
            (
                url("https://m1.example/https://github.com/o/r/releases/download/v1/a"),
                "m1.example".to_string(),
            ),
        ];
        let mut seen = Vec::new();
        let outcome: Sources<Vec<u8>, UpdaterError> = try_sources(sources, |_url, host| {
            seen.push(host.clone());
            Box::pin(async move { Err::<Vec<u8>, _>(signature_error()) })
        })
        .await;

        match outcome {
            Sources::Exhausted(Some(error), attempted) => {
                assert_eq!(failure_kind(&error), "signature");
                assert_eq!(attempted, vec!["github.com"]);
            }
            _ => panic!("a signature verdict must end the run"),
        }
        assert_eq!(
            seen,
            vec!["github.com"],
            "no mirror may be tried after a verdict"
        );
    }

    #[tokio::test]
    async fn every_source_failing_reports_all_hosts() {
        let sources = vec![
            (
                url("https://github.com/o/r/releases/download/v1/a"),
                "github.com".to_string(),
            ),
            (url("https://m1.example/x"), "m1.example".to_string()),
        ];
        let outcome: Sources<Vec<u8>, UpdaterError> = try_sources(sources, |_url, _host| {
            Box::pin(async move { Err::<Vec<u8>, _>(transport_error()) })
        })
        .await;

        match outcome {
            Sources::Exhausted(Some(error), attempted) => {
                assert_eq!(failure_kind(&error), "transport");
                assert_eq!(attempted, vec!["github.com", "m1.example"]);
            }
            _ => panic!("expected every source to fail"),
        }
    }

    #[tokio::test]
    async fn a_broken_manifest_candidate_does_not_stop_the_next_one() {
        let sources = vec![
            (url("https://github.com/o/r/releases/latest/download/latest.json"), "github.com".to_string()),
            (url("https://m1.example/https://github.com/o/r/releases/latest/download/latest.json"), "m1.example".to_string()),
            (url("https://m2.example/https://github.com/o/r/releases/latest/download/latest.json"), "m2.example".to_string()),
        ];
        let mut seen = Vec::new();
        let outcome: Checks<&'static str, UpdaterError> = try_checks(sources, |url| {
            let host = url.host_str().unwrap_or_default().to_string();
            seen.push(host.clone());
            Box::pin(async move {
                match host.as_str() {
                    // An HTML error page / rate-limit answer is a parse error.
                    "github.com" | "m1.example" => Err(UpdaterError::Serialization(
                        serde_json::from_str::<serde_json::Value>("<html>blocked</html>")
                            .unwrap_err(),
                    )),
                    _ => Ok(Some("release")),
                }
            })
        })
        .await;

        match outcome {
            Checks::Found(value, host) => {
                assert_eq!(value, "release");
                assert_eq!(host, "m2.example");
            }
            _ => panic!("the last candidate should have answered"),
        }
        assert_eq!(seen, vec!["github.com", "m1.example", "m2.example"]);
    }

    #[tokio::test]
    async fn only_the_canonical_endpoint_can_say_there_is_no_update() {
        let canonical = vec![(
            url("https://github.com/o/r/releases/latest/download/latest.json"),
            "github.com".to_string(),
        )];
        let outcome: Checks<&'static str, UpdaterError> =
            try_checks(canonical, |_url| Box::pin(async move { Ok(None) })).await;
        assert!(matches!(outcome, Checks::UpToDate));

        let mirror_only = vec![(
            url("https://m1.example/https://github.com/o/r/releases/latest/download/latest.json"),
            "m1.example".to_string(),
        )];
        let mut seen = Vec::new();
        let outcome: Checks<&'static str, UpdaterError> = try_checks(mirror_only, |_url| {
            seen.push(());
            Box::pin(async move { Ok(None) })
        })
        .await;
        assert!(
            !matches!(outcome, Checks::UpToDate),
            "a mirror's 204 must not suppress a real update"
        );
        assert_eq!(seen.len(), 1);
    }

    #[tokio::test]
    async fn every_manifest_failing_reports_all_hosts_and_a_manifest_kind() {
        let sources = vec![
            (
                url("https://github.com/o/r/releases/latest/download/latest.json"),
                "github.com".to_string(),
            ),
            (url("https://m1.example/x"), "m1.example".to_string()),
        ];
        let outcome: Checks<&'static str, UpdaterError> = try_checks(sources, |_url| {
            Box::pin(async move { Err::<Option<&'static str>, _>(UpdaterError::ReleaseNotFound) })
        })
        .await;

        match outcome {
            Checks::Failed(Some(error), attempted) => {
                assert!(is_manifest_failure(&error));
                assert_eq!(attempted, vec!["github.com", "m1.example"]);
            }
            _ => panic!("expected every manifest candidate to fail"),
        }
    }
}
