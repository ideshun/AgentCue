use agentcue_adapters::{
    extract::{self, Context, SourceContext},
    text,
};
use serde_json::{Value, json};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/contract.json")).unwrap()
}
fn context_without_nulls(mut value: Value) -> Value {
    value.as_object_mut().unwrap().retain(|_, v| !v.is_null());
    value
}
#[test]
fn incremental_extraction_matches_shipping_ids_titles_and_contexts() {
    for case in fixture()["sources"].as_array().unwrap() {
        let ctx = &case["ctx"];
        let mut context: SourceContext =
            serde_json::from_value(ctx.get("context").cloned().unwrap_or_else(|| json!({})))
                .unwrap();
        for batch in case["batches"].as_array().unwrap() {
            let result = extract::extract(
                batch["rows"].as_array().unwrap(),
                &case["manifest"],
                Context {
                    tool_id: ctx["toolId"].as_str().unwrap(),
                    project: ctx["project"].as_str().unwrap(),
                    session_key: ctx["sessionKey"].as_str().unwrap(),
                    source_path: ctx["sourcePath"].as_str(),
                    title: ctx["title"].as_str(),
                    context,
                },
            );
            let actual = serde_json::to_value(&result).unwrap();
            assert_eq!(
                actual["events"], batch["expected"]["events"],
                "{}",
                case["name"]
            );
            assert_eq!(
                actual["titles"], batch["expected"]["titles"],
                "{}",
                case["name"]
            );
            assert_eq!(
                context_without_nulls(actual["context"].clone()),
                context_without_nulls(batch["expected"]["context"].clone()),
                "{}",
                case["name"]
            );
            context = result.context;
        }
    }
}
#[test]
fn user_text_filtering_and_reference_shortening_match_shipping_behavior() {
    let fixture = fixture();
    for case in fixture["titles"].as_array().unwrap() {
        let expected = &case["expected"];
        let actual = text::user_titles(&case["row"]);
        let actual = actual
            .map(|(title, speech)| {
                let mut v = json!({"title":title});
                if let Some(s) = speech {
                    v["speechTitle"] = json!(s);
                }
                v
            })
            .unwrap_or(Value::Null);
        assert_eq!(&actual, expected, "{}", case["row"]);
    }
    for case in fixture["references"].as_array().unwrap() {
        let actual = text::compact_references(case["input"].as_str().unwrap());
        assert_eq!(json!(actual), case["expected"]);
        assert_eq!(text::compact_references(&actual), actual);
    }
}

#[test]
fn official_hooks_match_shipping_identity_times_titles_and_validation() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/hooks.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let result = agentcue_adapters::hooks::normalize(
            case["tool"].as_str().unwrap(),
            &case["input"],
            case["options"]["phase"].as_str(),
            case["options"]["receivedAt"].as_str().unwrap(),
        );
        if case["error"] == true {
            assert!(result.is_err(), "{case}");
            continue;
        }
        let events = result.unwrap();
        assert_eq!(
            serde_json::to_value(&events).unwrap(),
            case["expected"],
            "{case}"
        );
        for event in events {
            let mode = if event.tool_id == "claude-code"
                || event.tool_id == "cursor"
                || (event.tool_id == "codebuddy" && event.session_id.contains(":turn:"))
            {
                "turn"
            } else {
                "session"
            };
            assert!(agentcue_adapters::hooks::parse(&json!({"mode":mode,"event":event})).is_ok());
        }
    }
}
