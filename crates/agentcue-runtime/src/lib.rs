//! Native monitoring runtime under migration; production entry point lives in the desktop host.

pub mod settings;

pub mod queries;

pub mod state;

pub mod control;

pub mod api;
pub mod integrations;

pub mod mcp;
pub mod paths;

pub mod mcp_client;

pub mod mcp_servers;

pub mod capture;

pub mod discovery;

pub mod monitor;

pub mod hooks;

pub mod hook_cli;

pub mod voice;
