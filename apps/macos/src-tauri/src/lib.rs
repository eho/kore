mod tray;

use tauri::Manager;

#[tauri::command]
fn get_daemon_status() -> String {
    // Placeholder: will be replaced by actual health-check IPC in MAC-003
    "idle".to_string()
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Hide the app from the Dock — this is a menu bar-only app
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::setup_tray(&app.handle())?;

            // Keep the panel window hidden until the tray icon is clicked
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();

                // Close the panel when it loses focus (click outside)
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = w.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_daemon_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
