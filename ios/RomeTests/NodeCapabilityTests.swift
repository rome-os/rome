import Foundation
import Testing
@testable import Rome

extension NodeCapabilityRegistry {
    /// Health over `actions` (its Live access unless `health` is given) and
    /// Device, which answers `status`.
    static func testing(_ actions: HealthActions, health: NodeFlag? = nil, device: NodeFlag = NodeFlag(), status: DeviceStatus = .fixture) -> NodeCapabilityRegistry {
        NodeCapabilityRegistry(capabilities: [
            HealthCapability(health: actions, live: health ?? actions.enabled),
            DeviceCapability(live: device, device: actions.device, read: { status }),
        ])
    }
}

extension DeviceStatus {
    static let fixture = DeviceStatus(
        batteryLevel: 0.62, batteryState: "charging", lowPowerMode: false, network: "wifi", expensive: false,
        constrained: false, thermalState: "nominal", osVersion: "26.0", appVersion: "1.6.0"
    )
}

@Suite struct NodeCapabilityTests {
    private func envelope(_ action: String, _ args: String? = nil) -> String {
        let args = args.map { #","args":\#($0)"# } ?? ""
        return #"{"id":"r1","from":"inst-1","payload":{"type":"request","action":"\#(action)"\#(args)}}"#
    }

    private func reply(_ executor: NodeExecutor, _ action: String, _ args: String? = nil) async throws -> JSONValue {
        parseJSON(try #require(await executor.respond(to: envelope(action, args), session: NodeSession())))
    }

    @Test func anActionGoesToTheCapabilityItsPrefixNames() {
        let registry = NodeCapabilityRegistry.testing(HealthFixtures.actions(FakeHealth()))
        #expect(registry.capability(for: "health.stats")?.prefix == "health")
        #expect(registry.capability(for: "device.status")?.prefix == "device")
        #expect(registry.capability(for: "calendar.events") == nil)
        #expect(registry.capability(for: "health") == nil, "no dot, no prefix")
    }

    @Test func systemInfoKeepsTheFlatListsAndAddsEachCapability() async throws {
        let device = NodeFlag(false)
        let executor = NodeExecutor(name: { "iPhone" }, audit: FakeAudit(), registry: .testing(HealthFixtures.actions(FakeHealth()), device: device))
        let result = try #require(try await reply(executor, "system.info")["payload"]?["result"])
        #expect(result["actions"]?.array?.compactMap(\.string) == ["system.info", "health.stats", "health.samples", "device.status"])
        #expect(result["usage"]?["device.status"]?.string?.contains("live_off") == true)
        #expect(result["usage"]?["health.stats"]?.string?.isEmpty == false)
        let capabilities = try #require(result["capabilities"]?.array)
        #expect(capabilities.map { $0["prefix"]?.string } == ["health", "device"])
        #expect(capabilities.map { $0["id"]?.string } == ["apple_health", "device"])
        #expect(capabilities[0]["personal"]?.bool == true)
        #expect(capabilities[1]["personal"]?.bool == false)
        #expect(capabilities[0]["state"]?.string == "on")
        #expect(capabilities[1]["state"]?.string == "off", "off by default")
        #expect(capabilities[1]["actions"]?.array?.compactMap(\.string) == ["device.status"])
    }

    @Test func deviceStatusIsRefusedUntilItsLiveAccessIsOnAndAuditedEitherWay() async throws {
        let audit = FakeAudit()
        let device = NodeFlag(false)
        let executor = NodeExecutor(name: { "iPhone" }, audit: audit, registry: .testing(HealthFixtures.actions(FakeHealth()), device: device))
        let off = try await reply(executor, "device.status")
        #expect(off["payload"]?["error"]?["code"]?.string == "live_off")
        #expect(off["payload"]?["error"]?["message"]?.string?.contains("Settings → Connections → Device") == true)
        device.set(true)
        let on = try await reply(executor, "device.status")
        let result = try #require(on["payload"]?["result"])
        #expect(result["batteryLevel"]?.number == 0.62)
        #expect(result["batteryState"]?.string == "charging")
        #expect(result["network"]?.string == "wifi")
        #expect(result["thermalState"]?.string == "nominal")
        #expect(audit.begun.count == 2)
        #expect(audit.ended.map(\.errorCode) == ["live_off", nil])
    }

    @Test func deviceStatusTakesNoArguments() async throws {
        let executor = NodeExecutor(name: { "iPhone" }, audit: FakeAudit(), registry: .testing(HealthFixtures.actions(FakeHealth()), device: NodeFlag(true)))
        let sent = try await reply(executor, "device.status", #"{"verbose":true}"#)
        #expect(sent["payload"]?["error"]?["code"]?.string == "invalid_args")
    }

    @Test func anUnknownPrefixIsUnsupportedAndStillRecorded() async throws {
        let audit = FakeAudit()
        let executor = NodeExecutor(name: { "iPhone" }, audit: audit, registry: .testing(HealthFixtures.actions(FakeHealth())))
        #expect(try await reply(executor, "calendar.events")["payload"]?["error"]?["code"]?.string == "unsupported_action")
        #expect(try await reply(executor, "health.delete")["payload"]?["error"]?["code"]?.string == "unsupported_action")
        #expect(audit.begun.count == 2)
    }

    @Test func healthLiveWithIOSNeverAskedIsNotConnected() async throws {
        let health = FakeHealth()
        health.neverAsked = true
        let executor = NodeExecutor(name: { "iPhone" }, audit: FakeAudit(), registry: .testing(HealthFixtures.actions(health)))
        let sent = try await reply(executor, "health.stats", #"{"type":"stepCount"}"#)
        #expect(sent["payload"]?["error"]?["code"]?.string == "not_connected")
        #expect(sent["payload"]?["error"]?["message"]?.string?.contains("Settings → Connections → Apple Health") == true)
        #expect(health.reads == 0)
    }

    @Test func eachCapabilityDeclaresItsConnection() async {
        let health = FakeHealth()
        let registry = NodeCapabilityRegistry.testing(HealthFixtures.actions(health), health: NodeFlag(true), device: NodeFlag(false))
        let list = await registry.connections()
        #expect(list.map(\.capability) == ["apple_health", "device"])
        let healthActions = registry.capability(id: "apple_health")!.actions
        let deviceActions = registry.capability(id: "device")!.actions
        #expect(list[0] == .init(
            capability: "apple_health", title: "Apple Health", prefix: "health", personal: true,
            operations: healthActions.map(\.reportedOperation),
            feeds: "apple_health", permission: "unknown", live: true,
            summary: list[0].summary, labels: list[0].labels, icon: "heart"
        ), "HealthKit hides read access: always unknown")
        #expect(list[0].summary == "Your Rome reads the Health data you allow.")
        #expect(list[0].labels?["zh-CN"]?.title == "Apple 健康", "the card's words in each language")
        #expect(list[0].operations.map(\.name) == ["health.stats", "health.samples"])
        #expect(list[1] == .init(
            capability: "device", title: "Device", prefix: "device", personal: false,
            operations: deviceActions.map(\.reportedOperation), permission: "not_needed", live: false,
            summary: list[1].summary, labels: list[1].labels
        ))
        #expect(list[1].operations.map(\.name) == ["device.status"])
        // Each operation carries its usage and examples, so the Rome lists it from the report alone.
        for operation in list.flatMap(\.operations) {
            #expect(operation.access == "read")
            #expect(operation.description?.isEmpty == false, "\(operation.name) carries its usage")
            #expect(operation.examples?.isEmpty == false, "\(operation.name) carries an example")
        }
        #expect(list[1].operations[0].input?["additionalProperties"] == .bool(false), "device.status takes no arguments")
        #expect(registry.capability(id: "apple_health")?.needsPermission == true)
        #expect(registry.capability(id: "device")?.needsPermission == false)
        #expect(registry.capability(id: "apple_health")?.syncSource == "apple_health")
        #expect(registry.capability(id: "device")?.syncSource == nil)
    }

