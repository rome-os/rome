import SwiftUI
import UserNotifications

@main
struct RomeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    private var model: AppModel { delegate.model }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.launch() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .background: model.workspace?.backend.events.pause()
                    case .active:
                        model.workspace?.backend.events.resume()
                        Task { await model.push.refresh() }
                    default: break
                    }
                }
        }
    }
}

/// Owns the model, because pushes arrive here: the APNs token, and a tap on a
/// notification, also one that launches the app.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Before launch ends, so the tap that launched the app is delivered.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await model.push.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No token this launch; the next launch asks again.
    }

    /// While the app is open the live events already update the chat, so a
    /// push shows no banner and plays no sound.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let target = PushTarget(userInfo: response.notification.request.content.userInfo) else { return }
        await model.openFromPush(target)
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            // Nothing under the update page, so a page that arrives with the app
            // never shows Chat through while it fades in.
            if model.update.blocking {
                Color.clear
            } else if model.phase == .ready, let workspace = model.workspace {
                MainShell(workspace: workspace)
                    .id(ObjectIdentifier(workspace))
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
        .animation(.easeInOut(duration: 0.3), value: model.update.blocking)
        .animation(.easeInOut(duration: 0.35), value: model.phase == .ready)
        .tint(Palette.primary)
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
