import Foundation
import WidgetKit

/// The app's side of the widget: it writes the open instance's apps and their
/// icons to the App Group, and what was opened last, then asks the widget to
/// redraw. A build with no App Group (Mac Catalyst) does nothing.
///
/// Only the open workspace writes. The model hands the shelf to each
/// workspace it opens and takes it back on a switch or sign-out; a list or
/// an icon that arrives after that, or after its account ended, is dropped,
/// so a late answer never fills the widget with another instance's apps or
/// brings them back after sign-out.
@MainActor
final class WidgetShelf {
    static let shared = WidgetShelf(store: .shared)

    let store: AppShelfStore?
    /// The workspace whose apps the widget shows, and its instance.
    private weak var owner: AnyObject?
    private var ownerInstance: String?
    /// Goes up whenever the owner changes or the shelf is cleared.
    private var generation = 0
    /// The icons being fetched for the last list; a newer list replaces it.
    private var icons: Task<Void, Never>?

    init(store: AppShelfStore?) {
        self.store = store
    }

    /// The workspace now open (nil: none). Writes begun by any other stop.
    func hand(to workspace: AnyObject?, instanceId: String?) {
        owner = workspace
        ownerInstance = workspace == nil ? nil : instanceId
        generation += 1
        icons?.cancel()
        icons = nil
    }

    /// Writes the list at once; the icons follow in the background, each
    /// one only when it is new or missing.
    func shelve(_ apps: [InstalledApp], instanceId: String, backend: RomeBackend, account: AccountStamp, by workspace: AnyObject) {
        guard let store, let owner, owner === workspace, ownerInstance == instanceId, account.isCurrent else { return }
        let ticket = generation
        let current = { [weak self] in
            guard let self else { return false }
            return self.generation == ticket && self.owner === workspace && self.ownerInstance == instanceId && account.isCurrent
        }
        let shelf = Shelf(instanceId: instanceId, apps: apps.map { app in
            ShelfApp(id: app.id, name: app.name, opens: app.fullHref != nil, hasIcon: Self.iconPath(app) != nil)
        })
        // Another instance's icons, and what they were drawn from, go here.
        if store.write(shelf) { Self.reload() }
        // An icon is fetched unless its file is there, drawn from this very
        // icon: the key is kept only once its file is written, so a fetch
        // that was cut short or failed is tried again next time.
        let wanted = apps.filter { app in
            Self.iconPath(app) != nil && store.iconKey(app.id) != Self.iconKey(app)
        }
        icons?.cancel()
        guard !wanted.isEmpty else {
            icons = nil
            return
        }
        icons = Task {
            var changed = false
            for app in wanted {
                guard let path = Self.iconPath(app), let data = try? await backend.apiFile(path: path, query: nil),
                      !Task.isCancelled, current(),
                      // Drawn as the Apps page draws it: many icons are SVGs,
                      // which only the app can draw.
                      let image = await AppIconImage.decode(data, side: AppShelfStore.iconPixels),
                      !Task.isCancelled, current()
                else { continue }
                changed = store.writeIcon(image, for: app.id, key: Self.iconKey(app)) || changed
            }
            if changed, current() { Self.reload() }
        }
    }

    /// The icons of the last list are in.
    func iconsWritten() async {
        await icons?.value
    }

    func recordOpen(appId: String, instanceId: String?) {
        guard let store, let instanceId, instanceId == ownerInstance else { return }
        store.recordOpen(instanceId: instanceId, appId: appId)
        Self.reload()
    }

    /// Signed out: the widget offers to make an app instead.
    func clear() {
        hand(to: nil, instanceId: nil)
        guard let store else { return }
        store.clear()
        Self.reload()
    }

    /// The icon through the instance's own client, as `AppIcon` loads it.
    private static func iconPath(_ app: InstalledApp) -> String? {
        guard let icon = app.iconUrl, icon.hasPrefix("/api/") else { return nil }
        return String(icon.dropFirst(4))
    }

    /// Which icon a file holds: a new URL or a new version brings another.
    static func iconKey(_ app: InstalledApp) -> String? {
        app.iconUrl.map { "\($0)#\(app.version ?? "")" }
    }

    private static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: AppShelfStore.widgetKind)
    }
}