    @Test func everyConnectionPageHasWhatYourRomeCanDo() {
        let registry = NodeCapabilityRegistry.testing(HealthFixtures.actions(FakeHealth()))
        for capability in registry.capabilities {
            #expect(capability.examples.count >= 2, "\(capability.id) declares its examples")
        }
    }

    @Test func theReportHasTheShapeTheRomeTakes() throws {
        let report = DeviceConnectionReport(
            device: .init(id: "dev-1", name: "iPhone", platform: "ios"),
            connections: [.init(capability: "device", title: "Device", prefix: "device", personal: false, operations: [.init(name: "device.status", access: "read")], permission: "not_needed", live: true)]
        )
        let json = parseJSON(String(decoding: try JSONEncoder().encode(report), as: UTF8.self))
        #expect(json["version"]?.number == 1)
        #expect(json["device"]?["id"]?.string == "dev-1")
        #expect(json["device"]?["platform"]?.string == "ios")
        #expect(json["connections"]?.array?.first?["permission"]?.string == "not_needed")
        #expect(json["connections"]?.array?.first?["operations"]?.array?.first?["access"]?.string == "read")
        #expect(json["connections"]?.array?.first?["feeds"] == nil, "omitted for one that syncs nothing")
        #expect(json["device"]?["originId"] == nil, "omitted for an install that names none")
        let named = DeviceConnectionReport(device: .init(id: "dev-1", name: "iPhone", platform: "ios", originId: "origin-1"), connections: [])
        let namedJSON = parseJSON(String(decoding: try JSONEncoder().encode(named), as: UTF8.self))
        #expect(namedJSON["device"]?["originId"]?.string == "origin-1")
        #expect(namedJSON["connections"]?.array?.isEmpty == true, "a sign-out's report lists none")
        #expect(json["connections"]?.array?.first?["operations"]?.array?.first?["description"] == nil, "omitted when the registry declares none")
        #expect(DeviceConnections.connectionId(device: "DEV-1", capability: "apple_health") == "dev-1:apple_health")
        #expect(DeviceConnections.connectionId(device: nil, capability: "apple_health") == nil)
    }

