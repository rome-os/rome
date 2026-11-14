import Foundation

/// The phone's capabilities in display order. It routes an action by its
/// prefix, answers `system.info`, and gives Settings its list.
struct NodeCapabilityRegistry: Sendable {
    let capabilities: [any NodeCapability]

    /// The capability an action belongs to: the text before its first dot.
    func capability(for action: String) -> (any NodeCapability)? {
        guard let dot = action.firstIndex(of: ".") else { return nil }
        let prefix = action[..<dot]
        return capabilities.first { $0.prefix == prefix }
    }

    func capability(prefix: String) -> (any NodeCapability)? {
        capabilities.first { $0.prefix == prefix }
    }

    /// Every action, `system.info` first: the flat list `system.info` has
    /// always given, so `rome-node device describe` keeps working.
    var actions: [String] {
        ["system.info"] + capabilities.flatMap { $0.actions.map(\.name) }
    }

    var usage: [String: String] {
        var usage = ["system.info": "No arguments."]
        for capability in capabilities {
            for action in capability.actions { usage[action.name] = action.usage }
        }
        return usage
    }

    /// `system.info`'s `capabilities`: each one, with its state.
    func info() async -> JSONValue {
        var list: [JSONValue] = []
        for capability in capabilities {
            list.append(.object([
                "prefix": .string(capability.prefix),
                "title": .string(capability.name),
                "state": .string(await capability.state().wire),
                "personal": .bool(capability.personal),
                "actions": .array(capability.actions.map { .string($0.name) }),
            ]))
        }
        return .array(list)
    }

    /// Settings' list: each capability with its state.
    func rows() async -> [(capability: any NodeCapability, state: NodeCapabilityState)] {
        var rows: [(capability: any NodeCapability, state: NodeCapabilityState)] = []
        for capability in capabilities { rows.append((capability, await capability.state())) }
        return rows
    }
}
