import Foundation
import os
import SwiftUI

// One thing Rome can do with this phone, such as reading Apple Health or the
// battery. Each is one device connection: "Apple Health · iPhone". Node is
// only the channel and the audit log: each capability is one file in
// `Capabilities/` that answers its own actions and declares what the
// connection report says about it, and the registry lists them in display
// order.

enum NodeCapabilityState: Equatable, Sendable {
    /// Its Live access is off.
    case off
    /// Live access is on, but iOS has not granted access, or was never asked.
    case needsPermission
    case on

    /// What `system.info` says.
    var wire: String {
        switch self {
        case .off: return "off"
        case .needsPermission: return "needs_permission"
        case .on: return "on"
        }
    }
}

/// Whether iOS lets the app read what a capability reads.
enum NodePermission: String, Equatable, Sendable {
    case granted
    /// iOS says no. HealthKit never says so: it hides a refusal.
    case denied
    /// It needs no iOS permission.
    case notNeeded = "not_needed"
    /// iOS was never asked.
    case unknown
}

enum NodeAccess: String, Sendable, Equatable {
    case read
    case write
}

struct NodeActionSpec: Sendable, Equatable {
    /// Starts with the capability's prefix and a dot, such as `health.stats`.
    let name: String
    /// English, for the Agent: what `system.info` gives in `usage`.
    let usage: String
    var access: NodeAccess = .read
    /// The JSON schema of its arguments, for the connection report.
    var input: JSONValue? = nil
    /// Argument objects that work as they are, for the connection report.
    var examples: [JSONValue] = []
}

/// One short chat on a connection's page: something the Rome can do with it.
struct CapabilityExample: Sendable {
    /// An SF Symbol.
    let symbol: String
    let title: LocalizedStringResource
    let request: LocalizedStringResource
    let reply: LocalizedStringResource
}

protocol NodeCapability: Sendable {
    /// The connection's id, the same on every phone: `apple_health`, `device`.
    var id: String { get }
    /// The action names' prefix: "health", "device".
    var prefix: String { get }
    /// The name an Agent reads in `system.info` and the connection report, in English.
    var name: String { get }
    var title: LocalizedStringResource { get }
    /// An SF Symbol.
    var symbol: String { get }
    /// The icon its chat card shows, by a name every reader draws
    /// (`WIDGET_UI_ICONS`), such as `heart`; nil for none.
    var cardIcon: String? { get }
    /// What the connection lets the Rome do, in one line, for its page and
    /// the authorization step.
    var summary: LocalizedStringResource { get }
    /// "What your Rome can do" on its page: two or three short chats.
    var examples: [CapabilityExample] { get }
    /// Reads the guardian's personal data: refused in a shared chat by the
    /// `rome-node` CLI.
    var personal: Bool { get }
    var actions: [NodeActionSpec] { get }
    /// The personal-data source it syncs into; nil for one that is read live only.
    var syncSource: String? { get }
    /// It needs an iOS permission, which its authorization asks for first.
    var needsPermission: Bool { get }
    /// Its Live access: one switch per phone, since the phone cannot tell
    /// which Rome sends a live request.
    var live: NodeFlag { get }
    func permission() async -> NodePermission
    /// Off without Live access; waiting while iOS has not granted it.
    func state() async -> NodeCapabilityState
    /// Shows iOS's own prompt, for one that needs a permission.
    func requestPermission() async
    /// Called only after the audit record is written and the state is `.on`.
    func run(_ action: String, args: JSONValue?) async -> NodeActionResult
    /// The Recent activity row's title: what was asked, in words, never a
    /// value. Nil when the entry is not one of its actions.
    func activityTitle(_ entry: NodeAuditEntry) -> String?
    /// The row's detail for a request that went well; nil leaves it to the
    /// formatter's generic words.
    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String?
}

extension NodeCapability {
    func state() async -> NodeCapabilityState {
        guard live.isOn else { return .off }
        switch await permission() {
        case .granted, .notNeeded: return .on
        case .denied, .unknown: return .needsPermission
        }
    }

    /// What the Agent reads when Live access is off or iOS has not granted it.
    func refusal(_ state: NodeCapabilityState, device: DeviceKind) -> NodeActionResult {
        switch state {
        case .off:
            return .failed(
                code: "live_off",
                message: "Live access to \(name) is off on this \(device.name). Where you talk with the user directly, offer the connect card: connect_account with kind \"\(id)\". In a task chat, stop and report that \(name) needs connecting, so the chat that started the task offers it. Do not ask whether it is connected. The user turns it on in the Rome app on the \(device.name): Settings → Connections → \(name)."
            )
        case .needsPermission:
            return .failed(
                code: "not_connected",
                message: "\(name) is not connected on this \(device.name): iOS has not given Rome access. Where you talk with the user directly, offer the connect card: connect_account with kind \"\(id)\". In a task chat, stop and report that \(name) needs connecting, so the chat that started the task offers it. Do not ask whether it is connected. The user turns it on in the Rome app on the \(device.name): Settings → Connections → \(name)."
            )
        case .on:
            return .failed(code: "unsupported_action", message: "This \(device.name) does not support this action.")
        }
    }

    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String? { nil }

    var cardIcon: String? { nil }

    func requestPermission() async {}

    func handles(_ action: String) -> Bool { actions.contains { $0.name == action } }
}

/// A switch the executor's threads read and Settings writes.
final class NodeFlag: Sendable {
    private let state: OSAllocatedUnfairLock<Bool>

    init(_ on: Bool = false) { state = OSAllocatedUnfairLock(initialState: on) }

    var isOn: Bool { state.withLock { $0 } }
    func set(_ on: Bool) { state.withLock { $0 = on } }
}
