use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, Runtime,
};

pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit Kore", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    let icon = Image::from_path("icons/icon.png").unwrap_or_else(|_| {
        app.default_window_icon().unwrap().clone()
    });

    TrayIconBuilder::new()
        .menu(&menu)
        .icon(icon)
        .icon_as_template(true)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        // Ensure the window can appear over fullscreen apps each time we show it
                        configure_panel_for_menubar(&window);

                        // Position centered on the click X, just below the menu bar.
                        // The click position.y is within the menu bar; use it as the
                        // top anchor since macOS menu bar height varies by display scale.
                        let window_width = 280.0;
                        let x = position.x - (window_width / 2.0);
                        // Use the bottom of the menu bar area. The click Y is inside the
                        // menu bar, so add a small offset to clear it.
                        let menu_bar_bottom = position.y + 12.0;
                        let _ = window.set_position(PhysicalPosition::new(x, menu_bar_bottom));
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn configure_panel_for_menubar<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_window_ptr) = window.ns_window() {
            unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let ns_window = ns_window_ptr as *mut AnyObject;
                // CanJoinAllSpaces (1 << 0) | FullScreenAuxiliary (1 << 8)
                let behavior: isize = (1 << 0) | (1 << 8);
                let _: () = msg_send![&*ns_window, setCollectionBehavior: behavior];
                // NSStatusWindowLevel = 25
                let _: () = msg_send![&*ns_window, setLevel: 25_isize];
            }
        }
    }
}
