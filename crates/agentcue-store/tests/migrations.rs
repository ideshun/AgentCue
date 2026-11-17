use agentcue_store::{MIGRATIONS, MigrationError, SCHEMA_VERSION, migrate};
use rusqlite::Connection;

fn version(db: &Connection) -> i64 {
    db.pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}

#[test]
fn every_legacy_version_upgrades_without_losing_rows() {
    for legacy in 0..=SCHEMA_VERSION {
        let mut db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        for sql in MIGRATIONS.iter().take(legacy as usize) {
            db.execute_batch(sql).unwrap();
        }
        db.pragma_update(None, "user_version", legacy).unwrap();
        if legacy > 0 {
            db.execute_batch("INSERT INTO tools(tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES('fixture','Fixture','fixture','installed','t','t'); INSERT INTO sessions(session_id,tool_id,title,current_state,updated_at) VALUES('s','fixture','保留标题','running','t'); INSERT INTO state_events(event_id,session_id,tool_id,event_type,actor,ts,payload) VALUES('evt_fixture','s','fixture','task.started','tool','t','{}');").unwrap();
        }
        migrate(&mut db).unwrap();
        migrate(&mut db).unwrap();
        assert_eq!(version(&db), SCHEMA_VERSION);
        for (sql, index) in [
            (
                "EXPLAIN QUERY PLAN SELECT event_id FROM state_events WHERE session_id='s' AND next_state='waiting_human' AND event_type IN ('task.waiting_human','task.failed','task.timeout') ORDER BY julianday(ts) DESC,rowid DESC LIMIT 1",
                "idx_events_session_attention",
            ),
            (
                "EXPLAIN QUERY PLAN SELECT 1 FROM notifications WHERE session_id='s' AND read=0 AND level='attention'",
                "idx_notifications_unread_attention",
            ),
        ] {
            let plan = db
                .prepare(sql)
                .unwrap()
                .query_map([], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert!(
                plan.contains(index),
                "missing indexed lookup after schema {legacy}: {plan}"
            );
        }
        db.prepare("SELECT context FROM source_checkpoints")
            .unwrap();
        if legacy > 0 {
            let row: (String, i64) = db
                .query_row(
                    "SELECT title,visible FROM sessions WHERE session_id='s'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(row, ("保留标题".into(), 1));
            assert_eq!(
                db.query_row("SELECT count(*) FROM state_events", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        assert!(db.execute("INSERT INTO sessions(session_id,tool_id,current_state,updated_at) VALUES('bad','missing','idle','t')", []).is_err());
    }
}

#[test]
fn future_schema_is_rejected_without_modifying_it() {
    let mut db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "user_version", 99).unwrap();
    assert!(matches!(
        migrate(&mut db),
        Err(MigrationError::UnsupportedVersion(99))
    ));
    assert_eq!(version(&db), 99);
    assert_eq!(
        db.query_row("SELECT count(*) FROM sqlite_master", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn failed_upgrade_rolls_back_all_pending_ddl_and_version() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE source_checkpoints(sentinel TEXT); INSERT INTO source_checkpoints VALUES('keep');").unwrap();
    assert!(migrate(&mut db).is_err());
    assert_eq!(version(&db), 0);
    assert_eq!(
        db.query_row("SELECT sentinel FROM source_checkpoints", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='tools'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
