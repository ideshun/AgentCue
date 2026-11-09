//! File lifecycle for an explicit database path. Never discovers a production directory.
use crate::{SCHEMA_VERSION, migrate};
use rusqlite::{Connection, MAIN_DB, OpenFlags};
use std::{
    error::Error,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub struct OpenedDatabase {
    pub connection: Connection,
    pub upgrade_backup: Option<PathBuf>,
}

fn reserve(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.sync_all()
}

/// Backup uses SQLite's online API, so committed WAL contents belong to the snapshot.
/// Refuses symlinks and newer schemas before changing journal mode or migrating.
pub fn open_database(path: &Path) -> Result<OpenedDatabase, Box<dyn Error + Send + Sync>> {
    let existed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => true,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "database path must be a regular file",
            )
            .into());
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            reserve(path)?;
            false
        }
        Err(error) => return Err(error.into()),
    };
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if !(0..=SCHEMA_VERSION).contains(&version) {
        return Err(crate::MigrationError::UnsupportedVersion(version).into());
    }
    let backup = if existed && version < SCHEMA_VERSION {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let mut name = path.as_os_str().to_os_string();
        name.push(format!(".v{version}.{stamp}.backup"));
        let target = PathBuf::from(name);
        reserve(&target)?;
        connection.backup(MAIN_DB, &target, None)?;
        Some(target)
    } else {
        None
    };
    migrate(&mut connection)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(OpenedDatabase {
        connection,
        upgrade_backup: backup,
    })
}
