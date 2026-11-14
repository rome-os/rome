import Foundation
import os
import SwiftUI

// One thing Rome can do with this phone as a rome-node device, such as
// reading Apple Health live or reading the battery. Node is only the channel
// and the audit log: each capability is one file in `Capabilities/` that
// answers its own actions, and the registry lists them in display order.

enum NodeCapabilityState: Equatable, Sendable {
    /// Rome's switch for it is off.
    case off
    /// The switch is on, but iOS has not granted access, or was never asked.
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

struct NodeActionSpec: Sendable, Equatable {
    /// Starts with the capability's prefix and a dot, such as `health.stats`.
    let name: String
    /// English, for the Agent: what `system.info` gives in `usage`.
    let usage: String
}

/// Where a capability's switch lives.
enum NodeCapabilitySwitch: Sendable, Equatable {
    /// Its own switch on its detail page, kept under this key, off by default.
    case own(defaultsKey: String)
    /// Another page's switch, which the detail page links to (Health follows
    /// Apple Health's Sync with Rome).
    case follows(SettingsRoute)
}

/// What a capability's detail page says.
struct NodeCapabilityDetail: Sendable {
    /// What it reads on the phone.
    let reads: LocalizedStringResource
    /// What leaves the phone, and where it goes.
    let leaves: LocalizedStringResource
    /// Where iOS's own access for it is set, when a link cannot open it;
    /// nil when it needs no iOS access.
    let systemAccess: LocalizedStringResource?
}

protocol NodeCapability: Sendable {
    /// The action names' prefix: "health", "device".
    var prefix: String { get }
    /// The name an Agent reads in `system.info`, in English.
    var name: String { get }
    var title: LocalizedStringResource { get }
    /// An SF Symbol.
    var symbol: String { get }
    /// Reads the guardian's personal data: refused in a shared chat by the
    /// `rome-node` CLI.
    var personal: Bool { get }
    var actions: [NodeActionSpec] { get }
    var switchKind: NodeCapabilitySwitch { get }
    /// The flag behind an `.own` switch, which `NodeHost` keeps; nil for one that follows another page.
    var ownFlag: NodeFlag? { get }
    var detail: NodeCapabilityDetail { get }
    func state() async -> NodeCapabilityState
    /// Called only after the audit record is written and the state is `.on`.
    func run(_ action: String, args: JSONValue?) async -> NodeActionResult
    /// What the Agent reads when the capability is off or lacks access.
    func refusal(_ state: NodeCapabilityState, device: DeviceKind) -> NodeActionResult
    /// The Recent activity row's title: what was asked, in words, never a
    /// value. Nil when the entry is not one of its actions.
    func activityTitle(_ entry: NodeAuditEntry) -> String?
    /// The row's detail for a request that went well; nil leaves it to the
    /// formatter's generic words.
    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String?
}

extension NodeCapability {
    func refusal(_ state: NodeCapabilityState, device: DeviceKind) -> NodeActionResult {
        switch state {
        case .off:
            return .failed(
                code: "\(prefix)_off",
                message: "\(name) is off for Rome on this \(device.name). The user must turn it on in Settings → \(device.name) use → \(name) in the Rome app on the \(device.name)."
            )
        case .needsPermission:
            return .failed(
                code: "\(prefix)_no_permission",
                message: "Rome has no iOS access for \(name) on this \(device.name). The user must allow it in the Rome app on the \(device.name)."
            )
        case .on:
            return .failed(code: "unsupported_action", message: "This \(device.name) does not support this action.")
        }
    }

    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String? { nil }

    var ownFlag: NodeFlag? { nil }

    func handles(_ action: String) -> Bool { actions.contains { $0.name == action } }
}

/// A switch the executor's threads read and Settings writes.
final class NodeFlag: Sendable {
    private let state: OSAllocatedUnfairLock<Bool>

    init(_ on: Bool = false) { state = OSAllocatedUnfairLock(initialState: on) }

    var isOn: Bool { state.withLock { $0 } }
    func set(_ on: Bool) { state.withLock { $0 = on } }
}
