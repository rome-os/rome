import Foundation
import Testing
@testable import Rome

@Suite struct PushPayloadTests {
    @Test func readsInstanceAndChat() {
        let target = PushTarget(userInfo: ["aps": ["alert": "Done"], "rome": ["instanceId": "i-1", "chatId": "c-9"]])
        #expect(target == PushTarget(instanceId: "i-1", chatId: "c-9"))
    }

    @Test func chatIsOptional() {
        #expect(PushTarget(userInfo: ["rome": ["instanceId": "i-1"]]) == PushTarget(instanceId: "i-1"))
        #expect(PushTarget(userInfo: ["rome": ["instanceId": "i-1", "chatId": ""]])?.chatId == nil)
    }

    @Test func ignoresPushesWithoutAnInstance() {
        #expect(PushTarget(userInfo: ["aps": ["alert": "Hi"]]) == nil)
        #expect(PushTarget(userInfo: ["rome": ["chatId": "c-1"]]) == nil)
        #expect(PushTarget(userInfo: ["rome": ["instanceId": ""]]) == nil)
        #expect(PushTarget(userInfo: ["rome": "i-1"]) == nil)
    }

    private let instances = [
        CloudInstance(id: "a", name: "A", slug: "a", origin: "https://a.example", status: "running"),
        CloudInstance(id: "b", name: "B", slug: "b", origin: "https://b.example", status: "running"),
        CloudInstance(id: "c", name: "C", slug: "c", origin: "https://c.example", status: "stopped"),
    ]

    @Test func routesToTheTappedInstance() {
        #expect(PushRoute.decide(PushTarget(instanceId: "a"), currentInstanceID: "a", instances: instances) == .openConcierge)
        #expect(PushRoute.decide(PushTarget(instanceId: "b"), currentInstanceID: "a", instances: instances) == .switchTo(instances[1]))
    }

    @Test func unknownOrStoppedInstanceStaysOnTheOpenOne() {
        #expect(PushRoute.decide(PushTarget(instanceId: "gone"), currentInstanceID: "a", instances: instances) == .openConcierge)
        #expect(PushRoute.decide(PushTarget(instanceId: "c"), currentInstanceID: "a", instances: instances) == .openConcierge)
    }
}

@Suite struct DeviceRegistrationTests {
    @Test func environmentFollowsTheEntitlement() {
        #expect(APNsEnvironment(entitlement: "development") == .sandbox)
        #expect(APNsEnvironment(entitlement: "production") == .production)
        #expect(APNsEnvironment(entitlement: nil) == .sandbox)
    }

    /// Tests run a Debug build, which signs for the APNs sandbox.
    @Test func debugBuildRegistersForSandbox() throws {
        let registration = DeviceRegistration.current(token: "ab01")
        #expect(registration.apnsEnvironment == .sandbox)
        #expect(registration.bundleId == Bundle.main.bundleIdentifier)
        #expect(registration.bundleId.hasPrefix("cc.romeos.mobile"))
    }

    @Test func bodyMatchesRomeCloud() throws {
        for (environment, wire) in [(APNsEnvironment.sandbox, "sandbox"), (.production, "production")] {
            let registration = DeviceRegistration(token: "ab01", apnsEnvironment: environment, bundleId: "cc.romeos.mobile")
            let body = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(registration)) as? [String: String])
            #expect(body == [
                "provider": "apns", "platform": "ios", "token": "ab01",
                "apns_environment": wire, "bundle_id": "cc.romeos.mobile",
            ])
        }
    }

    @Test func tokenIsLowercaseHex() {
        #expect(DeviceRegistration.hex(Data([0x00, 0xAB, 0x0F, 0xFF])) == "00ab0fff")
    }

    @Test func requestCarriesTheDeviceCredential() throws {
        let request = CloudAuth.deviceRequest(origin: URL(string: "https://romeos.cc")!, accessToken: "cred", method: "DELETE", body: Data("{}".utf8))
        #expect(request.url?.absoluteString == "https://romeos.cc/api/devices")
        #expect(request.httpMethod == "DELETE")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer cred")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }
}

