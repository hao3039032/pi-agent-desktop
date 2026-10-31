//! Read-only release metadata check. Installer verification remains in update_install.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use url::Url;

const REPO: &str = "hao3039032/pi-agent-desktop";
const PROJECT: &str = "pi-agent-desktop";
const INTERVAL: u64 = 7 * 24 * 60 * 60 * 1000;
const RETRY: u64 = 6 * 60 * 60 * 1000;
const API: &str = "https://api.github.com/repos/hao3039032/pi-agent-desktop/releases/latest";
const LATEST: &str = "https://github.com/hao3039032/pi-agent-desktop/releases/latest";
static CHECK_LOCK: Mutex<()> = Mutex::new(());

fn version(input: &str) -> Option<(String, semver::Version)> {
    let display = input.trim().trim_start_matches(['v', 'V']);
    let core_end = display.find(['-', '+']).unwrap_or(display.len());
    let core = &display[..core_end];
    let normalized = if core.split('.').count() == 2 { format!("{core}.0{}", &display[core_end..]) } else { display.to_string() };
    semver::Version::parse(&normalized).ok().map(|v| (display.to_string(), v))
}

fn base(status: &str) -> Value {
    json!({ "project": PROJECT, "name": PROJECT, "repository": REPO,
        "repositoryUrl": format!("https://github.com/{REPO}"), "currentVersion": env!("CARGO_PKG_VERSION"),
        "latestVersion": null, "releaseUrl": null, "updateAvailable": false, "releaseStatus": status })
}

fn release(tag: &str, raw_url: &str) -> Result<Value, String> {
    let (display, latest) = version(tag).ok_or("GitHub returned an invalid release version.")?;
    let current = version(env!("CARGO_PKG_VERSION")).ok_or("Invalid current version")?.1;
    let url = Url::parse(raw_url).map_err(|_| "GitHub returned an invalid release URL.")?;
    // Semver tags only contain URL-safe characters plus '+', which the
    // original encodeURIComponent contract represents as %2B.
    let expected = format!("/{REPO}/releases/tag/{}", tag.replace('+', "%2B"));
    if url.scheme() != "https" || url.host_str() != Some("github.com") || !url.username().is_empty()
        || url.password().is_some() || url.port().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.path().trim_end_matches('/') != expected {
        return Err("GitHub returned an invalid release URL.".into());
    }
    let mut value = base("available");
    value["latestVersion"] = json!(display);
    value["releaseUrl"] = json!(url.as_str());
    value["updateAvailable"] = json!(latest > current);
    Ok(value)
}

struct Response { status: u16, location: Option<String>, body: String }
type Fetch<'a> = dyn Fn(&str, Duration) -> Result<Response, String> + 'a;

enum Failure { Transport(String), Payload(String) }
fn api_response(response: Response, canonical: bool) -> Result<Value, Failure> {
    if response.status == 404 && canonical { return Ok(base("unpublished")); }
    if !(200..300).contains(&response.status) { return Err(Failure::Transport(format!("HTTP {}", response.status))); }
    let data: Value = serde_json::from_str(&response.body).map_err(|_| Failure::Transport("response was not JSON".into()))?;
    if data["draft"] == true || data["prerelease"] == true { return Err(Failure::Payload("GitHub returned a non-stable latest release.".into())); }
    let tag = data["tag_name"].as_str().ok_or_else(|| Failure::Payload("GitHub returned an invalid release payload.".into()))?;
    let url = data["html_url"].as_str().ok_or_else(|| Failure::Payload("GitHub returned an invalid release payload.".into()))?;
    release(tag, url).map_err(Failure::Payload)
}

