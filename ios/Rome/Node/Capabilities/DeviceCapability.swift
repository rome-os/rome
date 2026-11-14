import Foundation
import Network
import UIKit

/// The phone's battery, network and temperature: `device.status`. It needs no
/// iOS permission and reads no Wi-Fi name (that would need location). Its
/// own switch is off by default, like everything else Rome can use.
struct DeviceCapability: NodeCapability {
    static let defaultsKey = "nodeDeviceStatusEnabled"

    let enabled: NodeFlag
    var device = DeviceKind.iPhone
    var read: @Sendable () async -> DeviceStatus = { await DeviceStatus.live() }

    let prefix = "device"
    let name = "Device status"
    var title: LocalizedStringResource { "Device status" }
    let symbol = "battery.75percent"
    let personal = false
    var switchKind: NodeCapabilitySwitch { .own(defaultsKey: Self.defaultsKey) }
    var ownFlag: NodeFlag? { enabled }

    var actions: [NodeActionSpec] {
        [NodeActionSpec(
            name: "device.status",
            usage: """
                No arguments. The \(device.name)'s battery and network now: batteryLevel (0 to 1), batteryState \
                (charging | unplugged | full | unknown), lowPowerMode, network (wifi | cellular | wired | none | other), \
                expensive, constrained (Low Data Mode), thermalState (nominal | fair | serious | critical), osVersion, appVersion. \
                Off for Rome until the user turns it on in Settings → \(device.name) use → Device status in the Rome app on the \(device.name). \
                While it is off the request fails with device_off. Example: {}
                """
        )]
    }

    var detail: NodeCapabilityDetail {
        NodeCapabilityDetail(
            reads: "Battery, network, temperature",
            leaves: "Only what Rome asks for",
            systemAccess: nil
        )
    }

    func state() async -> NodeCapabilityState { enabled.isOn ? .on : .off }

    func run(_ action: String, args: JSONValue?) async -> NodeActionResult {
        guard action == "device.status" else {
            return .failed(code: "unsupported_action", message: "This \(device.name) does not support this action.")
        }
        switch args {
        case nil, .null?: break
        case .object(let fields)? where fields.isEmpty: break
        default: return .failed(code: "invalid_args", message: "device.status takes no arguments.")
        }
        return .ok(await read().json, count: nil)
    }

    func activityTitle(_ entry: NodeAuditEntry) -> String? {
        handles(entry.action) ? String(localized: "Battery and network") : nil
    }

    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String? {
        String(localized: "Read")
    }
}

/// What `device.status` answers.
struct DeviceStatus: Equatable, Sendable {
    var batteryLevel: Double?
    var batteryState: String
    var lowPowerMode: Bool
    var network: String
    var expensive: Bool
    var constrained: Bool
    var thermalState: String
    var osVersion: String
    var appVersion: String

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "batteryState": .string(batteryState), "lowPowerMode": .bool(lowPowerMode), "network": .string(network),
            "expensive": .bool(expensive), "constrained": .bool(constrained), "thermalState": .string(thermalState),
            "osVersion": .string(osVersion), "appVersion": .string(appVersion),
        ]
        // iOS answers -1 while it cannot tell: no value, never a made-up one.
        if let batteryLevel { fields["batteryLevel"] = HealthActions.number((batteryLevel * 100).rounded() / 100) }
        return .object(fields)
    }

    static func live() async -> DeviceStatus {
        let battery = await MainActor.run { () -> (Float, UIDevice.BatteryState, String) in
            let device = UIDevice.current
            device.isBatteryMonitoringEnabled = true
            return (device.batteryLevel, device.batteryState, device.systemVersion)
        }
        let path = await NetworkSnapshot.current()
        let info = ProcessInfo.processInfo
        return DeviceStatus(
            batteryLevel: battery.0 < 0 ? nil : Double(battery.0),
            batteryState: batteryState(battery.1),
            lowPowerMode: info.isLowPowerModeEnabled,
            network: path.map(network) ?? "none",
            expensive: path?.isExpensive ?? false,
            constrained: path?.isConstrained ?? false,
            thermalState: thermalState(info.thermalState),
            osVersion: battery.2,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        )
    }

    static func batteryState(_ state: UIDevice.BatteryState) -> String {
        switch state {
        case .charging: return "charging"
        case .unplugged: return "unplugged"
        case .full: return "full"
        default: return "unknown"
        }
    }

    static func network(_ path: NWPath) -> String {
        guard path.status == .satisfied else { return "none" }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cellular" }
        if path.usesInterfaceType(.wiredEthernet) { return "wired" }
        return "other"
    }

    static func thermalState(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }
}

/// One reading of the network path: a monitor that stops after its first answer.
enum NetworkSnapshot {
    static func current() async -> NWPath? {
        let monitor = NWPathMonitor()
        let once = PathOnce()
        return await withCheckedContinuation { continuation in
            once.continuation = continuation
            monitor.pathUpdateHandler = { path in
                once.resume(path)
                monitor.cancel()
            }
            monitor.start(queue: DispatchQueue(label: "rome.network-snapshot"))
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                once.resume(nil)
                monitor.cancel()
            }
        }
    }

    private final class PathOnce: @unchecked Sendable {
        private let lock = NSLock()
        var continuation: CheckedContinuation<NWPath?, Never>?

        func resume(_ path: NWPath?) {
            let held = lock.withLock { () -> CheckedContinuation<NWPath?, Never>? in
                defer { continuation = nil }
                return continuation
            }
            held?.resume(returning: path)
        }
    }
}
