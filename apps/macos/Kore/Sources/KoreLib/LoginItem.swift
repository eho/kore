import Foundation
import ServiceManagement

/// Manages "Launch at Login" via SMAppService (macOS 13+).
public struct LoginItem {

    /// Registers or unregisters the current app as a login item.
    ///
    /// - Parameter enabled: `true` to launch at login, `false` to remove.
    /// - Throws: If the SMAppService operation fails.
    public static func setLaunchAtLogin(enabled: Bool) throws {
        let service = SMAppService.mainApp
        if enabled {
            try service.register()
        } else {
            try service.unregister()
        }
    }

    /// Returns whether the app is currently registered as a login item.
    public static func getLaunchAtLogin() -> Bool {
        return SMAppService.mainApp.status == .enabled
    }
}
