//! Native task-state logic. The compatibility fixture is exported from the shipping TS core.
//! Persistence, event deduplication and notifications remain the host's responsibility.

#![forbid(unsafe_code)]

use std::{error::Error, fmt, str::FromStr};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskState {
    #[default]
    Idle,
    Running,
    WaitingHuman,
    Failed,
    Completed,
    Cancelled,
    Timeout,
}

impl TaskState {
    pub const ALL: [Self; 7] = [
        Self::Idle,
        Self::Running,
        Self::WaitingHuman,
        Self::Failed,
        Self::Completed,
        Self::Cancelled,
        Self::Timeout,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::WaitingHuman => "waiting_human",
            Self::Failed => "failed",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
        }
    }

    /// Match the existing ended_at convention: failure and timeout remain retryable.
    pub const fn is_terminal_like(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventType {
    TaskStarted,
    TaskWaitingHuman,
    HumanResponded,
    TaskFailed,
    TaskCompleted,
    TaskRetried,
    TaskArchived,
    TaskTimeout,
    TaskCancelled,
    HeartbeatLost,
    ToolDetected,
    Anomaly,
}

impl EventType {
    pub const ALL: [Self; 12] = [
        Self::TaskStarted,
        Self::TaskWaitingHuman,
        Self::HumanResponded,
        Self::TaskFailed,
        Self::TaskCompleted,
        Self::TaskRetried,
        Self::TaskArchived,
        Self::TaskTimeout,
        Self::TaskCancelled,
        Self::HeartbeatLost,
        Self::ToolDetected,
        Self::Anomaly,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TaskStarted => "task.started",
            Self::TaskWaitingHuman => "task.waiting_human",
            Self::HumanResponded => "human.responded",
            Self::TaskFailed => "task.failed",
            Self::TaskCompleted => "task.completed",
            Self::TaskRetried => "task.retried",
            Self::TaskArchived => "task.archived",
            Self::TaskTimeout => "task.timeout",
            Self::TaskCancelled => "task.cancelled",
            Self::HeartbeatLost => "heartbeat.lost",
            Self::ToolDetected => "tool.detected",
            Self::Anomaly => "anomaly",
        }
    }

    /// The host records observations without passing them through the state machine.
    pub const fn is_observation(self) -> bool {
        matches!(self, Self::ToolDetected | Self::Anomaly)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownWireValue(&'static str);

impl fmt::Display for UnknownWireValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unknown {}", self.0)
    }
}

impl Error for UnknownWireValue {}

impl FromStr for TaskState {
    type Err = UnknownWireValue;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|state| state.as_str() == value)
            .ok_or(UnknownWireValue("task state"))
    }
}

impl FromStr for EventType {
    type Err = UnknownWireValue;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|event| event.as_str() == value)
            .ok_or(UnknownWireValue("event type"))
    }
}

/// Resolve a transition without side effects. Observations and illegal edges return None.
pub const fn resolve_transition(state: TaskState, event: EventType) -> Option<TaskState> {
    use EventType::*;
    use TaskState::*;
    match (state, event) {
        (Idle, TaskStarted) => Some(Running),
        (Running, TaskWaitingHuman) => Some(WaitingHuman),
        (Running, TaskFailed) => Some(Failed),
        (Running, TaskCompleted) => Some(Completed),
        (Running | WaitingHuman, TaskCancelled) => Some(Cancelled),
        (Running | WaitingHuman, HeartbeatLost) | (WaitingHuman, TaskTimeout) => Some(Timeout),
        (WaitingHuman, HumanResponded) | (Failed | Timeout, TaskRetried) => Some(Running),
        (Failed | Timeout | Completed | Cancelled, TaskArchived) => Some(Idle),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IllegalTransition {
    pub previous_state: TaskState,
    pub event_type: EventType,
}

impl IllegalTransition {
    pub const fn code(self) -> &'static str {
        "ILLEGAL_TRANSITION"
    }
}

impl fmt::Display for IllegalTransition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} does not accept {}",
            self.previous_state.as_str(),
            self.event_type.as_str()
        )
    }
}

impl Error for IllegalTransition {}

/// One machine per task. Restore directly from persisted state without replaying side effects.
#[derive(Debug, Default)]
pub struct TaskMachine {
    state: TaskState,
}

impl TaskMachine {
    pub const fn new(state: TaskState) -> Self {
        Self { state }
    }

    pub const fn state(&self) -> TaskState {
        self.state
    }

    /// Call only after the host has committed the matching database transaction.
    pub fn apply(&mut self, event: EventType) -> Result<TaskState, IllegalTransition> {
        let next = resolve_transition(self.state, event).ok_or(IllegalTransition {
            previous_state: self.state,
            event_type: event,
        })?;
        self.state = next;
        Ok(next)
    }
}
