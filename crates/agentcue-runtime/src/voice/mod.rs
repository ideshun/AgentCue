//! Native speech backends and orchestration under migration.
pub mod audio;
pub mod native;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakOptions {
    pub text: String,
    pub voice_profile: String,
    pub rate: f64,
    pub volume: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_backend: Option<String>,
    pub errors: Vec<String>,
}
impl SpeakResult {
    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            used_backend: None,
            errors: vec![error.into()],
        }
    }
}
#[derive(Clone)]
pub struct Cancellation {
    pub receiver: watch::Receiver<u64>,
    pub generation: u64,
}
impl Cancellation {
    pub fn cancelled(&self) -> bool {
        *self.receiver.borrow() != self.generation
    }
    pub async fn wait(&mut self) {
        while !self.cancelled() {
            if self.receiver.changed().await.is_err() {
                break;
            }
        }
    }
}

pub mod models;

pub mod backends;

pub mod policy;

pub mod service;
