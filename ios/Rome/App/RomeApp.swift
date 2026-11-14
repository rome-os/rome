import Combine
import SwiftUI
import UserNotifications

@main
struct RomeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    private var model: AppModel { delegate.model }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // On the window as soon as it exists, so the launch-to-opening
                // handoff already follows the setting.
                .onAppear { model.appearance.apply() }
                .task { await model.launch() }
                .onOpenURL { url in
                    guard let link = WidgetLink(url: url) else { return }
                    Task { await model.openFromWidget(link) }
                }
        }
    }
}

/// Owns the model, because pushes arrive here: the APNs token, and a tap on a
/// notification, also one that launches the app.
final class AppDelegate: NSObject, UIApplicationDelegate {
    let model = AppModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Before launch ends, so the tap that launched the app is delivered.
        UNUserNotificationCenter.current().delegate = self
        observeForeground()
        return true
    }

    /// UIKit's own notifications, not SwiftUI's scene phase: every trip away
    /// and back must reach the model, or the chat stays on what it showed.
    private func observeForeground() {
        let center = NotificationCenter.default
        let model = model
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { model.appWillResignActive() }
        }
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { model.appDidEnterBackground() }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { model.appDidBecomeActive() }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await model.push.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No token this launch; the next launch asks again.
    }
}

// The completion-handler forms, called on the main thread: the async forms
// return to UIKit off it, and UIKit aborts the app when a tap's handler does.
extension AppDelegate: @preconcurrency UNUserNotificationCenterDelegate {
    /// While the app is open, a push for the chat on screen shows nothing: the
    /// live events already put the reply there. Any other chat's shows its
    /// banner, plays its sound and stays in the list.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(model.presentsInForeground(notification.request.content.userInfo) ? [.banner, .sound, .list] : [])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let target = PushTarget(userInfo: response.notification.request.content.userInfo) {
            Task { await model.openFromPush(target) }
        }
        completionHandler()
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var today = Calendar.current.startOfDay(for: .now)

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            // Nothing under the update page, so a page that arrives with the app
            // never shows Chat through while it fades in.
            if model.update.blocking {
                Color.clear
            } else if model.phase == .ready, let workspace = model.workspace {
                MainShell(workspace: workspace)
                    .environment(\.assetLoader) { [backend = workspace.backend] path, width in try await backend.asset(path: path, width: width) }
                    .environment(\.apiFileLoader) { [backend = workspace.backend] path, query in try await backend.apiFile(path: path, query: query) }
                    .environment(\.instanceOrigin, workspace.backend.origin)
                    .id(ObjectIdentifier(workspace))
                    .transition(.opacity)
            } else if model.phase.isOpening {
                // The launch screen hands over to it without a jump.
                OpeningScreen()
                    .transition(.opacity)
            } else {
                LoginView()
                    .transition(.opacity)
            }
            if model.update.blocking {
                // Over everything, with no way past it but updating.
                UpdateScreen()
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        // Over the app, not the update page, so an upgrade that ends while
        // the game is open leaves it open.
        .fullScreenCover(item: Bindable(model).stackGame) { launch in
            StackGameScreen(launch: launch) { model.stackGame = nil }
                .environment(model)
                .presentationBackground(Palette.bg)
        }
        .animation(.easeInOut(duration: 0.3), value: model.update.blocking)
        .animation(.easeInOut(duration: 0.35), value: model.phase == .ready)
        .tint(Palette.primary)
        .environment(\.today, today)
        // Also sent when the app comes back after the day turned.
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged).receive(on: RunLoop.main)) { _ in
            today = Calendar.current.startOfDay(for: .now)
        }
        // Past this size the floating headers and cards stop fitting a phone.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        #if DEBUG
        .modifier(DynamicTypeOverride(size: model.dynamicTypeOverride))
        #endif
    }
}

#if DEBUG
/// Forces a text size only when the snapshot runner asks for one.
private struct DynamicTypeOverride: ViewModifier {
    let size: DynamicTypeSize?

    func body(content: Content) -> some View {
        if let size {
            content.dynamicTypeSize(size)
        } else {
            content
        }
    }
}
#endif
