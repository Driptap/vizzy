mod audio;
mod midi;
mod ollama;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(audio::AudioState::default())
        .manage(midi::MidiState::default())
        .manage(ollama::OllamaState::default())
        .invoke_handler(tauri::generate_handler![
            audio::audio_start,
            audio::audio_stop,
            audio::audio_list_devices,
            midi::midi_start,
            midi::midi_stop,
            midi::midi_input_count,
            ollama::ollama_status,
            ollama::ollama_install,
            ollama::ollama_start,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Vizzy")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<ollama::OllamaState>().stop();
                app.state::<audio::AudioState>().stop();
            }
        });
}