    @Test func aCardsLinkNamesTheCapabilityOnThisRomeOnly() throws {
        let origin = try #require(URL(string: "https://me.romeos.cc"))
        func id(_ text: String) -> String? { DeviceConnectLink.capability(in: URL(string: text)!, origin: origin) }
        #expect(id("https://me.romeos.cc/connections/device/apple_health") == "apple_health")
        #expect(id("https://me.romeos.cc/connections/device/device/") == "device")
        #expect(id("https://other.romeos.cc/connections/device/apple_health") == nil, "another host is a page")
        #expect(id("https://me.romeos.cc/connections/device/") == nil)
        #expect(id("https://me.romeos.cc/connections/device/a/b") == nil)
        #expect(id("https://me.romeos.cc/settings/connections") == nil)
    }

    @Test func recentActivityTakesItsWordsFromTheCapability() {
        let formatter = NodeActivityFormatter(registry: .testing(HealthFixtures.actions(FakeHealth())), now: HealthFixtures.now, calendar: HealthFixtures.calendar("Asia/Shanghai"), locale: Locale(identifier: "en_US"))
        func entry(_ action: String, outcome: NodeOutcome?, error: String? = nil) -> NodeAuditEntry {
            NodeAuditEntry(seq: 1, time: HealthFixtures.now, from: "inst", action: action, args: "{}", outcome: outcome, errorCode: error, count: nil, windowStart: nil, windowEnd: nil, durationMs: 3)
        }
        let read = formatter.row(entry("device.status", outcome: .ok))
        #expect(read.title == "Battery and network")
        #expect(read.detail == "Read")
        let off = formatter.row(entry("device.status", outcome: .error, error: "live_off"))
        #expect(off.detail == "Live access is off")
        #expect(off.failed)
        let unknown = formatter.row(entry("calendar.events", outcome: .error, error: "unsupported_action"))
        #expect(unknown.title == "Unsupported request")
        #expect(unknown.detail == "calendar.events")
    }

