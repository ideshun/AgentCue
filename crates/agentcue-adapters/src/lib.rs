//! Format-specific adapters. The runtime receives normalized events and declared capabilities.
pub mod extract;
pub mod metadata;
pub mod text;

/// Hash the same JSON representation as the shipping JS implementation, including property order.
pub fn digest_json(value: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(js_json(value)))
}
pub fn digest(value: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn js_json(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Number(n) => ryu_js::Buffer::new().format(n.as_f64().unwrap()).into(),
        Value::Array(a) => format!("[{}]", a.iter().map(js_json).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            // JS enumerates canonical uint32 property names before other insertion-ordered keys.
            let mut numeric: Vec<_> = o
                .iter()
                .filter_map(|(k, v)| {
                    k.parse::<u32>()
                        .ok()
                        .filter(|n| *n != u32::MAX && n.to_string() == *k)
                        .map(|n| (n, k, v))
                })
                .collect();
            numeric.sort_by_key(|(n, _, _)| *n);
            let mut entries: Vec<_> = numeric
                .iter()
                .map(|(_, k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), js_json(v)))
                .collect();
            entries.extend(
                o.iter()
                    .filter(|(k, _)| {
                        !k.parse::<u32>()
                            .ok()
                            .is_some_and(|n| n != u32::MAX && n.to_string() == **k)
                    })
                    .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), js_json(v))),
            );
            format!("{{{}}}", entries.join(","))
        }
        _ => value.to_string(),
    }
}

pub mod hooks;
