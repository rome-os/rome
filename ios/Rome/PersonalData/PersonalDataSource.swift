import Foundation

// A source of personal data on this phone, such as Apple Health. It reads what
// changed in chunks; the sync engine sends each chunk and, once the Rome has
// all of it, confirms it, which is the only time the source's saved progress
// (anchors, the backfill cursor) moves. A crash or a failed upload reads the
// same changes again, and the Rome's ingest makes a repeat harmless.

/// What one chunk sends, and the progress it saves once the Rome has it.
struct SyncChunk: Sendable {
    enum Kind: String, Sendable {
        /// What changed since the saved anchors.
        case delta
        /// Recent days computed again, so a change HealthKit could not place is caught.
        case reconcile
        /// A month of history, newest first.
        case backfill
    }

    let kind: Kind
    var upserts: [PersonalDataPoint] = []
    var deletes: [String] = []
    /// What each type has synced through, sent with the chunk's last batch.
    var marks: [PersonalDataEnvelope.TypeMark] = []
    /// Per type, for the sync history: how many items and the time they cover.
    var counts: [String: SyncTypeCount] = [:]
    /// The month a history chunk reads, for "Syncing history · Aug 2026".
    var historyMonth: Date?
    /// The progress to keep once the Rome has the whole chunk.
    var commit: SyncProgress

    var itemCount: Int { upserts.count + deletes.count }
}

protocol PersonalDataSource: Sendable {
    /// The Rome's name for it: `apple_health`.
    var id: String { get }
    /// Starts one sync to `instanceId`. Progress kept for another Rome is
    /// dropped, and a source with no progress takes its anchors and starts
    /// its backfill here.
    func beginRun(trigger: SyncTrigger, instanceId: String, now: Date) async throws
    /// The next chunk of this run; nil when the run has nothing more to send.
    func nextChunk() async throws -> SyncChunk?
    /// The Rome has the chunk: its progress is kept. Types the Rome refused
    /// as unknown keep their old anchors and are left out from now on.
    func confirm(_ chunk: SyncChunk, unsupported: Set<String>) async
    /// Forgets all progress: the next run starts a new backfill.
    func reset() async
    /// The backfill's cursor while history is still being sent, else nil.
    func historyCursor() async -> Date?
}

/// ISO 8601 in UTC without fractions, the way keys and the wire write times.
enum WireTime {
    nonisolated(unsafe) private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private static let lock = NSLock()

    static func string(_ date: Date) -> String {
        lock.withLock { formatter.string(from: date) }
    }

    /// `YYYY-MM-DD` in the calendar's zone.
    static func day(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
