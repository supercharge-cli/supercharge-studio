//! Thinking (reasoning effort) support for the model tables the app writes to the agent
//! config. The agent offers and accepts a thinking level only for models whose catalog entry
//! says they support it. Models the app adds itself (`[model.studio-*]`, and `[model."<id>"]`
//! on agents too old to fetch the provider's model list) have no such entry, so the picker had
//! nothing to change. Writing `supports_reasoning_effort` and `reasoning_efforts` on those
//! tables gives them the same levels the agent's own provider setup would.
//!
//! The name rules mirror the agent's: they are only a guess, used when the provider's model
//! list says nothing.

use toml_edit::{value, Array, InlineTable, Item, Table};

/// Whether a model id looks like one that takes a thinking level.
pub fn thinking_from_id(id: &str) -> bool {
    let s = id.to_ascii_lowercase();
    let s = s.rsplit('/').next().unwrap_or(&s);
    if s.contains("reason") || s.contains("think") {
        return true;
    }
    if s.contains("non-reasoning") || (s.contains("instruct") && !s.contains("qwen3")) || s.contains("embed") {
        return false;
    }
    let tokens: Vec<&str> = s.split(['-', '_', ':', '.']).collect();
    let first = tokens.first().copied().unwrap_or("");
    let version_after = |prefix: &str| -> Option<f32> {
        let rest = s.strip_prefix(prefix)?;
        let num: String = rest.trim_start_matches(['-', '_']).chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        num.trim_end_matches('.').parse().ok()
    };
    if first.len() >= 2 && first.starts_with('o') && first[1..].chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    if let Some(v) = version_after("gpt") {
        return v >= 5.0 && !s.contains("chat-latest");
    }
    if s.starts_with("gpt-oss") {
        return true;
    }
    if s.starts_with("claude") {
        let nums: Vec<u32> = tokens.iter().filter_map(|t| t.parse().ok()).collect();
        return match nums.as_slice() {
            [3, 7, ..] => true,
            [major, ..] => *major >= 4 && *major < 100,
            [] => false,
        };
    }
    if let Some(v) = version_after("gemini") {
        return v >= 2.5;
    }
    if s.starts_with("deepseek-r") || s.contains("deepseek-reasoner") || s.contains("-r1") {
        return true;
    }
    if s.starts_with("qwq") || s.starts_with("qwen3") || s.starts_with("qvq") {
        return true;
    }
    s.starts_with("magistral") || s.starts_with("kimi-k2-thinking") || s.starts_with("glm-4.5") || s.starts_with("glm-4.6") || s.starts_with("glm-5")
}

/// Thinking levels for a model, weakest first and without "off"; empty when it takes none.
/// `known` is what the provider's model list said, when it said anything.
pub fn levels(id: &str, known: Option<bool>) -> &'static [&'static str] {
    if !known.unwrap_or_else(|| thinking_from_id(id)) {
        return &[];
    }
    let s = id.to_ascii_lowercase();
    let s = s.rsplit('/').next().unwrap_or(&s).to_owned();
    let gpt: Option<f32> = s.strip_prefix("gpt-").and_then(|r| {
        let n: String = r.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        n.trim_end_matches('.').parse().ok()
    });
    if gpt.is_some_and(|v| v >= 5.1) || s.contains("xhigh") || s.contains("-max") || s.contains("4.6") || s.contains("4.20") {
        return &["low", "medium", "high", "xhigh"];
    }
    &["low", "medium", "high"]
}

pub const SUPPORTS: &str = "supports_reasoning_effort";
pub const EFFORTS: &str = "reasoning_efforts";

/// Write the thinking keys on a model table: "off" plus `levels`, with "medium" marked as the
/// default so agents that ignore `default_reasoning_effort` for these tables start there rather
/// than at "off". With no levels nothing is written. Keys the table already has are left as
/// they are (the user's choice wins).
pub fn write(t: &mut Table, levels: &[&str]) -> bool {
    if levels.is_empty() || t.contains_key(SUPPORTS) || t.contains_key(EFFORTS) {
        return false;
    }
    let mut arr = Array::new();
    let mut off = InlineTable::new();
    off.insert("id", "off".into());
    off.insert("value", "none".into());
    off.insert("label", "Off".into());
    arr.push(off);
    for l in levels {
        let mut o = InlineTable::new();
        o.insert("value", (*l).into());
        if *l == "medium" {
            o.insert("default", true.into());
        }
        arr.push(o);
    }
    t.insert(SUPPORTS, value(true));
    t.insert(EFFORTS, Item::Value(arr.into()));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_think() {
        for id in ["glm-5.3-flash", "glm-5.3", "GLM-4.6", "zenllm/glm-5", "o3-mini", "gpt-5", "gpt-6-sol", "claude-sonnet-4-5", "claude-3-7-sonnet", "gemini-2.5-pro", "deepseek-r1", "qwen3-coder", "my-thinking-model"] {
            assert!(thinking_from_id(id), "{id}");
        }
        for id in ["glm-4", "gpt-4o", "gpt-5-chat-latest", "claude-3-5-sonnet", "gemini-2.0-flash", "llama-3.3-70b-instruct", "text-embed-3", "deepseek-v4-flash", ""] {
            assert!(!thinking_from_id(id), "{id}");
        }
    }

    #[test]
    fn level_sets() {
        assert_eq!(levels("glm-5.3-flash", None), ["low", "medium", "high"]);
        assert_eq!(levels("gpt-5.6-sol", None), ["low", "medium", "high", "xhigh"]);
        assert_eq!(levels("claude-opus-4.6", None), ["low", "medium", "high", "xhigh"]);
        assert!(levels("gpt-4o", None).is_empty());
        // The provider's own answer beats the name guess, both ways.
        assert_eq!(levels("house-model", Some(true)), ["low", "medium", "high"]);
        assert!(levels("glm-5.3-flash", Some(false)).is_empty());
    }

    #[test]
    fn writes_off_then_levels_and_keeps_user_keys() {
        let mut t = Table::new();
        assert!(write(&mut t, levels("glm-5.3-flash", None)));
        let s = t.to_string();
        assert!(s.contains("supports_reasoning_effort = true"), "{s}");
        assert!(s.contains(r#"reasoning_efforts = [{ id = "off", value = "none", label = "Off" }, { value = "low" }, { value = "medium", default = true }, { value = "high" }]"#), "{s}");
        let mut mine = Table::new();
        mine.insert(SUPPORTS, value(false));
        assert!(!write(&mut mine, &["low"]));
        assert_eq!(mine.get(SUPPORTS).and_then(Item::as_bool), Some(false));
        assert!(!mine.contains_key(EFFORTS));
        let mut none = Table::new();
        assert!(!write(&mut none, &[]));
        assert!(none.is_empty());
    }
}