@Suite struct PushPromptTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func offeredOnlyWhileUndecided() {
        #expect(PushPrompt.shouldOffer(permission: .notSet, dismissedAt: nil, now: now))
        #expect(!PushPrompt.shouldOffer(permission: .on, dismissedAt: nil, now: now))
        #expect(!PushPrompt.shouldOffer(permission: .off, dismissedAt: nil, now: now))
    }

    @Test func notNowWaitsSevenDays() {
        let day: TimeInterval = 86_400
        #expect(!PushPrompt.shouldOffer(permission: .notSet, dismissedAt: now, now: now))
        #expect(!PushPrompt.shouldOffer(permission: .notSet, dismissedAt: now - 7 * day + 60, now: now))
        #expect(PushPrompt.shouldOffer(permission: .notSet, dismissedAt: now - 7 * day, now: now))
        #expect(PushPrompt.shouldOffer(permission: .notSet, dismissedAt: now - 30 * day, now: now))
    }

    @MainActor @Test func notNowIsRemembered() {
        let defaults = UserDefaults(suiteName: "push-prompt-\(UUID())")!
        let first = PushCenter(registry: FakeRegistry(), system: FakeSystem(.notSet), defaults: defaults, store: .memory())
        first.notNow(now: now)
        let second = PushCenter(registry: FakeRegistry(), system: FakeSystem(.notSet), defaults: defaults, store: .memory())
        #expect(second.promptDismissedAt == now)
    }

    @MainActor @Test func authorizedNeverOffers() async {
        let center = PushCenter(registry: FakeRegistry(), system: FakeSystem(.on), defaults: UserDefaults(suiteName: "push-\(UUID())")!, store: .memory())
        #expect(!center.offersPrompt())
        await center.launch()
        #expect(!center.offersPrompt())
    }
}

@MainActor @Suite struct PushCenterTests {
    private func center(_ registry: FakeRegistry, _ system: FakeSystem = FakeSystem(.on), store: PushTokenStore = .memory()) -> PushCenter {
        PushCenter(registry: registry, system: system, defaults: UserDefaults(suiteName: "push-\(UUID())")!, store: store)
    }

    @Test func registersAfterPermissionAndOncePerToken() async {
        let registry = FakeRegistry()
        let system = FakeSystem(.notSet)
        let push = center(registry, system)
        await push.launch()
        #expect(system.registered == 0)
        system.promptAnswer = .on
        await push.setEnabled(true)
        #expect(system.prompted == 1)
        #expect(system.registered == 1)
        await push.didRegister(deviceToken: Data([0xAB]))
        await push.didRegister(deviceToken: Data([0xAB]))
        await push.didRegister(deviceToken: Data([0xCD]))
        #expect(registry.calls == ["register ab", "register cd"])
    }

    @Test func refusedRegistrationIsRetried() async {
        let registry = FakeRegistry()
        registry.fails = true
        let push = center(registry)
        await push.didRegister(deviceToken: Data([0xAB]))
        registry.fails = false
        await push.upload()
        #expect(registry.calls == ["register ab", "register ab"])
    }

    @Test func waitsForCloudSignIn() async {
        let registry = FakeRegistry()
        registry.signedIn = false
        let push = center(registry)
        await push.didRegister(deviceToken: Data([0xAB]))
        #expect(registry.calls.isEmpty)
        registry.signedIn = true
        await push.upload()
        #expect(registry.calls == ["register ab"])
    }

    @Test func signOutRemovesTheDeviceBeforeClearing() async {
        let registry = FakeRegistry()
        let push = center(registry)
        await push.didRegister(deviceToken: Data([0xAB]))
        await push.signOut { registry.calls.append("clear") }
        #expect(registry.calls == ["register ab", "unregister ab", "clear"])
    }

    @Test func signOutRemovesATokenFromAnEarlierLaunch() async {
        let registry = FakeRegistry()
        let store = PushTokenStore.memory("ee")
        let push = center(registry, store: store)
        registry.fails = true
        await push.signOut { registry.calls.append("clear") }
        #expect(registry.calls == ["unregister ee", "clear"])
        #expect(store.load() == nil)
    }
}

@MainActor @Suite struct NotificationSwitchTests {
    private func center(_ registry: FakeRegistry, _ system: FakeSystem, defaults: UserDefaults = UserDefaults(suiteName: "push-\(UUID())")!) -> PushCenter {
        PushCenter(registry: registry, system: system, defaults: defaults, store: .memory())
    }

