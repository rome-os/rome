import SwiftUI
import UIKit

/// The app a widget tap names, as the open instance has it.
enum WidgetApps {
    enum Resolution: Equatable {
        case found(InstalledApp)
        /// The instance's list was read and has no such app.
        case gone
    }

    /// The app as a fresh read of the list has it: one deleted since the
    /// list was kept is gone, one built since is there. A read that fails
    /// leaves the list held, then the widget's own copy, to name it.
    @MainActor
    static func resolve(_ appId: String, in workspace: Workspace) async -> Resolution {
        let fetched: [InstalledApp]?
        do {
            let all = AppLinks.mine(try await workspace.backend.apps())
            await workspace.shelve(all)
            fetched = all
        } catch {
            fetched = nil
        }
        return decide(appId, fetched: fetched, held: workspace.apps, shelfName: AppShelfStore.shared?.read()?.apps.first { $0.id == appId }?.name)
    }

    /// `fetched`: the list just read, or nil when it could not be read.
    static func decide(_ appId: String, fetched: [InstalledApp]?, held: [InstalledApp] = [], shelfName: String?) -> Resolution {
        guard let fetched else {
            return .found(held.first { $0.id == appId } ?? InstalledApp(id: appId, displayName: shelfName))
        }
        return fetched.first { $0.id == appId }.map(Resolution.found) ?? .gone
    }
}

/// Whatever is presented over the app's window.
@MainActor
enum Presentations {
    /// Dismisses every sheet, cover and system sheet over the window, the
    /// screens' own included, and returns once they are gone.
    static func dismissAll() async {
        guard let root = rootController(), let top = root.presentedViewController else { return }
        // UIKit may skip a dismissal while another transition runs, and then
        // never calls back: wait for it, but never longer than a moment.
        if top.isBeingPresented || top.isBeingDismissed { try? await Task.sleep(for: .milliseconds(400)) }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let once = Once(done)
            root.dismiss(animated: true) { once.resume() }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                once.resume()
            }
        }
    }

    /// Resumes its continuation the first time only.
    @MainActor
    private final class Once {
        private var done: CheckedContinuation<Void, Never>?
        init(_ done: CheckedContinuation<Void, Never>) { self.done = done }
        func resume() {
            done?.resume()
            done = nil
        }
    }

    private static func rootController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        return (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
    }
}