    @Test func rowsSayNotConnectedOnOrOff() {
        #expect(ConnectionRowValue.text(connected: false, live: false, sync: nil) == "Not connected")
        #expect(ConnectionRowValue.text(connected: true, live: true, sync: nil) == "On")
        #expect(ConnectionRowValue.text(connected: true, live: false, sync: nil) == "Off")
        #expect(ConnectionRowValue.text(connected: true, live: false, sync: .waiting) == "On", "Sync alone is on")
        #expect(ConnectionRowValue.text(connected: true, live: false, sync: .off) == "Off")
        #expect(ConnectionRowValue.text(connected: true, live: true, sync: .needsSignIn) == "Needs sign-in")
    }

    @Test func theStatusLineSaysWhetherRomeCanReachThePhone() {
        #expect(NodeStatusLine.words(.online) == "Online")
        #expect(NodeStatusLine.words(.off) == "Offline")
        #expect(NodeStatusLine.words(.stopped(.superseded)) == "Replaced")
        #expect(NodeStatusLine.words(.stopped(.revoked)) == "Removed from your account")
    }
}

/// In the serialized NodeHostTests: every HostRig resets the shared
/// config stub, which a parallel suite would reset under another's feet.
extension NodeHostTests {
    @Test func liveAccessIsOffByDefaultAndKeptPerCapability() async {
        let rig = HostRig(deviceOn: false)
        #expect(rig.host.liveSwitches == ["apple_health": false, "device": false])
        var changes = 0
        rig.host.onLiveChanged = { changes += 1 }
        rig.host.setLive("device", on: true)
        #expect(rig.defaults.bool(forKey: NodeHost.Defaults.live("device")))
        #expect(changes == 1, "a change is reported")
        #expect(rig.makeHost().liveSwitches["device"] == true, "kept across launches")
        #expect(rig.makeHost().liveSwitches["apple_health"] == false)
        rig.host.setLive("calendar", on: true)
        #expect(rig.host.liveSwitches["calendar"] == nil, "no such capability")
    }

    @Test func aReportThatDidNotLandGoesAgainOnceAsked() async {
        let rig = HostRig(deviceOn: false)
        let connections = DeviceConnections(node: rig.host, defaults: rig.defaults)
        connections.device = { ("dev-1", "iPhone") }
        var attempts = 0
        var lands = false
        connections.send = { _ in attempts += 1; return lands }
        await connections.report().value
        #expect(connections.unsent)
        lands = true
        connections.reportIfUnsent()
        _ = await eventually { attempts == 2 }
        #expect(attempts == 2 && !connections.unsent)
        // Landed, it is not sent again.
        connections.reportIfUnsent()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(attempts == 2)
    }

    @Test func signOutsEmptyReportGoesFirstAndWaitsNoLongerThanItsLimit() async {
        let rig = HostRig(deviceOn: false)
        let connections = DeviceConnections(node: rig.host, defaults: rig.defaults)
        connections.device = { ("dev-1", "iPhone") }
        var reports: [DeviceConnectionReport] = []
        // An unreachable Rome: the send hangs well past the limit.
        connections.send = { report in
            reports.append(report)
            try? await Task.sleep(for: .seconds(30))
            return false
        }
        let started = ContinuousClock.now
        await connections.reportNone(limit: .milliseconds(200))
        #expect(ContinuousClock.now - started < .seconds(5), "the limit releases sign-out")
        #expect(reports.count == 1 && reports[0].connections.isEmpty, "an empty report was sent")
    }

    @Test func aWaitEndsWithItsWorkWhenTheWorkIsFirst() async {
        let started = ContinuousClock.now
        await DeviceConnections.wait(atMost: .seconds(30)) {}
        #expect(ContinuousClock.now - started < .seconds(5))
    }

