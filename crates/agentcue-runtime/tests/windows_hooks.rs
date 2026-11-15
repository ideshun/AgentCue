use agentcue_runtime::integrations::render_hook_files;
use serde_json::{Value, json};
#[test]
fn platform_templates_keep_json_and_shell_quoting_valid() {
    let templates: Value =
        serde_json::from_str(include_str!("../resources/hook-templates.json")).unwrap();
    for mut template in templates.as_array().unwrap().iter().cloned() {
        let id = template["id"].as_str().unwrap().to_owned();
        render_hook_files(
            &mut template,
            "C:\\Users\\O'Brien\\AgentCue App\\AgentCue.exe",
            "windows",
        )
        .unwrap();
        for file in template["files"].as_array().unwrap() {
            let text = file["content"].as_str().unwrap();
            assert!(!text.contains("/__AGENTCUE_EXECUTABLE__"));
            if id == "cline" {
                assert!(file["path"].as_str().unwrap().ends_with(".ps1"));
                assert!(text.contains("O''Brien"));
                assert_eq!(file["executable"], json!(false));
            } else {
                let value: Value = serde_json::from_str(text).unwrap();
                let encoded = value.to_string();
                assert!(encoded.contains("AgentCue App"));
                if id == "cursor" {
                    assert!(encoded.contains("& 'C:/Users/O''Brien"));
                }
                if id == "claude-code" {
                    assert!(
                        encoded.contains("\\\"shell\\\":\\\"bash\\\"")
                            || encoded.contains("\"shell\":\"bash\"")
                    );
                }
            }
        }
    }
}
