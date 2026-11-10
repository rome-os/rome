import Foundation

/// Where a tapped push leads: an instance and one of its Concierge chats.
/// Rome Cloud adds `rome.instanceId`; the instance sends `chatId`.
struct PushTarget: Equatable, Sendable {
    var instanceId: String
    /// The Concierge chat the message was said in: `concierge` for the main
    /// chat, else a topic chat.
    var chatId: String?

    init(instanceId: String, chatId: String? = nil) {
        self.instanceId = instanceId
        self.chatId = chatId
    }

    /// Reads `rome: {instanceId, chatId?}` from a notification's payload.
    init?(userInfo: [AnyHashable: Any]) {
        guard let rome = userInfo["rome"] as? [String: Any],
              let instanceId = rome["instanceId"] as? String, !instanceId.isEmpty
        else { return nil }
        self.instanceId = instanceId
        self.chatId = (rome["chatId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// What a tapped push does once an instance is open.
enum PushRoute: Equatable {
    /// The push is for the open instance, or for one this account no longer
    /// lists: show the open instance's Concierge.
    case openConcierge
    /// The push is for another running instance: switch to it first.
    case switchTo(CloudInstance)
    /// The push is for another instance of this account that is not running:
    /// its stopped page, not the open instance's chat.
    case showStopped(CloudInstance)

    static func decide(_ target: PushTarget, currentInstanceID: String?, instances: [CloudInstance]) -> PushRoute {
        guard target.instanceId != currentInstanceID,
              let instance = instances.first(where: { $0.id == target.instanceId })
        else { return .openConcierge }
        return instance.isRunning ? .switchTo(instance) : .showStopped(instance)
    }
}

extension PushRoute {
    /// The topic chat a push opens: its `chatId` when that is one of the
    /// guardian's topic chats. The main chat or an unknown id gives nil, and
    /// the main Chat opens.
    static func topicChat(for target: PushTarget, topics: [ConciergeChat]) -> String? {
        guard let chatId = target.chatId, chatId != conciergeChatID,
              topics.contains(where: { $0.id == chatId && !$0.main })
        else { return nil }
        return chatId
    }
}

/// Asks the shell to show a Concierge chat: a topic chat, or the main one (nil).
struct ChatRequest: Equatable {
    let serial: Int
    let topicId: String?
}

/// The APNs environment this build's tokens belong to.
enum APNsEnvironment: String, Codable, Sendable {
    case sandbox
    case production

    /// Maps the `aps-environment` entitlement value: Debug signs with
    /// `development`, Release with `production`.
    init(entitlement: String?) {
        self = entitlement == "production" ? .production : .sandbox
    }

    /// This build's environment, from the same setting that signs the entitlement.
    static var current: APNsEnvironment {
        APNsEnvironment(entitlement: Bundle.main.object(forInfoDictionaryKey: "RomeAPNsEnvironment") as? String)
    }
}

/// The body of `POST /api/devices` on Rome Cloud.
struct DeviceRegistration: Encodable, Equatable, Sendable {
    var provider = "apns"
    var platform = "ios"
    var token: String
    var apnsEnvironment: APNsEnvironment
    var bundleId: String

    enum CodingKeys: String, CodingKey {
        case provider, platform, token
        case apnsEnvironment = "apns_environment"
        case bundleId = "bundle_id"
    }

    /// This build's registration for `token`.
    static func current(token: String) -> DeviceRegistration {
        DeviceRegistration(token: token, apnsEnvironment: .current, bundleId: Bundle.main.bundleIdentifier ?? "")
    }

    /// The hex form APNs and Rome Cloud use for a device token.
    static func hex(_ deviceToken: Data) -> String {
        deviceToken.map { String(format: "%02x", $0) }.joined()
    }
}

/// Whether this app may show notifications, as the guardian set it.
enum PushPermission: Equatable, Sendable {
    case notSet
    case on
    case off
}

/// When Chat offers to turn notifications on.
enum PushPrompt {
    static let snooze: TimeInterval = 7 * 86_400

    /// Only while the guardian has not decided, and not within a week of "Not now".
    static func shouldOffer(permission: PushPermission, dismissedAt: Date?, now: Date) -> Bool {
        guard permission == .notSet else { return false }
        guard let dismissedAt else { return true }
        return now.timeIntervalSince(dismissedAt) >= snooze
    }
}

/// Whether a push shows while the app is open, and which delivered ones a
/// chat clears. A chat is named by its store's id: `concierge` for the main
/// chat, which the server may name by its own id instead.
enum PushPresentation {
    /// A chat as the server names it: the main chat by its own id once known.
    static func serverChat(_ chat: String?, mainServerID: String?) -> String? {
        guard let chat else { return nil }
        return chat == conciergeChatID ? (mainServerID ?? conciergeChatID) : chat
    }

    /// The push's chat and `chat` are the same chat.
    static func sameChat(_ pushChat: String?, _ chat: String, mainServerID: String?) -> Bool {
        let push = pushChat ?? conciergeChatID
        if push == chat { return true }
        let isMain = { (id: String) in id == conciergeChatID || (mainServerID != nil && id == mainServerID) }
        return isMain(push) && isMain(chat)
    }

    /// Shown as a banner, with its sound, unless it is for the chat on screen:
    /// that one is read there already.
    static func shows(_ target: PushTarget?, visibleChat: String?, instanceID: String?, mainServerID: String?) -> Bool {
        guard let target, let visibleChat, target.instanceId == instanceID else { return true }
        return !sameChat(target.chatId, visibleChat, mainServerID: mainServerID)
    }

    /// Whether a delivered notification is one of `chat`'s, on this instance.
    static func belongs(_ userInfo: [AnyHashable: Any], to chat: String, instanceID: String?, mainServerID: String?) -> Bool {
        guard let target = PushTarget(userInfo: userInfo), target.instanceId == instanceID else { return false }
        return sameChat(target.chatId, chat, mainServerID: mainServerID)
    }
}
