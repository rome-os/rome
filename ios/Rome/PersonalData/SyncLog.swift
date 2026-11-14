import Foundation

// The phone's sync history, after NodeAuditLog: one JSON line per sync in
// Application Support, kept 30 days. A line holds counts and time ranges,
// never a value. Sign-out empties it.

enum SyncTrigger: String, Codable, Sendable, CaseIterable {
    /// HealthKit background delivery.
    case observer
    /// The app came to the front.
    case foreground
    /// Sync now.
    case manual
    /// The first sync after turning sync on, after Delete or a reset.
    case backfill
    /// A retry after a failure, once its wait is over.
    case retry
}

enum SyncOutcome: String, Codable, Sendable {
    case ok
    case partial
    case error
    case skipped
    /// Out of background time, or the app left: the next sync goes on from the saved anchors.
    case interrupted
    /// Delete uploaded data.
    case deleted
}

/// One type's part of a sync: how many items and the time they cover.
struct SyncTypeCount: Codable, Equatable, Sendable {
    var items: Int
    var start: Date?
    var end: Date?
}

struct SyncLogEntry: Codable, Equatable, Identifiable, Sendable {
    var seq: Int
    var time: Date
    var trigger: SyncTrigger
    var outcome: SyncOutcome
    /// Why it was skipped or failed: `locked`, `no_access`,
    /// `signed_out`, `network`, `rate_limited`…
    var errorCode: String?
    var types: [String: SyncTypeCount] = [:]
    var batches = 0
    var inserted = 0
    var updated = 0
    var unchanged = 0
    var deleted = 0
    var rejected = 0
    var durationMs = 0
    /// Part of the history backfill.
    var history = false

    var id: Int { seq }
    var itemCount: Int { types.values.reduce(0) { $0 + $1.items } }
}

protocol SyncLogging: Sendable {
    func append(_ entry: SyncLogEntry) async -> SyncLogEntry
    /// Newest first.
    func recent(limit: Int) async -> [SyncLogEntry]
    func removeAll() async
}

actor SyncLog: SyncLogging {
    static let retention: TimeInterval = 30 * 24 * 3600

    private let url: URL
    private let now: @Sendable () -> Date
    private var opened = false
    private var nextSeq = 1
    private var filePath: String { url.path(percentEncoded: false) }

    init(url: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url
        self.now = now
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    /// Writes the entry with the next number. A line that cannot be written
    /// is lost; the sync itself already happened.
    func append(_ entry: SyncLogEntry) -> SyncLogEntry {
        open()
        var entry = entry
        entry.seq = nextSeq
        nextSeq += 1
        guard var data = try? Self.encoder.encode(entry) else { return entry }
        data.append(0x0A)
        do {
            if !FileManager.default.fileExists(atPath: filePath) {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                _ = FileManager.default.createFile(atPath: filePath, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {}
        return entry
    }

    func recent(limit: Int) -> [SyncLogEntry] {
        open()
        return Array(entries().reversed().prefix(limit))
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: url)
    }

    /// Drops lines past the retention and finds the last number.
    private func open() {
        guard !opened else { return }
        opened = true
        let all = entries()
        let cutoff = now().addingTimeInterval(-Self.retention)
        let kept = all.filter { $0.time >= cutoff }
        nextSeq = (all.map(\.seq).max() ?? 0) + 1
        guard kept.count != all.count else { return }
        let text = kept.compactMap { try? Self.encoder.encode($0) }.map { (String(data: $0, encoding: .utf8) ?? "") + "\n" }.joined()
        try? Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func entries() -> [SyncLogEntry] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { try? Self.decoder.decode(SyncLogEntry.self, from: Data($0.utf8)) }
    }
}
