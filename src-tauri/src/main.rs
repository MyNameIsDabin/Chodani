// Keep the console window hidden in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    chodani_lib::run()
}
