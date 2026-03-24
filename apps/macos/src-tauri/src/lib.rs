mod tray;

use tauri::Manager;

#[tauri::command]
fn get_daemon_status() -> String {
    // Placeholder: will be replaced by actual health-check IPC in MAC-003
    "idle".to_string()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .setup(|app| {
            // Hide the app from the Dock — this is a menu bar-only app
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::setup_tray(&app.handle())?;

            // Keep the panel window hidden until the tray icon is clicked
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();

                // Make the panel appear on all workspaces including over fullscreen apps.
                // canJoinAllSpaces: show on every Space/desktop
                // FullScreenAuxiliary: coexist with fullscreen windows
                // NSStatusWindowLevel (25): float above fullscreen apps like native menu bar panels
                let _ = window.set_visible_on_all_workspaces(true);
                #[cfg(target_os = "macos")]
                {
                    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
                    let ptr = window.ns_window().expect("failed to get NSWindow");
                    unsafe {
                        let ns_window: *mut NSWindow = ptr.cast();
                        let behavior = (*ns_window).collectionBehavior()
                            | NSWindowCollectionBehavior::FullScreenAuxiliary
                            | NSWindowCollectionBehavior::MoveToActiveSpace;
                        (*ns_window).setCollectionBehavior(behavior);
                        // NSStatusWindowLevel = 25
                        (*ns_window).setLevel(25);
                    }
                }

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
