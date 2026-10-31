//! Per-child extension dialogs. Public IDs are host-generated so a reply from
//! an old window cannot answer a later child request with the same RPC id.
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use serde_json::{json, Value};

const LIMIT: usize = 64;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

struct Pending {
    child_id: String,
    method: String,
    record: Value,
    deadline: Instant,
}

#[derive(Default)]
pub(crate) struct SessionUi {
    pending: VecDeque<Pending>,
    statuses: Vec<Value>,
    widgets: Vec<Value>,
}

impl SessionUi {
    pub fn insert(&mut self, mut record: Value) -> (Option<Value>, Option<(String, String)>) {
        let Some(child_id) = record.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return (None, None) };
        let Some(method) = record.get("method").and_then(Value::as_str) else { return (None, None) };
        if !matches!(method, "confirm" | "select" | "input" | "editor") {
            match method {
                "setStatus" => {
                    if let Some(key) = record.get("statusKey").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 256) {
                        let text = record.get("statusText");
                        if text.is_none() || text.is_some_and(Value::is_null) {
                            update_keyed(&mut self.statuses, key, None);
                        } else if let Some(text) = text.and_then(Value::as_str).filter(|s| s.len() <= 65_536) {
                            update_keyed(&mut self.statuses, key, Some(json!({"key":key,"text":text})));
                        }
                    }
                }
                "setWidget" => {
                    if let Some(key) = record.get("widgetKey").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 256) {
                        let raw_lines = record.get("widgetLines");
                        if raw_lines.is_none() || raw_lines.is_some_and(Value::is_null) {
                            update_keyed(&mut self.widgets, key, None);
                        } else if let Some(lines) = raw_lines.and_then(Value::as_array).filter(|lines| lines.len() <= 512 && lines.iter().all(|v| v.as_str().is_some()) && lines.iter().filter_map(Value::as_str).map(str::len).sum::<usize>() <= 131_072) {
                            update_keyed(&mut self.widgets, key, Some(json!({"key":key,"lines":lines,"placement":record.get("widgetPlacement").and_then(Value::as_str).filter(|v| *v == "belowEditor").unwrap_or("aboveEditor")})));
                        }
                    }
                }
                _ => {}
            }
            return (Some(record), None)
        }
        let child_id = child_id.to_owned();
        let method = method.to_owned();
        // Duplicate child ids cannot be safely correlated; cancel the newcomer.
        if let Some(pos) = self.pending.iter().position(|p| p.child_id == child_id) {
            let previous = self.pending.remove(pos).unwrap();
            return (None, Some((child_id, previous.record["id"].as_str().unwrap_or("").to_owned())))
        }
        let evicted = if self.pending.len() == LIMIT { self.pending.pop_front().map(|p| (p.child_id, p.record["id"].as_str().unwrap_or("").to_owned())) } else { None };
        let id = format!("ui-{}", uuid::Uuid::new_v4());
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        let timeout = record.get("expiresAt").and_then(Value::as_u64)
            .map(|deadline| Duration::from_millis((deadline as u128).saturating_sub(now_ms).min(u64::MAX as u128) as u64))
            .unwrap_or(DEFAULT_TIMEOUT).min(DEFAULT_TIMEOUT);
        record["id"] = json!(id);
        self.pending.push_back(Pending { child_id, method, record: record.clone(), deadline: Instant::now() + timeout });
        (Some(record), evicted)
    }

    pub fn statuses(&self) -> Vec<Value> { self.statuses.clone() }
    pub fn widgets(&self) -> Vec<Value> { self.widgets.clone() }
    pub fn records(&self) -> Vec<Value> { self.pending.iter().map(|p| p.record.clone()).collect() }
    pub fn ids(&self) -> Vec<String> { self.pending.iter().filter_map(|p| p.record["id"].as_str().map(str::to_owned)).collect() }

    pub fn answer(&mut self, id: &str, response: &Value) -> Result<(String, Value), &'static str> {
        let Some(pos) = self.pending.iter().position(|p| p.record["id"] == id) else { return Err("extension UI request is no longer pending") };
        let p = &self.pending[pos];
        if Instant::now() >= p.deadline { return Err("extension UI request expired") }
        let obj = response.as_object().ok_or("response must be an object")?;
        let allowed = ["type", "id", "session", "value", "confirmed", "cancelled"];
        if obj.keys().any(|k| !allowed.contains(&k.as_str())) { return Err("unexpected response field") }
        let cancel = obj.get("cancelled") == Some(&Value::Bool(true));
        let value = obj.get("value").and_then(Value::as_str);
        let confirmed = obj.get("confirmed").and_then(Value::as_bool);
        let fields = usize::from(obj.contains_key("cancelled")) + usize::from(obj.contains_key("value")) + usize::from(obj.contains_key("confirmed"));
        if fields != 1 || !(cancel || (p.method == "confirm" && confirmed.is_some()) || (p.method != "confirm" && value.is_some())) {
            return Err("invalid extension UI response for request method")
        }
        if value.is_some_and(|v| v.len() > 1_048_576) { return Err("extension UI response is too large") }
        if p.method == "select" && value.is_some() && !p.record["options"].as_array().is_some_and(|options| options.iter().any(|v| v.as_str() == value)) {
            return Err("selection is not an offered option")
        }
        let payload = if cancel { json!({"cancelled": true}) } else if let Some(v) = confirmed { json!({"confirmed": v}) } else { json!({"value": value.unwrap()}) };
        Ok((self.pending.remove(pos).unwrap().child_id, payload))
    }

    pub fn expire(&mut self) -> Vec<(String, String)> {
        let mut expired = Vec::new();
        let now = Instant::now();
        self.pending.retain(|p| {
            if p.deadline <= now { expired.push((p.child_id.clone(), p.record["id"].as_str().unwrap_or("").to_owned())); false } else { true }
        });
        expired
    }
    pub fn drain(&mut self) -> Vec<String> { self.pending.drain(..).map(|p| p.child_id).collect() }
}

