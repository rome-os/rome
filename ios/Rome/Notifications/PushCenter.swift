import Foundation
import Observation
import UIKit
import UserNotifications

/// Rome Cloud's device list, which it sends this phone's pushes to.
@MainActor
protocol DeviceRegistry: AnyObject {
    /// Signed in to Rome Cloud, so a registration has a device to belong to.
    var canRegisterDevice: Bool { get }
    /// Goes up when the signed-in account ends, so a token sent for the last
    /// account is sent again for the next one.
    var accountGeneration: Int { get }
    func registerDevice(_ device: DeviceRegistration) async throws
    func unregisterDevice(token: String) async throws
}

/// The system's notification settings and APNs registration.
@MainActor
protocol NotificationSystem {
    func permission() async -> PushPermission
    /// Shows the system prompt when the guardian has not decided yet.
    func requestAuthorization() async
    func registerForRemoteNotifications()
}

/// Where the token last registered with Rome Cloud is kept, so sign-out can
/// remove it even before this launch's APNs callback arrives.
@MainActor
struct PushTokenStore {
    var load: () -> String?
    var save: (String?) -> Void

    static let keychain = PushTokenStore(
        load: { Keychain.value(String.self, for: "push.token") },
        save: { token in
            if let token { Keychain.set(token, for: "push.token") } else { Keychain.remove("push.token") }
        }
    )
}

/// Notification permission, the "Turn on" offer in Chat, and this phone's
/// registration with Rome Cloud. The token is never logged.
@MainActor
@Observable
final class PushCenter {
    private enum Defaults {
        static let promptDismissedAt = "pushPromptDismissedAt"
        static let enabled = "pushEnabled"
    }

    /// Unknown until the system answers.
    private(set) var permission: PushPermission?
    private(set) var promptDismissedAt: Date?
    /// The app's own switch, on unless the guardian turned it off in Settings.
    /// Off, this phone is not on Rome Cloud's list and no push arrives; the
    /// system permission is left as it is.
    private(set) var enabledByUser: Bool
    /// The guardian turned the switch on, but the system has notifications
    /// off for this app: only the Settings app can change that.
    private(set) var needsSystemSettings = false

    @ObservationIgnored private let registry: DeviceRegistry
    @ObservationIgnored private let system: NotificationSystem
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let store: PushTokenStore
    /// This launch's APNs token.
    @ObservationIgnored private var token: String?
    /// The token Rome Cloud accepted in this launch, and for which account.
    /// Each launch registers again, so a refused registration is retried on
    /// the next one; another account registers the same token again.
    @ObservationIgnored private var sentToken: String?
    @ObservationIgnored private var sentAccount: Int?

    init(
        registry: DeviceRegistry,
        system: NotificationSystem = LiveNotificationSystem(),
        defaults: UserDefaults = .standard,
        store: PushTokenStore = .keychain
    ) {
        self.registry = registry
        self.system = system
        self.defaults = defaults
        self.store = store
        promptDismissedAt = defaults.object(forKey: Defaults.promptDismissedAt) as? Date
        enabledByUser = defaults.object(forKey: Defaults.enabled) as? Bool ?? true
    }

    /// What the Settings switch shows: the system allows notifications and
    /// the guardian has not turned them off here.
    var isOn: Bool { permission == .on && enabledByUser }

    func offersPrompt(now: Date = .now) -> Bool {
        guard let permission, enabledByUser else { return false }
        return PushPrompt.shouldOffer(permission: permission, dismissedAt: promptDismissedAt, now: now)
    }

    /// On every launch and return to the foreground: read the permission and,
    /// when notifications are on, get a token.
    func launch() async {
        await refresh()
        if isOn { system.registerForRemoteNotifications() }
    }

    /// The guardian may change it in the Settings app at any time.
    func refresh() async {
        #if DEBUG
        if debugFrozen { return }
        #endif
        permission = await system.permission()
        if permission != .off { needsSystemSettings = false }
    }

    /// The Settings switch. On asks the system when it has not been asked,
    /// and registers this phone once allowed; when the system has said no, it
    /// stays off and points to the Settings app. Off removes this phone from
    /// Rome Cloud's list.
    func setEnabled(_ on: Bool) async {
        enabledByUser = on
        defaults.set(on, forKey: Defaults.enabled)
        if on {
            await refresh()
            if permission == .notSet { await system.requestAuthorization() }
            await launch()
            needsSystemSettings = permission == .off
        } else {
            needsSystemSettings = false
            if let registered = sentToken ?? store.load(), registry.canRegisterDevice {
                try? await registry.unregisterDevice(token: registered)
            }
            sentToken = nil
            store.save(nil)
        }
    }

    /// "Not now": the offer stays away for a week.
    func notNow(now: Date = .now) {
        promptDismissedAt = now
        defaults.set(now, forKey: Defaults.promptDismissedAt)
    }

    func didRegister(deviceToken: Data) async {
        token = DeviceRegistration.hex(deviceToken)
        await upload()
    }

    /// Sends this launch's token to Rome Cloud once it accepts one. A refusal
    /// stays quiet; the next launch or sign-in tries again.
    func upload() async {
        let account = registry.accountGeneration
        guard enabledByUser, let token, token != sentToken || account != sentAccount, registry.canRegisterDevice else { return }
        do {
            try await registry.registerDevice(.current(token: token))
            sentToken = token
            sentAccount = account
            store.save(token)
        } catch {
            // Rome Cloud may not know the route yet, or is unreachable.
        }
    }

    /// Removes this phone from Rome Cloud's list, then runs `clear`, which drops
    /// the credential the removal is sent with.
    func signOut(then clear: () async -> Void) async {
        if let registered = sentToken ?? store.load(), registry.canRegisterDevice {
            try? await registry.unregisterDevice(token: registered)
        }
        sentToken = nil
        sentAccount = nil
        store.save(nil)
        await clear()
    }

    #if DEBUG
    /// Snapshot runs show the offer whatever the Mac's settings say.
    /// Set by the snapshot runner, so the Mac's own permission does not
    /// replace the state it draws.
    @ObservationIgnored private var debugFrozen = false

    func debugSet(permission: PushPermission?, dismissedAt: Date? = nil, needsSystemSettings: Bool = false) {
        debugFrozen = true
        self.permission = permission
        promptDismissedAt = dismissedAt
        self.needsSystemSettings = needsSystemSettings
    }
    #endif
}

@MainActor
struct LiveNotificationSystem: NotificationSystem {
    func permission() async -> PushPermission {
        let status = await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
        switch status {
        case .notDetermined: return .notSet
        case .denied: return .off
        default: return .on
        }
    }

    func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }

    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }
}
