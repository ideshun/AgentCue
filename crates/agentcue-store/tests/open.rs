use agentcue_store::{MIGRATIONS, open::open_database};
use rusqlite::Connection;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "agentcue-store-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn backup_preserves_old_schema_and_wal_records_before_upgrade() {
    let dir = Temporary::new();
    let path = dir.0.join("synthetic.db");
    let old = Connection::open(&path).unwrap();
    old.execute_batch(MIGRATIONS[0]).unwrap();
    old.pragma_update(None, "user_version", 1).unwrap();
    old.pragma_update(None, "journal_mode", "WAL").unwrap();
    old.execute_batch("INSERT INTO tools(tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES('fixture','Fixture','fixture','installed','t','t');").unwrap();
    let upgraded = open_database(&path).unwrap();
    let backup = Connection::open(upgraded.upgrade_backup.as_ref().unwrap()).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM tools", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        upgraded
            .connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        upgraded
            .connection
            .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(backup);
    drop(upgraded);
    drop(old);
    let reopened = open_database(&path).unwrap();
    assert!(reopened.upgrade_backup.is_none());
}
#[test]
fn newer_database_is_left_unchanged() {
    let dir = Temporary::new();
    let path = dir.0.join("future.db");
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 99).unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    assert!(open_database(&path).is_err());
    assert_eq!(before, fs::read(&path).unwrap());
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
}