fn update_keyed(items: &mut Vec<Value>, key: &str, value: Option<Value>) {
    if let Some(index) = items.iter().position(|item| item["key"] == key) {
        if let Some(value) = value { items[index] = value; } else { items.remove(index); }
    } else if let Some(value) = value {
        if items.len() == LIMIT { items.remove(0); }
        items.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_and_widget_snapshots_follow_updates_and_removals() {
        let mut ui = SessionUi::default();
        ui.insert(json!({"id":"1","method":"setStatus","statusKey":"ext","statusText":"ready"}));
        ui.insert(json!({"id":"2","method":"setWidget","widgetKey":"panel","widgetLines":["a"],"widgetPlacement":"belowEditor"}));
        assert_eq!(ui.statuses(), vec![json!({"key":"ext","text":"ready"})]);
        assert_eq!(ui.widgets(), vec![json!({"key":"panel","lines":["a"],"placement":"belowEditor"})]);
        ui.insert(json!({"id":"3","method":"setStatus","statusKey":"ext"}));
        ui.insert(json!({"id":"4","method":"setWidget","widgetKey":"panel"}));
        assert!(ui.statuses().is_empty());
        assert!(ui.widgets().is_empty());
    }

    #[test]
    fn timeout_and_capacity_cancel_the_oldest() {
        let mut ui = SessionUi::default();
        let (first, _) = ui.insert(json!({"type":"extension_ui_request","id":"old","method":"input"}));
        let old_id = first.unwrap()["id"].as_str().unwrap().to_owned();
        for n in 0..63 { ui.insert(json!({"id":format!("{n}"),"method":"input"})); }
        let (_, evicted) = ui.insert(json!({"id":"new","method":"input"}));
        assert_eq!(evicted, Some(("old".to_owned(), old_id.clone())));
        assert!(ui.answer(&old_id, &json!({"value":"late"})).is_err());
        let (_, expired) = ui.insert(json!({"id":"expired","method":"input","expiresAt":1}));
        assert!(expired.is_some());
        assert!(ui.expire().iter().any(|(id, _)| id == "expired"));
        assert_eq!(ui.ids().len(), 63);
    }

    #[test]
    fn only_current_explicit_responses_are_accepted() {
        let mut ui = SessionUi::default();
        let (event, _) = ui.insert(json!({"type":"extension_ui_request","id":"child","method":"confirm"}));
        let id = event.unwrap()["id"].as_str().unwrap().to_string();
        assert!(ui.answer(&id, &json!({"value":"yes"})).is_err());
        assert_eq!(ui.answer(&id, &json!({"confirmed":false})).unwrap(), ("child".into(), json!({"confirmed":false})));
        assert!(ui.answer(&id, &json!({"confirmed":true})).is_err());
        let (next, _) = ui.insert(json!({"type":"extension_ui_request","id":"child","method":"confirm"}));
        assert_ne!(next.unwrap()["id"], id);
    }
}
