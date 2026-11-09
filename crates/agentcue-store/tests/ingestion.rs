use agentcue_store::{
    engine::{Checkpoint, Event, ingest_batch},
    migrate,
};
use rusqlite::Connection;
use serde_json::json;
fn db() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    migrate(&mut db).unwrap();
    db.execute_batch("INSERT INTO tools(tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES('fixture','Fixture','fixture','installed','t','t');").unwrap();
    db
}
fn event(id: &str, kind: &str, time: &str) -> Event {
    serde_json::from_value(json!({"eventId":id,"sessionId":"s","toolId":"fixture","eventType":kind,"occurredAt":time,"actor":"tool","schemaVersion":1,"payload":{}})).unwrap()
}
const START: &str = "2026-11-08T01:00:00.000Z";
const END: &str = "2026-11-08T01:00:03.000Z";
fn cp() -> Checkpoint {
    Checkpoint {
        source_path: "/synthetic/task.jsonl".into(),
        tool_id: "fixture".into(),
        file_identity: "inode-1".into(),
        byte_offset: 120,
        prefix_hash: "hash".into(),
        title: None,
        updated_at: END.into(),
        context: None,
    }
}
fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
#[test]
fn replay_is_silent_and_independent_calls_recover_database_state() {
    let mut db = db();
    let mut start = event("evt_start", "task.started", START);
    start.payload.insert("taskTitle".into(), json!("原始标题"));
    assert_eq!(
        ingest_batch(&mut db, std::slice::from_ref(&start), Some(&cp()), true)
            .unwrap()
            .len(),
        1
    );
    assert!(
        ingest_batch(&mut db, &[start], Some(&cp()), true)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ingest_batch(
            &mut db,
            &[event("evt_end", "task.completed", END)],
            None,
            true
        )
        .unwrap()
        .len(),
        1
    );
    let row: (String, String) = db
        .query_row("SELECT current_state,title FROM sessions", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(row, ("completed".into(), "原始标题".into()));
    assert_eq!(count(&db, "state_events"), 2);
}
#[test]
fn failed_checkpoint_rolls_back_state_receipts_and_events() {
    let mut db = db();
    let mut checkpoint = cp();
    checkpoint.byte_offset = -1;
    assert!(
        ingest_batch(
            &mut db,
            &[event("evt_start", "task.started", START)],
            Some(&checkpoint),
            true
        )
        .is_err()
    );
    for table in [
        "sessions",
        "state_events",
        "source_receipts",
        "source_checkpoints",
    ] {
        assert_eq!(count(&db, table), 0);
    }
    assert_eq!(
        ingest_batch(
            &mut db,
            &[event("evt_start", "task.started", START)],
            Some(&cp()),
            true
        )
        .unwrap()
        .len(),
        1
    );
}
#[test]
fn delayed_event_does_not_rewind_state_and_offsets_compare_as_instants() {
    let mut db = db();
    ingest_batch(
        &mut db,
        &[
            event("evt_start", "task.started", "2026-11-08T09:00:00+08:00"),
            event("evt_end", "task.completed", END),
        ],
        None,
        true,
    )
    .unwrap();
    assert!(
        ingest_batch(
            &mut db,
            &[event(
                "evt_late",
                "task.waiting_human",
                "2026-11-08T01:00:01Z"
            )],
            None,
            true
        )
        .unwrap()
        .is_empty()
    );
    let row: (String, String) = db
        .query_row(
            "SELECT event_type,reason FROM state_events WHERE event_id='evt_late'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("anomaly".into(), "out-of-order".into()));
    assert_eq!(
        db.query_row("SELECT current_state FROM sessions", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "completed"
    );
}
#[test]
fn illegal_transitions_are_received_once_and_hidden_tasks_stay_silent() {
    let mut db = db();
    let bad = event("evt_bad", "task.completed", START);
    assert!(
        ingest_batch(&mut db, std::slice::from_ref(&bad), None, true)
            .unwrap()
            .is_empty()
    );
    assert!(
        ingest_batch(&mut db, &[bad], None, true)
            .unwrap()
            .is_empty()
    );
    assert_eq!(count(&db, "audit_log"), 1);
    ingest_batch(
        &mut db,
        &[event("evt_start", "task.started", START)],
        None,
        true,
    )
    .unwrap();
    db.execute("UPDATE sessions SET visible=0", []).unwrap();
    assert!(
        ingest_batch(
            &mut db,
            &[event("evt_end", "task.completed", END)],
            None,
            true
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(count(&db, "state_events"), 1);
}
#[test]
fn invalid_event_in_batch_rolls_back_earlier_events() {
    let mut db = db();
    let mut bad = event("evt_bad", "task.completed", END);
    bad.actor = "invalid".into();
    assert!(
        ingest_batch(
            &mut db,
            &[event("evt_start", "task.started", START), bad],
            None,
            true
        )
        .is_err()
    );
    assert_eq!(count(&db, "sessions"), 0);
}

#[test]
fn source_reset_requires_the_current_checkpoint_and_metadata_rolls_back_on_failure() {
    use agentcue_store::engine::ingest_source_batch;
    let mut db = db();
    let initial = cp();
    ingest_batch(
        &mut db,
        &[event("evt_initial", "task.started", START)],
        Some(&initial),
        true,
    )
    .unwrap();
    let mut reset = initial.clone();
    reset.byte_offset = 12;
    reset.prefix_hash = "new-hash".into();
    let titles = vec![("s".into(), Some("修复后的标题".into()))];
    ingest_source_batch(
        &mut db,
        &[],
        &reset,
        Some(&initial),
        &titles,
        Some(("s", false)),
        true,
    )
    .unwrap();
    let row: (String, i64) = db
        .query_row(
            "SELECT title,visible FROM sessions WHERE session_id='s'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("修复后的标题".into(), 0));
    let stale = ingest_source_batch(
        &mut db,
        &[],
        &reset,
        Some(&initial),
        &[("s".into(), Some("不应覆盖".into()))],
        Some(("s", true)),
        true,
    );
    assert!(stale.is_err());
    let mut broken = reset.clone();
    broken.updated_at = "invalid-date".into();
    assert!(
        ingest_source_batch(
            &mut db,
            &[],
            &broken,
            Some(&reset),
            &[("s".into(), Some("不应覆盖".into()))],
            Some(("s", true)),
            true
        )
        .is_err()
    );
    let row: (String, i64) = db
        .query_row(
            "SELECT title,visible FROM sessions WHERE session_id='s'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("修复后的标题".into(), 0));
}