    @Test func connectingMarksItTurnsLiveOnAndReports() async {
        let rig = HostRig(deviceOn: false)
        let connections = DeviceConnections(node: rig.host, defaults: rig.defaults)
        var reports: [DeviceConnectionReport] = []
        connections.device = { ("dev-1", "iPhone") }
        connections.send = { reports.append($0); return true }
        let health = rig.host.registry.capability(id: "apple_health")!
        let device = rig.host.registry.capability(id: "device")!
        #expect(!connections.isConnected(health) && !connections.isConnected(device))
        await connections.connect("apple_health")
        #expect(connections.isConnected(health))
        #expect(rig.host.liveSwitches["apple_health"] == true)
        #expect(DeviceConnections(node: rig.makeHost(), defaults: rig.defaults).isConnected(health), "kept across launches")
        #expect(!reports.isEmpty, "reported before it returns")
        #expect(reports.last?.connections.first { $0.capability == "apple_health" }?.live == true)
        #expect(reports.last?.device.id == "dev-1")
        // Device needs no permission: connected while its Live access is on.
        rig.host.setLive("device", on: true)
        #expect(connections.isConnected(device))
        // Health stays connected with both switches off: the page keeps its switches.
        rig.host.setLive("apple_health", on: false)
        #expect(connections.isConnected(health))
        connections.forgetAccount()
        #expect(!connections.isConnected(health))
    }

    @Test func aCardWaitsForTheAuthorizationOrItsDecline() async {
        let rig = HostRig(deviceOn: false)
        let connections = DeviceConnections(node: rig.host, defaults: rig.defaults)
        async let answer = connections.ask("device")
        _ = await eventually { connections.request != nil }
        #expect(connections.request?.capability == "device")
        connections.request?.finish(true)
        #expect(await answer == true)
        #expect(connections.request == nil)
        #expect(await connections.ask("calendar") == nil, "a capability this build lacks: the link stays a page")
        async let declined = connections.ask("apple_health")
        _ = await eventually { connections.request != nil }
        connections.request?.finish(false)
        connections.request?.finish(true)
        #expect(await declined == false, "the first answer counts")
    }

    @Test func reportsGoInOrderAndConnectWaitsForItsOwn() async {
        let rig = HostRig(deviceOn: false)
        let connections = DeviceConnections(node: rig.host, defaults: rig.defaults)
        connections.device = { ("dev-1", "iPhone") }
        var sent: [Bool] = []
        var held: CheckedContinuation<Void, Never>?
        connections.send = { report in
            // The first report is slow, as a PUT can be.
            if sent.isEmpty, held == nil { await withCheckedContinuation { held = $0 } }
            sent.append(report.connections.first { $0.capability == "device" }?.live ?? false)
            return true
        }
        let first = connections.report()
        _ = await eventually { held != nil }
        // Another report comes while the first is out: it neither cancels it nor overtakes it.
        let connecting = Task { await connections.connect("device") }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent.isEmpty, "nothing overtakes the slow report")
        held?.resume()
        await first.value
        await connecting.value
        #expect(sent.first == false)
        #expect(sent.last == true, "connect returns only once its own report, with Live access on, is sent")
    }
}

/// Records the device header of each request and answers a created turn.
final class DeviceHeaderProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var headers: [String?] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.headers.append(request.value(forHTTPHeaderField: APIClient.deviceHeader))
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"turnId":"t1"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
@Suite(.serialized) struct AskingDeviceHeaderTests {
    private func backend(cookie: String) -> LiveBackend {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceHeaderProtocol.self]
        DeviceHeaderProtocol.headers = []
        return LiveBackend(client: APIClient(origin: URL(string: "https://me.romeos.cc")!, token: { "t" }, cookieName: { cookie }, configuration: configuration, deviceId: "dev-1"))
    }

    @Test func everyGuardianRequestThatCanStartATurnNamesThisPhone() async throws {
        let backend = backend(cookie: InstanceSession.guardianCookie)
        _ = try await backend.send(sessionId: "s1", text: "battery?", files: [], inputId: "i1", priority: .now)
        // Answering a card starts the turn that reads after connecting.
        _ = try? await backend.answerWidget(widgetId: "w1", name: "check", context: .object([:]))
        try? await backend.resolveApproval(id: "a1", approve: true)
        _ = try? await backend.sessions()
        #expect(DeviceHeaderProtocol.headers == ["dev-1", "dev-1", "dev-1", nil], "a GET names none")
    }

    @Test func aVisitorsRomeIsNeverTold() async throws {
        let backend = backend(cookie: InstanceSession.visitorCookie)
        _ = try await backend.send(sessionId: "s1", text: "hi", files: [], inputId: "i1", priority: .now)
        #expect(DeviceHeaderProtocol.headers == [nil])
    }
}

