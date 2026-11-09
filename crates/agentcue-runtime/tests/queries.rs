use agentcue_runtime::{queries, settings};
use agentcue_store::migrate;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashMap;
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    migrate(&mut c).unwrap();
    c.execute_batch("INSERT INTO tools(tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES('fixture','Fixture','fixture','installed','t','t');").unwrap();
    c
}
fn add(c: &Connection, id: &str, state: &str, title: &str) {
    c.execute("INSERT INTO sessions(session_id,tool_id,title,current_state,updated_at) VALUES(?1,'fixture',?2,?3,'2026-11-08T00:00:00Z')",params![id,title,state]).unwrap();
}
#[test]
fn groups_use_complete_counts_and_independent_pagination() {
    let c = db();
    add(&c, "waiting", "waiting_human", "等待");
    for i in 0..220 {
        add(&c, &format!("done-{i:03}"), "completed", "完成");
    }
    let board = queries::board(&c, &HashMap::new(), &[]).unwrap();
    assert_eq!(board["groups"][0]["total"], 1);
    assert_eq!(board["groups"][0]["items"][0]["sessionId"], "waiting");
    assert_eq!(board["groups"][3]["total"], 220);
    let first = &board["groups"][3];
    let cursor = first["nextCursor"].as_str().unwrap();
    let query = HashMap::from([
        ("group".into(), "completed".into()),
        ("cursor".into(), cursor.into()),
    ]);
    let next = queries::board(&c, &query, &[]).unwrap();
    assert_eq!(next["groups"][0]["total"], 220);
    assert_ne!(next["groups"][0]["items"][0], first["items"][0]);
    let mut bad = query;
    bad.insert("toolId".into(), "other".into());
    assert!(queries::board(&c, &bad, &[]).is_err());
}
#[test]
fn search_treats_sql_wildcards_as_literal_text() {
    let c = db();
    add(&c, "one", "running", "100%_done");
    add(&c, "two", "running", "100XXdone");
    assert_eq!(queries::count(&c, &[], None, Some("%_")).unwrap(), 1);
    assert_eq!(
        queries::count(&c, &[], None, Some("' OR 1=1 --")).unwrap(),
        0
    );
}
#[test]
fn office_ignores_hidden_events_and_compares_actual_instants() {
    let c = db();
    add(&c, "visible", "running", "任务");
    add(&c, "hidden", "completed", "内部");
    c.execute(
        "UPDATE sessions SET visible=0 WHERE session_id='hidden'",
        [],
    )
    .unwrap();
    for (id, session, time) in [
        ("evt_a", "visible", "2026-11-08T09:00:00+08:00"),
        ("evt_b", "visible", "2026-11-08T02:00:00Z"),
        ("evt_hidden", "hidden", "2026-11-08T03:00:00Z"),
    ] {
        c.execute("INSERT INTO state_events(event_id,session_id,tool_id,event_type,actor,ts) VALUES(?1,?2,'fixture','anomaly','system',?3)",params![id,session,time]).unwrap();
    }
    let office = queries::office(&c, &[], &settings::defaults()).unwrap();
    assert_eq!(
        office["workstations"][0]["lastEventAt"],
        "2026-11-08T02:00:00.000Z"
    );
    assert_eq!(
        office["workstations"][0]["tasks"].as_array().unwrap().len(),
        1
    );
}
#[test]
fn history_snapshots_stay_outside_workflow_counts() {
    let c = db();
    let history = vec![
        json!({"kind":"history","sessionId":"h","toolId":"fixture","title":"历史","currentState":Value::Null,"updatedAt":"2026-11-08T00:00:00Z"}),
    ];
    let board = queries::board(&c, &HashMap::new(), &history).unwrap();
    assert_eq!(board["groups"][4]["total"], 1);
    assert_eq!(queries::count(&c, &[], None, None).unwrap(), 0);
}
