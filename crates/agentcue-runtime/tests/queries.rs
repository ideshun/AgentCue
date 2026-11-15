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

#[test]
fn connection_evidence_excludes_manual_hidden_and_paused_events() {
    let c = db();
    add(&c, "visible", "running", "private task title");
    add(&c, "hidden", "completed", "hidden task");
    c.execute(
        "UPDATE sessions SET visible=0 WHERE session_id='hidden'",
        [],
    )
    .unwrap();
    for (id, session, kind, actor, time) in [
        (
            "evt_start",
            "visible",
            "task.started",
            "tool",
            "2026-11-08T09:00:00+08:00",
        ),
        (
            "evt_later",
            "visible",
            "task.started",
            "tool",
            "2026-11-08T02:00:00Z",
        ),
        (
            "evt_manual",
            "visible",
            "task.completed",
            "human",
            "2026-11-08T03:00:00Z",
        ),
        (
            "evt_mcp",
            "visible",
            "task.completed",
            "mcp",
            "2026-11-08T04:00:00Z",
        ),
        (
            "evt_hidden",
            "hidden",
            "task.completed",
            "tool",
            "2026-11-08T05:00:00Z",
        ),
        (
            "evt_anomaly",
            "visible",
            "anomaly",
            "tool",
            "2026-11-08T06:00:00Z",
        ),
    ] {
        c.execute("INSERT INTO state_events(event_id,session_id,tool_id,event_type,actor,ts) VALUES(?1,?2,'fixture',?3,?4,?5)",params![id,session,kind,actor,time]).unwrap();
    }
    let mut config = settings::defaults();
    let tools = queries::tools(&c, &[], &config).unwrap();
    assert_eq!(
        tools[0]["milestones"],
        json!([{"eventType":"task.started","ts":"2026-11-08T02:00:00.000Z"}])
    );
    assert!(!tools[0].to_string().contains("private task title"));
    config["privacy"]["sessionFileRead"] = json!(false);
    assert_eq!(
        queries::tools(&c, &[], &config).unwrap()[0]["milestones"],
        json!([])
    );
    config["privacy"]["sessionFileRead"] = json!(true);
    config["scan"]["ignoredToolIds"] = json!(["fixture"]);
    assert_eq!(
        queries::tools(&c, &[], &config).unwrap()[0]["milestones"],
        json!([])
    );
}

#[test]
fn date_sort_pagination_binds_the_full_filter() {
    let c = db();
    for id in ["a", "b", "c"] {
        add(&c, id, "completed", id);
    }
    c.execute(
        "UPDATE sessions SET updated_at='2026-11-09T00:00:00Z' WHERE session_id='c'",
        [],
    )
    .unwrap();
    let mut query = HashMap::from([
        ("group".into(), "completed".into()),
        ("limit".into(), "1".into()),
        ("order".into(), "asc".into()),
        ("from".into(), "2026-11-08T00:00:00Z".into()),
        ("to".into(), "2026-11-08T23:59:59Z".into()),
    ]);
    let first = queries::board(&c, &query, &[]).unwrap();
    assert_eq!(first["groups"][0]["total"], 2);
    assert_eq!(first["groups"][0]["items"][0]["sessionId"], "a");
    query.insert(
        "cursor".into(),
        first["groups"][0]["nextCursor"].as_str().unwrap().into(),
    );
    let second = queries::board(&c, &query, &[]).unwrap();
    assert_eq!(second["groups"][0]["items"][0]["sessionId"], "b");
    query.insert("order".into(), "desc".into());
    assert!(queries::board(&c, &query, &[]).is_err());
}

#[test]
fn mixed_terminal_states_merge_chronologically_across_pages() {
    let c = db();
    for (id, state, time) in [
        ("a", "completed", "2026-11-08T09:00:00+08:00"),
        ("b", "cancelled", "2026-11-08T01:00:00Z"),
        ("c", "idle", "2026-11-08T02:00:00Z"),
        ("hidden", "completed", "2026-11-08T03:00:00Z"),
    ] {
        add(&c, id, state, id);
        c.execute(
            "UPDATE sessions SET updated_at=?1,visible=?2 WHERE session_id=?3",
            params![time, i64::from(id != "hidden"), id],
        )
        .unwrap();
    }
    for (order, expected) in [("asc", vec!["a", "b", "c"]), ("desc", vec!["c", "b", "a"])] {
        let mut query = HashMap::from([
            ("group".into(), "completed".into()),
            ("limit".into(), "1".into()),
            ("order".into(), order.into()),
        ]);
        let mut actual = vec![];
        loop {
            let page = queries::board(&c, &query, &[]).unwrap();
            assert_eq!(page["groups"][0]["total"], 3);
            let item = &page["groups"][0]["items"][0];
            assert!(item.get("sortTime").is_none());
            actual.push(item["sessionId"].as_str().unwrap().to_owned());
            if let Some(cursor) = page["groups"][0]["nextCursor"].as_str() {
                query.insert("cursor".into(), cursor.into());
            } else {
                break;
            }
        }
        assert_eq!(actual, expected);
    }
}

#[test]
fn board_time_window_uses_an_index_without_a_temporary_sort() {
    let c = db();
    let plan = queries::rows(&c, "EXPLAIN QUERY PLAN SELECT session_id FROM sessions WHERE visible=1 AND current_state='completed' AND julianday(updated_at)>=julianday('2026-11-01T00:00:00Z') ORDER BY julianday(updated_at) DESC,session_id DESC LIMIT 21", vec![]).unwrap();
    let plan = serde_json::to_string(&plan).unwrap();
    assert!(plan.contains("idx_sessions_board_state"), "{plan}");
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
}
