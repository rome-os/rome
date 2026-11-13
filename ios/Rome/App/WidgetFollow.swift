import SwiftUI
import UIKit

/// The app a widget tap names, as the open instance has it.
enum WidgetApps {
    enum Resolution: Equatable {
        case found(InstalledApp)
        /// The instance's list was read and has no such app.
        case gone
    }

    /// The app from the list held, else from a fresh read of the list (an
    /// app built since). A read that fails leaves the widget's own copy to
    /// name it: the app may well be there, and its page says if not.
    @MainActor
    static func resolve(_ appId: String, in workspace: Workspace) async -> Resolution {
        if let app = workspace.apps.first(where: { $0.id == appId }) { return .found(app) }
        let fetched: [InstalledApp]?
        do {
            let all = AppLinks.mine(try await workspace.backend.apps())
            await workspace.shelve(all)
            fetched = all
        } catch {
            fetched = nil
        }
        return decide(appId, fetched: fetched, shelfName: AppShelfStore.shared?.read()?.apps.first { $0.id == appId }?.name)
    }

    /// `fetched`: the list just read, or nil when it could not be read.
    static func decide(_ appId: String, fetched: [InstalledApp]?, shelfName: String?) -> Resolution {
        guard let fetched else { return .found(InstalledApp(id: appId, displayName: shelfName)) }
        return fetched.first { $0.id == appId }.map(Resolution.found) ?? .gone
    }
}

/// Whatever is presented over the app's window.
@MainActor
enum Presentations {
    /// Dismisses every sheet, cover and system sheet over the window, the
    /// screens' own included, and returns once they are gone.
    static func dismissAll() async {
        guard let root = rootController(), root.presentedViewController != nil else { return }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            root.dismiss(animated: true) { done.resume() }
        }
    }

    private static func rootController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        return (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
    }
}
