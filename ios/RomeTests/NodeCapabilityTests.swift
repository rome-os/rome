import Foundation
import Testing
@testable import Rome

extension NodeCapabilityRegistry {
    /// Health over `actions` (its own switch unless `health` is given) and
    /// Device status, which answers `status`.
    static func testing(_ actions: HealthActions, health: NodeFlag? = nil, device: NodeFlag = NodeFlag(), status: DeviceStatus = .fixture) -> NodeCapabilityRegistry {
        NodeCapabilityRegistry(capabilities: [
            HealthCapability(health: actions, enabled: health ?? actions.enabled),
            DeviceCapability(enabled: device, device: actions.device, read: { status }),
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
        #expect(result["usage"]?["device.status"]?.string?.contains("device_off") == true)
        #expect(result["usage"]?["health.stats"]?.string?.isEmpty == false)
        let capabilities = try #require(result["capabilities"]?.array)
        #expect(capabilities.map { $0["prefix"]?.string } == ["health", "device"])
        #expect(capabilities[0]["personal"]?.bool == true)
        #expect(capabilities[1]["personal"]?.bool == false)
        #expect(capabilities[0]["state"]?.string == "on")
        #expect(capabilities[1]["state"]?.string == "off", "off by default")
        #expect(capabilities[1]["actions"]?.array?.compactMap(\.string) == ["device.status"])
    }

    @Test func deviceStatusIsRefusedUntilItsSwitchIsOnAndAuditedEitherWay() async throws {
        let audit = FakeAudit()
        let device = NodeFlag(false)
        let executor = NodeExecutor(name: { "iPhone" }, audit: audit, registry: .testing(HealthFixtures.actions(FakeHealth()), device: device))
        let off = try await reply(executor, "device.status")
        #expect(off["payload"]?["error"]?["code"]?.string == "device_off")
        #expect(off["payload"]?["error"]?["message"]?.string?.contains("Settings → iPhone use → Device status") == true)
        device.set(true)
        let on = try await reply(executor, "device.status")
        let result = try #require(on["payload"]?["result"])
        #expect(result["batteryLevel"]?.number == 0.62)
        #expect(result["batteryState"]?.string == "charging")
        #expect(result["network"]?.string == "wifi")
        #expect(result["thermalState"]?.string == "nominal")
        #expect(audit.begun.count == 2)
        #expect(audit.ended.map(\.errorCode) == ["device_off", nil])
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

    @Test func healthOnWithIOSNeverAskedNeedsAccess() async throws {
        let health = FakeHealth()
        health.neverAsked = true
        let executor = NodeExecutor(name: { "iPhone" }, audit: FakeAudit(), registry: .testing(HealthFixtures.actions(health)))
        let sent = try await reply(executor, "health.stats", #"{"type":"stepCount"}"#)
        #expect(sent["payload"]?["error"]?["code"]?.string == "health_no_permission")
        #expect(health.reads == 0)
    }

    @Test func healthFollowsAppleHealthsSwitch() {
        let capability = HealthCapability(health: HealthFixtures.actions(FakeHealth()), enabled: NodeFlag())
        #expect(capability.switchKind == .follows(.health))
        #expect(capability.ownFlag == nil)
        #expect(DeviceCapability(enabled: NodeFlag()).switchKind == .own(defaultsKey: DeviceCapability.defaultsKey))
    }

    @Test func recentActivityTakesItsWordsFromTheCapability() {
        let formatter = NodeActivityFormatter(registry: .testing(HealthFixtures.actions(FakeHealth())), now: HealthFixtures.now, calendar: HealthFixtures.calendar("Asia/Shanghai"), locale: Locale(identifier: "en_US"))
        func entry(_ action: String, outcome: NodeOutcome?, error: String? = nil) -> NodeAuditEntry {
            NodeAuditEntry(seq: 1, time: HealthFixtures.now, from: "inst", action: action, args: "{}", outcome: outcome, errorCode: error, count: nil, windowStart: nil, windowEnd: nil, durationMs: 3)
        }
        let read = formatter.row(entry("device.status", outcome: .ok))
        #expect(read.title == "Battery and network")
        #expect(read.detail == "Read")
        let off = formatter.row(entry("device.status", outcome: .error, error: "device_off"))
        #expect(off.detail == "Device status is off")
        #expect(off.failed)
        let unknown = formatter.row(entry("calendar.events", outcome: .error, error: "unsupported_action"))
        #expect(unknown.title == "Unsupported request")
        #expect(unknown.detail == "calendar.events")
    }

    @Test func rowsSayOnOffOrNeedsAccess() {
        #expect(NodeCapabilityRowState(.on).value == "On")
        #expect(NodeCapabilityRowState(.off).value == "Off")
        #expect(NodeCapabilityRowState(.needsPermission).value == "Needs access")
        #expect(NodeCapabilityRowState(nil).value == "Off")
    }

    @Test func theStatusLineNamesTheDeviceAndWhetherRomeCanReachIt() {
        #expect(NodeStatusLine.text(device: "iPhone", status: .online, enabled: true) == "iPhone · Online")
        #expect(NodeStatusLine.text(device: "iPhone", status: .off, enabled: true) == "iPhone · Offline · available while Rome is open")
        #expect(NodeStatusLine.text(device: "iPhone", status: .off, enabled: false) == "iPhone · Off")
        #expect(NodeStatusLine.text(device: "iPhone", status: .stopped(.superseded), enabled: true) == "iPhone · Replaced")
    }
}

@MainActor
@Suite struct NodeHostCapabilityTests {
    @Test func aCapabilitysOwnSwitchIsOffByDefaultAndKept() async {
        let rig = HostRig()
        #expect(rig.host.capabilitySwitches["device"] == false)
        #expect(rig.host.capabilitySwitches["health"] == nil, "Health follows Apple Health's switch")
        rig.host.setCapability("device", on: true)
        #expect(rig.defaults.bool(forKey: DeviceCapability.defaultsKey))
        #expect(rig.makeHost().capabilitySwitches["device"] == true, "kept across launches")
        rig.host.setCapability("health", on: true)
        #expect(rig.host.capabilitySwitches["health"] == nil, "no switch of its own to set")
    }
}