fn fetch_release(fetch: &Fetch<'_>, mirrors: &[String]) -> Result<Value, String> {
    let start = Instant::now();
    let remaining = || Duration::from_secs(45).saturating_sub(start.elapsed());
    let api = |url: &str, canonical: bool| -> Result<Value, Failure> {
        let timeout = remaining().min(Duration::from_secs(15));
        if timeout.is_zero() { return Err(Failure::Transport("The update check ran out of time.".into())); }
        api_response(fetch(url, timeout).map_err(Failure::Transport)?, canonical)
    };
    let original = match api(API, true) {
        Ok(v) => return Ok(v),
        Err(Failure::Payload(e)) => return Err(e),
        Err(Failure::Transport(e)) => e,
    };
    if !remaining().is_zero() {
        if let Ok(response) = fetch(LATEST, remaining().min(Duration::from_secs(10))) {
            if let Some(location) = response.location {
                if let Ok(url) = Url::parse("https://github.com/").and_then(|base| base.join(&location)) {
                    let prefix = format!("/{REPO}/releases/tag/");
                    let releases = format!("/{REPO}/releases");
                    if url.scheme() == "https" && url.host_str() == Some("github.com") && url.username().is_empty()
                        && url.password().is_none() && url.port().is_none() && url.query().is_none() && url.fragment().is_none() {
                        if url.path().trim_end_matches('/') == releases { return Ok(base("unpublished")); }
                        if let Some(tag) = url.path().strip_prefix(&prefix) {
                            let decoded = tag.replace("%2B", "+").replace("%2b", "+");
                            let canonical = format!("https://github.com/{REPO}/releases/tag/{}", decoded.replace('+', "%2B"));
                            if let Ok(value) = release(&decoded, &canonical) { return Ok(value); }
                        }
                    }
                }
            }
        }
    }
    let mut payload_error = None;
    for mirror in mirrors {
        if remaining().is_zero() { break; }
        match api(&format!("https://{mirror}/{API}"), false) {
            Ok(v) => return Ok(v),
            Err(Failure::Payload(e)) => if payload_error.is_none() { payload_error = Some(e); },
            Err(Failure::Transport(_)) => {},
        }
    }
    Err(payload_error.unwrap_or(original))
}

fn iso(ms: u64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms.min(i64::MAX as u64) as i64).unwrap_or(DateTime::<Utc>::UNIX_EPOCH).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn check_with(agent_dir: &Path, refresh: bool, now: u64, fetch: &Fetch<'_>, mirrors: &[String]) -> Result<Value, String> {
    let path = agent_dir.join("pi-web-update-check.json");
    let state = fs::read(&path).ok().and_then(|v| serde_json::from_slice::<Value>(&v).ok()).filter(|v| v["version"] == 3).unwrap_or(json!({}));
    let checked = state["lastCheckedAt"][PROJECT].as_u64();
    let cached = &state["releases"][PROJECT];
    let cached = match cached["releaseStatus"].as_str() {
        Some("available") if cached["project"] == PROJECT => cached["latestVersion"].as_str().zip(cached["releaseUrl"].as_str()).and_then(|(tag, url)| {
            [tag.to_string(), format!("v{tag}"), format!("V{tag}")].iter().find_map(|candidate| release(candidate, url).ok())
        }),
        Some("unpublished") if cached["project"] == PROJECT => Some(base("unpublished")),
        _ => None,
    };
    let due = refresh || checked.is_none_or(|at| now < at || now - at >= INTERVAL);
    let mut updates = Vec::new();
    let mut errors = Vec::new();
    let component = if due {
        match fetch_release(fetch, mirrors) {
            Ok(value) => {
                if value["updateAvailable"] == true {
                    updates.push(json!({ "project": PROJECT, "name": PROJECT, "currentVersion": value["currentVersion"], "latestVersion": value["latestVersion"], "releaseUrl": value["releaseUrl"] }));
                }
                fs::create_dir_all(agent_dir).map_err(|e| e.to_string())?;
                let mut tmp = tempfile::Builder::new().prefix(".pi-web-update-check-").tempfile_in(agent_dir).map_err(|e| e.to_string())?;
                use std::io::Write;
                writeln!(tmp, "{}", json!({"version":3,"lastCheckedAt":{(PROJECT):now},"releases":{(PROJECT):value}})).map_err(|e| e.to_string())?;
                tmp.persist(&path).map_err(|e| e.to_string())?;
                value
            }
            Err(message) => { errors.push(json!({"project": PROJECT, "message": message})); base("error") }
        }
    } else { cached.unwrap_or_else(|| base("unknown")) };
    let next = if !errors.is_empty() { now.saturating_add(RETRY) } else if due { now.saturating_add(INTERVAL) } else { checked.unwrap_or(now).saturating_add(INTERVAL).max(now) };
    let mut response = json!({ "checkedAt": iso(now), "nextCheckAt": iso(next), "components": [component], "updates": updates });
    if !errors.is_empty() { response["errors"] = json!(errors); }
    Ok(response)
}