    @Test func onWhenUndecidedAsksAndStaysOnWhenAllowed() async {
        let registry = FakeRegistry()
        let system = FakeSystem(.notSet)
        system.promptAnswer = .on
        let push = center(registry, system)
        await push.setEnabled(true)
        #expect(system.prompted == 1)
        #expect(push.isOn)
        #expect(system.registered == 1)
        #expect(!push.needsSystemSettings)
    }

    @Test func onWhenUndecidedSpringsBackWhenDenied() async {
        let system = FakeSystem(.notSet)
        system.promptAnswer = .off
        let push = center(FakeRegistry(), system)
        await push.setEnabled(true)
        #expect(system.prompted == 1)
        #expect(!push.isOn)
        #expect(system.registered == 0)
        #expect(push.needsSystemSettings)
    }

    @Test func onWhenTheSystemSaidNoPointsToSettingsWithoutAsking() async {
        let system = FakeSystem(.off)
        let push = center(FakeRegistry(), system)
        await push.setEnabled(true)
        #expect(system.prompted == 0)
        #expect(!push.isOn)
        #expect(push.needsSystemSettings)
        // Turned on in the Settings app, then back in the app.
        system.answer = .on
        await push.launch()
        #expect(push.isOn)
        #expect(!push.needsSystemSettings)
        #expect(system.registered == 1)
    }

    @Test func onWhenAllowedRegisters() async {
        let registry = FakeRegistry()
        let system = FakeSystem(.on)
        let push = center(registry, system)
        await push.setEnabled(false)
        await push.setEnabled(true)
        #expect(push.isOn)
        #expect(system.registered == 1)
        await push.didRegister(deviceToken: Data([0xAB]))
        #expect(registry.calls == ["register ab"])
    }

    @Test func offUnregistersAndRemembers() async {
        let registry = FakeRegistry()
        let system = FakeSystem(.on)
        let defaults = UserDefaults(suiteName: "push-\(UUID())")!
        let push = center(registry, system, defaults: defaults)
        await push.launch()
        await push.didRegister(deviceToken: Data([0xAB]))
        await push.setEnabled(false)
        #expect(registry.calls == ["register ab", "unregister ab"])
        #expect(!push.isOn)
        // The system permission is left alone.
        #expect(push.permission == .on)
        #expect(system.prompted == 0)
        // The next launch keeps it off and registers nothing.
        let relaunched = center(registry, system, defaults: defaults)
        let registeredBefore = system.registered
        await relaunched.launch()
        await relaunched.didRegister(deviceToken: Data([0xAB]))
        #expect(!relaunched.enabledByUser)
        #expect(!relaunched.isOn)
        #expect(system.registered == registeredBefore)
        #expect(registry.calls == ["register ab", "unregister ab"])
    }

    @Test func offHidesTheChatOffer() async {
        let push = center(FakeRegistry(), FakeSystem(.notSet))
        await push.refresh()
        #expect(push.offersPrompt())
        await push.setEnabled(false)
        #expect(!push.offersPrompt())
    }
}

@MainActor
private final class FakeRegistry: DeviceRegistry {
    var signedIn = true
    var fails = false
    var calls: [String] = []

    var canRegisterDevice: Bool { signedIn }

    func registerDevice(_ device: DeviceRegistration) async throws {
        calls.append("register \(device.token)")
        if fails { throw AuthError.sessionRejected }
    }

    func unregisterDevice(token: String) async throws {
        calls.append("unregister \(token)")
        if fails { throw AuthError.sessionRejected }
    }
}

@MainActor
private final class FakeSystem: NotificationSystem {
    var answer: PushPermission
    /// What the guardian picks in the system prompt; nil leaves it undecided.
    var promptAnswer: PushPermission?
    var prompted = 0
    var registered = 0

    init(_ answer: PushPermission) { self.answer = answer }

    func permission() async -> PushPermission { answer }
    func requestAuthorization() async {
        prompted += 1
        if answer == .notSet, let promptAnswer { answer = promptAnswer }
    }
    func registerForRemoteNotifications() { registered += 1 }
}

private extension PushTokenStore {
    @MainActor static func memory(_ initial: String? = nil) -> PushTokenStore {
        final class Box { var value: String? }
        let box = Box()
        box.value = initial
        return PushTokenStore(load: { box.value }, save: { box.value = $0 })
    }
}
