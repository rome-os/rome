import Foundation

/// Where a source's sync stands, kept across launches: each type's HealthKit
/// anchor, the backfill cursor, the reconcile dates and the sleep map. In
/// Application Support with `completeUntilFirstUserAuthentication`, so a
/// background wake after the first unlock can read and write it.
struct SyncProgress: Codable, Equatable, Sendable {
    /// The Rome this progress was sent to. Another Rome starts over.
    var instanceId: String?
    /// HealthKit's anchor per type (an archived `HKQueryAnchor`), taken
    /// before the backfill: changes after it come through the delta.
    var anchors: [String: Data] = [:]
    var backfill: Backfill?
    var lastDailyReconcile: Date?
    var lastWeeklyReconcile: Date?
    /// Sleep segment id → the wake date (`YYYY-MM-DD`) of its night, for the
    /// last 60 days: a deleted segment names no time, so this says which
    /// night to compute again.
    var sleepNights: [String: String] = [:]
    /// What each type has synced through, as last told to the Rome.
    var syncedThrough: [String: Date] = [:]
    /// The last delta the Rome has: every change up to then is sent. With
    /// the history (everything before the backfill's start), it is how far
    /// a type is synced with no gap.
    var deltaThrough: Date?
    /// Types this Rome refused as unknown: not sent again until it updates.
    var unsupported: Set<String> = []

    struct Backfill: Codable, Equatable, Sendable {
        /// When sync was turned on: the backfill reads back from here.
        var start: Date
        /// 183 days before `start`. Nothing older is read.
        var floor: Date
        /// Everything from here to `start` is sent; the next chunk ends here.
        var cursor: Date

        var isDone: Bool { cursor <= floor }
    }
}

protocol ProgressStoring: Sendable {
    func load() async -> SyncProgress
    func save(_ progress: SyncProgress) async
    func removeAll() async
}

actor AnchorStore: ProgressStoring {
    private let url: URL
    private var cached: SyncProgress?

    init(url: URL) { self.url = url }

    func load() -> SyncProgress {
        if let cached { return cached }
        let decoded = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(SyncProgress.self, from: $0) }
        let progress = decoded ?? SyncProgress()
        cached = progress
        return progress
    }

    func save(_ progress: SyncProgress) {
        cached = progress
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(progress).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {}
    }

    func removeAll() {
        cached = SyncProgress()
        try? FileManager.default.removeItem(at: url)
    }
}

/// An in-memory store, for tests and the demo.
actor MemoryProgressStore: ProgressStoring {
    private var progress = SyncProgress()

    func load() -> SyncProgress { progress }
    func save(_ progress: SyncProgress) { self.progress = progress }
    func removeAll() { progress = SyncProgress() }
}
