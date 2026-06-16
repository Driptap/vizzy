mod audio;
mod midi;
mod ollama;
mod render;

use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

// The Updates window: a small webview loading the same bundle with a #updater
// hash so the renderer mounts <UpdaterWindow> instead of <App>. Opened from the
// tray (menu bar) entry; reused/refocused if already open.
fn show_updater_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("updater") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "updater",
        tauri::WebviewUrl::App("index.html#updater".into()),
    )
    .title("Vizzy — Updates")
    .inner_size(420.0, 320.0)
    .resizable(false)
    .build();
}

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
    let check_updates =
        MenuItemBuilder::with_id("menu_check_updates", "Check for Updates…").build(app)?;

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
            .item(&check_updates)
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
            .item(&check_updates)
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
        // In-app autoupdate (tauri-plugin-updater) + relaunch after install
        // (tauri-plugin-process). The JS side drives the check/install via the
        // platform layer; config + signing pubkey live in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(audio::AudioState::default())
        .manage(midi::MidiState::default())
        .manage(ollama::OllamaState::default())
        .manage(render::RenderState::default())
        .setup(|app| {
            let menu = build_app_menu(app.handle())?;
            app.handle().set_menu(menu)?;

            // Tray (menu bar) entry: left-click opens the Updates window; the
            // right-click menu gives an explicit Open + Quit for platforms where
            // left-click isn't a reliable activation.
            let tray_open =
                MenuItem::with_id(app, "tray_open", "Open Updates", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "tray_quit", "Quit Vizzy", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&tray_open, &tray_quit])?;
            TrayIconBuilder::with_id("vizzy-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Vizzy")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_open" => show_updater_window(app),
                    "tray_quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_updater_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "menu_open_workspace" => "open-workspace",
                "menu_save_workspace" => "save-workspace",
                "menu_reset_app" => "reset-app",
                "menu_check_updates" => "check-updates",
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
