mod audio;
mod midi;
mod ollama;
mod render;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

// Builds the native application menu. The custom File items carry stable ids
// the on_menu_event handler forwards to the renderer as `vizzy://menu`
// actions; the rest are predefined OS items so the standard shortcuts
// (Quit, Copy/Paste in the prompt boxes, …) keep working.
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open = MenuItemBuilder::with_id("menu_open_workspace", "Open Workspace…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("menu_save_workspace", "Save Workspace As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let reset = MenuItemBuilder::with_id("menu_reset_app", "Reset App…").build(app)?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Vizzy")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let file = SubmenuBuilder::new(app, "File")
            .item(&open)
            .item(&save)
            .separator()
            .item(&reset)
            .separator()
            .close_window()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .fullscreen()
            .build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file)
            .item(&edit)
            .item(&window)
            .build()
    }

    #[cfg(not(target_os = "macos"))]
    {
        let file = SubmenuBuilder::new(app, "File")
            .item(&open)
            .item(&save)
            .separator()
            .item(&reset)
            .separator()
            .quit()
            .build()?;
        MenuBuilder::new(app).item(&file).item(&edit).build()
    }
}

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
        .setup(|app| {
            let menu = build_app_menu(app.handle())?;
            app.handle().set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "menu_open_workspace" => "open-workspace",
                "menu_save_workspace" => "save-workspace",
                "menu_reset_app" => "reset-app",
                _ => return,
            };
            let _ = app.emit("vizzy://menu", action);
        })
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
