#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--mcp-stdio") {
        if let Err(error) = codex_orchestra_lib::run_mcp_stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else {
        codex_orchestra_lib::run();
    }
}
