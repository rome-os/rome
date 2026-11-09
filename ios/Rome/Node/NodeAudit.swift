import Foundation

// The phone's light audit log, after rome-node's: each request is written down
// before it runs, and a request that cannot be written down does not run.
// JSON lines in Application Support, kept 30 days. A line carries what was
// asked (action, args) and how it went (outcome, count, time), never a health
// value.

/// How one request ended.
enum NodeOutcome: String, Sendable {
    case ok
    case error
    /// The connection went away before the reply: no end record, or this one.
    case interrupted
}

/// One request as Settings lists it.
struct NodeAuditEntry: Identifiable, Equatable, Sendable {
    let seq: Int
    let time: Date
    let from: String
    let action: String
    /// The args as the caller sent them, compact JSON.
    let args: String
    /// Nil while the request is still running or its end was never written.
    let outcome: NodeOutcome?
    let errorCode: String?
    let count: Int?
    /// The window the request read, as the reply named it; nil for a request that failed.
    let windowStart: Date?
    let windowEnd: Date?
    let durationMs: Int?

    var id: Int { seq }

    /// The args as JSON, for a row that says what was read.
    var argsValue: JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: Data(args.utf8)) }
}

enum NodeAuditState: Equatable, Sendable {
    case ok
    case unavailable(String)

    /// `system.info`'s `audit` field.
    var json: JSONValue {
        switch self {
        case .ok: return .object(["state": .string("ok")])
        case .unavailable(let message):
            return .object(["state": .string("unavailable"), "code": .string("write_failed"), "message": .string(message)])
        }
    }
}

protocol NodeAuditing: Sendable {
    func status() async -> NodeAuditState
    /// Writes the request down; nil when it could not be, and must not run.
    func begin(requestId: String, from: String, action: String, args: JSONValue?) async -> Int?
    func end(_ seq: Int, outcome: NodeOutcome, errorCode: String?, count: Int?, window: (start: String, end: String)?, durationMs: Int) async
    /// Newest first.
    func recent(limit: Int) async -> [NodeAuditEntry]
}

actor NodeAuditLog: NodeAuditing {
    static let retention: TimeInterval = 30 * 24 * 3600
    /// Args longer than this are not kept whole: the log records what was
    /// asked, not a payload.
    static let argsLimit = 2048

    static var defaultURL: URL {
        URL.applicationSupportDirectory.appending(path: "node-audit.jsonl")
    }

    private let url: URL
    private let now: @Sendable () -> Date
    private var opened = false
    private var nextSeq = 1
    private var state = NodeAuditState.ok
    private var filePath: String { url.path(percentEncoded: false) }

    init(url: URL = NodeAuditLog.defaultURL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url
        self.now = now
    }

    func status() -> NodeAuditState {
        open()
        return state
    }

    func begin(requestId: String, from: String, action: String, args: JSONValue?) -> Int? {
        open()
        guard opened else { return nil }
        let seq = nextSeq
        var record: [String: JSONValue] = [
            "seq": .number(Double(seq)), "event": .string("start"), "time": .string(RomeDate.string(now())),
            "requestId": .string(requestId), "from": .string(from), "action": .string(action),
        ]
        if let args { record["args"] = Self.bounded(args) }
        guard write(record) else { return nil }
        nextSeq += 1
        return seq
    }

    func end(_ seq: Int, outcome: NodeOutcome, errorCode: String?, count: Int?, window: (start: String, end: String)?, durationMs: Int) {
        var record: [String: JSONValue] = [
            "seq": .number(Double(seq)), "event": .string("end"), "time": .string(RomeDate.string(now())),
            "outcome": .string(outcome.rawValue), "durationMs": .number(Double(durationMs)),
        ]
        if let errorCode { record["errorCode"] = .string(errorCode) }
        if let count { record["count"] = .number(Double(count)) }
        // The window as asked, never a value read from Health.
        if let window { record["windowStart"] = .string(window.start); record["windowEnd"] = .string(window.end) }
        // A lost end record leaves the request listed without an outcome.
        _ = write(record)
    }

    func recent(limit: Int) -> [NodeAuditEntry] {
        open()
        guard let lines = try? readLines() else { return [] }
        var entries: [Int: NodeAuditEntry] = [:]
        for line in lines {
            guard let record = Self.parse(line), let seq = record["seq"]?.number.map(Int.init) else { continue }
            let time = RomeDate.parse(record["time"]?.string) ?? .distantPast
            switch record["event"]?.string {
            case "start":
                entries[seq] = NodeAuditEntry(
                    seq: seq, time: time, from: record["from"]?.string ?? "", action: record["action"]?.string ?? "",
                    args: record["args"].map { Self.compact($0) } ?? "", outcome: nil, errorCode: nil, count: nil,
                    windowStart: nil, windowEnd: nil, durationMs: nil
                )
            case "end":
                guard let start = entries[seq] else { continue }
                entries[seq] = NodeAuditEntry(
                    seq: seq, time: start.time, from: start.from, action: start.action, args: start.args,
                    outcome: record["outcome"]?.string.flatMap(NodeOutcome.init(rawValue:)),
                    errorCode: record["errorCode"]?.string, count: record["count"]?.number.map(Int.init),
                    windowStart: RomeDate.parse(record["windowStart"]?.string), windowEnd: RomeDate.parse(record["windowEnd"]?.string),
                    durationMs: record["durationMs"]?.number.map(Int.init)
                )
            default: continue
            }
        }
        return Array(entries.values.sorted { $0.seq > $1.seq }.prefix(limit))
    }

    // MARK: File

    /// Opens the log: the folder, the last number, and the lines older than
    /// the retention gone. Tried again on the next request after a failure.
    private func open() {
        guard !opened else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let lines = try readLines()
            let cutoff = now().addingTimeInterval(-Self.retention)
            var kept: [String] = []
            var last = 0
            for line in lines {
                guard let record = Self.parse(line), let seq = record["seq"]?.number.map(Int.init) else { continue }
                last = max(last, seq)
                if (RomeDate.parse(record["time"]?.string) ?? .distantPast) >= cutoff { kept.append(line) }
            }
            if kept.count != lines.count {
                try Data((kept.map { $0 + "\n" }).joined().utf8).write(to: url, options: .atomic)
            }
            nextSeq = last + 1
            opened = true
            state = .ok
        } catch {
            state = .unavailable("The audit log could not be opened.")
        }
    }

    private func readLines() throws -> [String] {
        guard FileManager.default.fileExists(atPath: filePath) else { return [] }
        let text = try String(contentsOf: url, encoding: .utf8)
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private func write(_ record: [String: JSONValue]) -> Bool {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            var data = try encoder.encode(JSONValue.object(record))
            data.append(0x0A)
            if !FileManager.default.fileExists(atPath: filePath) {
                guard FileManager.default.createFile(atPath: filePath, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            state = .ok
            return true
        } catch {
            state = .unavailable("The audit log could not be written.")
            return false
        }
    }

    private static func parse(_ line: String) -> [String: JSONValue]? {
        (try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)))?.object
    }

    static func compact(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    private static func bounded(_ args: JSONValue) -> JSONValue {
        compact(args).utf8.count <= argsLimit ? args : .object(["truncated": .bool(true)])
    }
}
