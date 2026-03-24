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
                        // Center the panel horizontally on the click point.
                        // For Y, the click lands inside the menu bar (~24pt tall on macOS).
                        // We need to clear the full menu bar height. On Retina displays
                        // position is in physical pixels, so use a generous offset.
                        let window_width = 280.0;
                        let scale = window.scale_factor().unwrap_or(2.0);
                        let menu_bar_height = 25.0 * scale; // 25 logical points
                        let x = position.x - (window_width / 2.0);
                        let y = menu_bar_height;
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}