fn http_fetch(client: &reqwest::blocking::Client, url: &str, timeout: Duration) -> Result<Response, String> {
    let res = client.get(url).timeout(timeout).header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28").header("User-Agent", format!("pi-agent-desktop/{}", env!("CARGO_PKG_VERSION"))).send().map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let location = res.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_owned);
    use std::io::Read;
    let mut bytes = Vec::new();
    res.take(1_048_577).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 1_048_576 { return Err("Update metadata is too large".into()); }
    let body = String::from_utf8(bytes).map_err(|_| "Update metadata is not UTF-8".to_string())?;
    Ok(Response { status, location, body })
}

pub(crate) fn check(agent_dir: &Path, refresh: bool) -> Result<Value, String> {
    let _lock = CHECK_LOCK.lock().map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let fetch = |url: &str, timeout: Duration| http_fetch(&client, url, timeout);
    let mirrors = match std::env::var("PI_UPDATE_MIRRORS") {
        Ok(raw) => crate::update_install::parse_mirrors(Some(&raw.split_whitespace().collect::<Vec<_>>().join(","))),
        Err(_) => crate::update_install::configured_mirrors(),
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    check_with(agent_dir, refresh, now, &fetch, &mirrors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn local_fake_http_server_drives_real_http_client() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096]; let _ = socket.read(&mut request).unwrap();
            let body = json!({"tag_name":"v99.0.0", "html_url":format!("https://github.com/{REPO}/releases/tag/v99.0.0")}).to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let client = reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let response = http_fetch(&client, &format!("http://{addr}/fixture"), Duration::from_secs(5)).unwrap();
        assert_eq!(api_response(response, true).ok().unwrap()["latestVersion"], "99.0.0");
        server.join().unwrap();
    }
    #[test]
    fn canonical_404_and_malicious_payload_do_not_fall_back() {
        let calls = AtomicUsize::new(0);
        let unpublished = |_url: &str, _: Duration| { calls.fetch_add(1, Ordering::SeqCst); Ok(Response { status: 404, location: None, body: String::new() }) };
        assert_eq!(fetch_release(&unpublished, &["mirror.example".into()]).unwrap()["releaseStatus"], "unpublished");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let malicious = |_url: &str, _: Duration| { calls.fetch_add(1, Ordering::SeqCst); Ok(Response { status: 200, location: None, body: json!({"tag_name":"v99.0.0", "html_url":"https://github.com/evil/repo/releases/tag/v99.0.0"}).to_string() }) };
        assert!(fetch_release(&malicious, &["mirror.example".into()]).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn fixture_fallback_cache_and_repository_guard() {
        let dir = tempfile::tempdir().unwrap();
        let count = AtomicUsize::new(0);
        let fetch = |url: &str, _: Duration| {
            count.fetch_add(1, Ordering::SeqCst);
            if url == API { return Err("offline".into()); }
            if url == LATEST { return Ok(Response { status: 302, location: Some("https://github.com/evil/repo/releases/tag/v9.0.0".into()), body: String::new() }); }
            Ok(Response { status: 200, location: None, body: json!({"tag_name":"v99.0.0","html_url":format!("https://github.com/{REPO}/releases/tag/v99.0.0")}).to_string() })
        };
        let result = check_with(dir.path(), true, 1_700_000_000_000, &fetch, &["mirror.example".into()]).unwrap();
        assert_eq!(result["updates"][0]["latestVersion"], "99.0.0");
        assert_eq!(count.load(Ordering::SeqCst), 3);
        let cached = check_with(dir.path(), false, 1_700_000_000_001, &fetch, &[]).unwrap();
        assert_eq!(cached["components"][0]["updateAvailable"], true);
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert!(release("v99.0.0", "https://github.com/evil/repo/releases/tag/v99.0.0").is_err());
        assert!(release("v99.0.0", &format!("https://github.com/{REPO}/releases/tag/v99.0.0?x=1")).is_err());
        assert!(release("v99.0.0+build", &format!("https://github.com/{REPO}/releases/tag/v99.0.0%2Bbuild")).is_ok());
        assert!(release("v99.0.0+build", &format!("https://github.com/{REPO}/releases/tag/v99.0.0+build")).is_err());
    }
}
