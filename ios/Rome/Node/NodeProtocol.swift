import Foundation
import os

// The wire side of rome-node, ported from packages/rome-node-core (protocol.ts,
// gateway-url.ts, client.ts, executor.ts). Text JSON envelopes only: this
// phone never advertises binary frames, and ignores any it is sent.

/// A request the Gateway relays: `{id, from, payload: {type: "request", action, args}}`.
struct NodeRequest: Equatable, Sendable {
    let id: String
    let from: String
    let action: String
    let args: JSONValue?
}

enum NodeProtocol {
    /// An id the Gateway accepts: 1 to 128 characters, no controls or spaces.
    static func isValidID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && !value.unicodeScalars.contains { $0.value <= 0x20 || $0.value == 0x7F }
    }

    /// The request in one inbound text frame. Nil for anything else: a route
    /// error (`target_unavailable` and the like) or a payload that is not a
    /// request is not answered, as in rome-node's executor.
    static func request(in text: String) -> NodeRequest? {
        guard let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let id = value["id"]?.string, isValidID(id),
              let from = value["from"]?.string, isValidID(from),
              let payload = value["payload"]?.object,
              payload["type"]?.string == "request",
              let action = payload["action"]?.string
        else { return nil }
        return NodeRequest(id: id, from: from, action: action, args: payload["args"])
    }

    /// `{id, to, payload: {type: "response", ok, result | error}}`.
    static func reply(to request: NodeRequest, _ result: NodeActionResult) -> String {
        let payload: JSONValue
        switch result {
        case .ok(let value, _):
            payload = .object(["type": .string("response"), "ok": .bool(true), "result": value])
        case .failed(let code, let message):
            payload = .object([
                "type": .string("response"), "ok": .bool(false),
                "error": .object(["code": .string(code), "message": .string(message)]),
            ])
        }
        let envelope = JSONValue.object(["id": .string(request.id), "to": .string(request.from), "payload": payload])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(envelope)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

/// The rules for the Gateway's address: WSS, or WS to this Mac only (a Debug
/// build against a local Rome Cloud), and nothing that carries a credential.
enum GatewayURL {
    static func parse(_ text: String) -> URL? {
        guard let components = URLComponents(string: text), let url = components.url,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              let host = components.host, !host.isEmpty
        else { return nil }
        switch components.scheme {
        case "wss": return url
        case "ws": return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) ? url : nil
        default: return nil
        }
    }
}

enum NodeClose {
    static let revoked = 4001
    static let superseded = 4002

    enum Decision: Equatable, Sendable {
        case reconnect
        /// Revoked, or replaced by another connection: no reconnect.
        case stop(NodeStop)
    }

    static func decision(for code: Int?) -> Decision {
        switch code {
        case revoked: return .stop(.revoked)
        case superseded: return .stop(.superseded)
        default: return .reconnect
        }
    }
}

enum NodeStop: Equatable, Sendable {
    case revoked
    case superseded
}

enum NodeBackoff {
    /// 1 s, doubling to 60 s, scattered by 0.75 to 1.25 (`random` in 0..<1).
    static func delay(attempt: Int, random: Double) -> TimeInterval {
        min(60, pow(2, Double(min(attempt, 6)))) * (0.75 + random * 0.5)
    }
}

/// One connection's life, so a request that outlives it is known to be cut
/// off: its reply is never sent, and its audit record says interrupted.
final class NodeSession: Sendable {
    private let alive = OSAllocatedUnfairLock(initialState: true)
    var isLive: Bool { alive.withLock { $0 } }
    func end() { alive.withLock { $0 = false } }
}

/// Answers requests: `system.info` always, anything else after it is written
/// in the audit log, and not at all when it cannot be.
struct NodeExecutor: Sendable {
    let name: @Sendable () async -> String
    let audit: NodeAuditing
    let health: HealthActions
    var now: @Sendable () -> Date = { Date() }

    /// The reply to one inbound text frame, or nil when there is nothing to answer.
    func respond(to text: String, session: NodeSession) async -> String? {
        guard let request = NodeProtocol.request(in: text) else { return nil }
        return NodeProtocol.reply(to: request, await result(for: request, session: session))
    }

    func result(for request: NodeRequest, session: NodeSession) async -> NodeActionResult {
        // Changes nothing and is probed often, so it is not recorded; it says
        // when the log is down.
        if request.action == "system.info" { return await info() }
        let started = now()
        guard let seq = await audit.begin(requestId: request.id, from: request.from, action: request.action, args: request.args) else {
            return .failed(
                code: "audit_unavailable",
                message: "This \(health.device.name) could not record the request in its audit log, so it did not run it. Free some storage on the \(health.device.name) and try again."
            )
        }
        let result = await health.run(request.action, args: request.args)
        let duration = Int(now().timeIntervalSince(started) * 1000)
        switch result {
        case .ok(let value, let count):
            let window = value["startISO"]?.string.flatMap { start in value["endISO"]?.string.map { (start: start, end: $0) } }
            await audit.end(seq, outcome: session.isLive ? .ok : .interrupted, errorCode: nil, count: count, window: window, durationMs: duration)
        case .failed(let code, _):
            await audit.end(seq, outcome: session.isLive ? .error : .interrupted, errorCode: code, count: nil, window: nil, durationMs: duration)
        }
        return result
    }

    private func info() async -> NodeActionResult {
        .ok(.object([
            "name": .string(await name()),
            "platform": .string("ios"),
            "actions": .array(HealthActions.actions.map(JSONValue.string)),
            "usage": .object(HealthActions.usage(health.device).mapValues(JSONValue.string)),
            "audit": await audit.status().json,
        ]), count: nil)
    }
}
