#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "static-preview")]
    pi_agent_desktop_lib::run_static_preview();
    #[cfg(not(feature = "static-preview"))]
    pi_agent_desktop_lib::run();
}
