//! Schema migration for explicitly supplied connections; no default user-data access.
//! The future desktop host must back up an existing database before calling this API.
#![forbid(unsafe_code)]

use rusqlite::{Connection, TransactionBehavior};
use std::{error::Error, fmt};

pub mod engine;
pub mod open;

pub const SCHEMA_VERSION: i64 = 5;
pub const MIGRATIONS: [&str; 5] = [
    include_str!("../migrations/001.sql"),
    include_str!("../migrations/002.sql"),
    include_str!("../migrations/003.sql"),
    include_str!("../migrations/004.sql"),
    include_str!("../migrations/005.sql"),
];

#[derive(Debug)]
pub enum MigrationError {
    UnsupportedVersion(i64),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for MigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported database version: {version}")
            }
            Self::Sqlite(error) => write!(f, "database migration failed: {error}"),
        }
    }
}

impl Error for MigrationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for MigrationError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// Upgrade all pending schemas atomically. A failure rolls back DDL and user_version together.
pub fn migrate(connection: &mut Connection) -> Result<(), MigrationError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !(0..=SCHEMA_VERSION).contains(&current) {
        return Err(MigrationError::UnsupportedVersion(current));
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        transaction.execute_batch(sql)?;
        transaction.pragma_update(None, "user_version", index as i64 + 1)?;
    }
    transaction.commit()?;
    Ok(())
}
