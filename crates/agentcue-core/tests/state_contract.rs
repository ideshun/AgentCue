use agentcue_core::{EventType, TaskMachine, TaskState, resolve_transition};
use std::collections::BTreeSet;

const CONTRACT: &str = include_str!("fixtures/transitions.tsv");

fn header(name: &str) -> Vec<&str> {
    CONTRACT
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .expect("missing contract header")
        .split_whitespace()
        .collect()
}

#[test]
fn native_wire_values_match_the_shipping_schema() {
    assert_eq!(header("# states: "), TaskState::ALL.map(TaskState::as_str));
    assert_eq!(header("# events: "), EventType::ALL.map(EventType::as_str));
    let observations: BTreeSet<_> = EventType::ALL
        .into_iter()
        .filter(|value| value.is_observation())
        .map(EventType::as_str)
        .collect();
    assert_eq!(
        observations,
        header("# observations: ").into_iter().collect()
    );
    let terminal: BTreeSet<_> = TaskState::ALL
        .into_iter()
        .filter(|value| value.is_terminal_like())
        .map(TaskState::as_str)
        .collect();
    assert_eq!(terminal, header("# terminal-like: ").into_iter().collect());
}

#[test]
fn all_84_state_event_pairs_match_the_shipping_engine() {
    let mut seen = BTreeSet::new();
    for line in CONTRACT
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
    {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 3);
        assert!(
            seen.insert((fields[0], fields[1])),
            "duplicate pair: {line}"
        );
        let previous: TaskState = fields[0].parse().unwrap();
        let event: EventType = fields[1].parse().unwrap();
        let expected = if fields[2] == "-" {
            None
        } else {
            Some(fields[2].parse().unwrap())
        };
        assert_eq!(resolve_transition(previous, event), expected, "{line}");
        let mut machine = TaskMachine::new(previous);
        match (machine.apply(event), expected) {
            (Ok(actual), Some(next)) => assert_eq!(actual, next, "{line}"),
            (Err(error), None) => {
                assert_eq!(error.code(), "ILLEGAL_TRANSITION");
                assert_eq!(error.previous_state, previous);
                assert_eq!(error.event_type, event);
            }
            (actual, expected) => panic!("contract mismatch for {line}: {actual:?}, {expected:?}"),
        }
        assert_eq!(machine.state(), expected.unwrap_or(previous), "{line}");
    }
    assert_eq!(seen.len(), TaskState::ALL.len() * EventType::ALL.len());
    for state in TaskState::ALL {
        for event in EventType::ALL {
            assert!(seen.contains(&(state.as_str(), event.as_str())));
        }
    }
}

#[test]
fn resumed_task_finishes_and_requires_archive_before_reopening() {
    let mut task = TaskMachine::default();
    assert_eq!(
        task.apply(EventType::TaskStarted).unwrap(),
        TaskState::Running
    );
    assert_eq!(
        task.apply(EventType::TaskWaitingHuman).unwrap(),
        TaskState::WaitingHuman
    );
    // A restart restores the stored state, without manufacturing earlier notifications.
    let mut restored = TaskMachine::new(task.state());
    assert_eq!(
        restored.apply(EventType::HumanResponded).unwrap(),
        TaskState::Running
    );
    assert_eq!(
        restored.apply(EventType::TaskCompleted).unwrap(),
        TaskState::Completed
    );
    assert!(restored.apply(EventType::TaskStarted).is_err());
    assert_eq!(restored.state(), TaskState::Completed);
    assert_eq!(
        restored.apply(EventType::TaskArchived).unwrap(),
        TaskState::Idle
    );
    assert_eq!(
        restored.apply(EventType::TaskStarted).unwrap(),
        TaskState::Running
    );
    assert_eq!(task.state(), TaskState::WaitingHuman);
}

#[test]
fn unknown_wire_values_fail_instead_of_defaulting_to_idle() {
    for state in ["", "RUNNING", "paused", " running"] {
        assert!(state.parse::<TaskState>().is_err());
    }
    for event in ["", "started", "task.finished", "task.started "] {
        assert!(event.parse::<EventType>().is_err());
    }
}
