import Foundation
import WidgetKit

/// The app's side of the widget: it writes the open instance's apps and their
/// icons to the App Group, and what was opened last, then asks the widget to
/// redraw. A build with no App Group (Mac Catalyst) does nothing.
@MainActor
enum WidgetShelf {
    static func shelve(_ apps: [InstalledApp], instanceId: String, backend: RomeBackend, store: AppShelfStore? = .shared) async {
        guard let store else { return }
        let shelf = Shelf(instanceId: instanceId, apps: apps.map { app in
            ShelfApp(id: app.id, name: app.name, opens: app.fullHref != nil, hasIcon: iconPath(app) != nil)
        })
        var changed = store.write(shelf)
        for app in apps {
            // Decoded as the Apps page decodes it: many icons are SVGs, which
            // only the app can draw.
            guard let path = iconPath(app), let data = try? await backend.apiFile(path: path, query: nil),
                  let image = await AppIconImage.decode(data, side: AppShelfStore.iconPixels)
            else { continue }
            changed = store.writeIcon(image, for: app.id) || changed
        }
        if changed { reload() }
    }

    static func recordOpen(appId: String, instanceId: String?) {
        guard let store = AppShelfStore.shared, let instanceId else { return }
        store.recordOpen(instanceId: instanceId, appId: appId)
        reload()
    }

    /// Signed out: the widget offers to make an app instead.
    static func clear() {
        guard let store = AppShelfStore.shared else { return }
        store.clear()
        reload()
    }

    /// The icon through the instance's own client, as `AppIcon` loads it.
    private static func iconPath(_ app: InstalledApp) -> String? {
        guard let icon = app.iconUrl, icon.hasPrefix("/api/") else { return nil }
        return String(icon.dropFirst(4))
    }

    private static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: AppShelfStore.widgetKind)
    }
}
