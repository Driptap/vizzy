mod audio;
mod midi;
mod ollama;
mod render;

use tauri::Manager;

pub fn run() {
    // The Raspberry Pi's V3D driver corrupts WebKitGTK's GPU-accelerated partial
    // repaints — the UI renders cleanly but artifacts as soon as the mouse moves,
    // because :hover transitions trigger damage updates through the broken path.
    // Force the CPU compositing/repaint path. Must run before the webview inits.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(audio::AudioState::default())
        .manage(midi::MidiState::default())
        .manage(ollama::OllamaState::default())
        .manage(render::RenderState::default())
        .invoke_handler(tauri::generate_handler![
            audio::audio_start,
            audio::audio_stop,
            audio::audio_list_devices,
            audio::audio_set_beat_config,
            midi::midi_start,
            midi::midi_stop,
            midi::midi_input_count,
            ollama::ollama_status,
            ollama::ollama_install,
            ollama::ollama_start,
            render::engine::render_start,
            render::engine::render_state,
            render::engine::render_stage_patch,
            render::engine::render_stage_sprite,
            render::engine::render_stage_video,
            render::engine::render_stage_model,
            render::engine::render_stage_landscape,
            render::engine::render_stage_scene,
            render::engine::render_texture_share,
            render::engine::render_glow,
            render::window::render_master,
            render::window::render_master_fullscreen,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Vizzy")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<render::RenderState>().stop();
                app.state::<ollama::OllamaState>().stop();
                app.state::<audio::AudioState>().stop();
            }
        });
}
