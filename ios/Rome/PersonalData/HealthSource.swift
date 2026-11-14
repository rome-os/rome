import Foundation

// Apple Health as a personal-data source. Dense types go as hourly and daily
// buckets (HealthKit's own statistics, which merge iPhone and Watch the way
// the Health app does); sparse ones as one item per sample; sleep as one
// record per night; workouts as one record each. HealthKit stays behind
// `HealthSyncReading`, so this file is the whole plan and tests fill the
// reader in.

// MARK: - Plan

enum HealthSyncShape: Equatable, Sendable {
    /// Hourly and daily buckets: a sum for cumulative types, else avg with min and max.
    case bucket(cumulative: Bool)
    /// One item per sample.
    case sample
    case sleep
    case workouts
}

struct HealthSyncType: Equatable, Sendable {
    let type: HealthType
    let shape: HealthSyncShape
    /// The unit values are sent in: the first of the type's units.
    let unit: String

    var name: String { type.name }
}

enum HealthSyncPlan {
    /// Every type `health.stats` reads, in the same order.
    static let all: [HealthSyncType] = HealthTypes.all.map { type in
        switch type.kind {
        case .quantity(let cumulative):
            return HealthSyncType(type: type, shape: dense.contains(type.name) ? .bucket(cumulative: cumulative) : .sample, unit: type.units.first?.name ?? "")
        case .mindful: return HealthSyncType(type: type, shape: .sample, unit: "min")
        case .sleep: return HealthSyncType(type: type, shape: .sleep, unit: "min")
        case .workouts: return HealthSyncType(type: type, shape: .workouts, unit: "min")
        }
    }

    /// Types with many samples a day: sent as buckets, never sample by sample.
    static let dense: Set<String> = [
        "stepCount", "distanceWalkingRunning", "distanceCycling", "flightsClimbed", "activeEnergyBurned",
        "basalEnergyBurned", "appleExerciseTime", "appleStandTime", "dietaryEnergyConsumed", "dietaryWater",
        "heartRate", "respiratoryRate", "oxygenSaturation", "heartRateVariabilitySDNN",
    ]

    static func named(_ name: String) -> HealthSyncType? { all.first { $0.name == name } }

    /// How far the backfill reaches back.
    static let historyDays = 183
    /// The history goes in chunks of this many days, newest first.
    static let historyChunkDays = 7
    /// Hour buckets cover this many days, today included; older days have
    /// day buckets only. A day that ages past it keeps the hours it has.
    static let hourlyDays = 14

    /// The first hour that still gets hour buckets, as of `now`.
    static func hourFloor(_ now: Date, calendar: Calendar) -> Date {
        calendar.date(byAdding: .day, value: -(hourlyDays - 1), to: calendar.startOfDay(for: now)) ?? now
    }
    /// A deleted sample names no time: this many recent days are computed again.
    static let deletionDays = 7
    static let dailyReconcileDays = 7
    static let weeklyReconcileDays = 90
    /// How long the sleep map keeps a segment.
    static let sleepMapDays = 60
    /// The delta tracks samples that start this many days before sync was
    /// turned on, or later. HealthKit has no "anchor as of now" without
    /// reading what the anchor covers, so a narrow window keeps taking it
    /// cheap; a later sample that starts earlier still is caught by the reconcile.
    static let deltaOverlapDays = 7

    /// Where a backfill's delta window starts.
    static func deltaFrom(_ start: Date) -> Date { start.addingTimeInterval(-Double(deltaOverlapDays) * 86_400) }

    /// Where a type's anchored query starts. A dense type's samples are many,
    /// so its anchor covers a week before sync was turned on, and the
    /// reconcile catches a later change further back. A sparse type (a weight,
    /// a workout, a night) is anchored over the whole history, so a reading
    /// imported later with an older date still comes through.
    static func anchorFrom(_ type: HealthSyncType, start: Date, floor: Date) -> Date {
        if case .bucket = type.shape { return deltaFrom(start) }
        return floor
    }
}

// MARK: - Reading

enum BucketResolution: String, Sendable { case hour, day }

/// One hour's or day's statistics.
struct HealthBucketValue: Equatable, Sendable {
    let start: Date
    let end: Date
    let value: Double
    var min: Double?
    var max: Double?
}

/// A sample with its HealthKit id.
struct HealthRecord: Equatable, Sendable {
    let id: String
    let start: Date
    let end: Date
    /// A quantity, in the type's sync unit.
    var value: Double?
    var stage: SleepStage?
    var workout: WorkoutRecord?
    var sourceApp: String?
}

/// What changed in one type since an anchor.
struct HealthChanges: Equatable, Sendable {
    var added: [HealthRecord] = []
    var deleted: [String] = []
    var anchor: Data
}

protocol HealthSyncReading: Sendable {
    /// The type's anchor as of now, over the samples that start at `from`
    /// or later: reading it reads those samples, so `from` keeps it short.
    func currentAnchor(_ type: HealthSyncType, from: Date) async throws -> Data
    /// Samples starting at `from` or later that were added or deleted since
    /// `anchor`, and the anchor after them.
    func changes(_ type: HealthSyncType, since anchor: Data, from: Date) async throws -> HealthChanges
    /// Whole local hours or days of the window, only those with a value.
    func buckets(_ type: HealthSyncType, _ resolution: BucketResolution, in window: DateInterval, calendar: Calendar) async throws -> [HealthBucketValue]
    /// Whether the type has any sample that starts in the window: one
    /// look, so the history skips a type the phone never recorded.
    func hasSamples(_ type: HealthSyncType, in window: DateInterval) async throws -> Bool
    /// The samples that start in the window: sparse quantities, mindful
    /// sessions, workouts and sleep segments.
    func records(_ type: HealthSyncType, in window: DateInterval) async throws -> [HealthRecord]
}

// MARK: - Source

actor AppleHealthSource: PersonalDataSource {
    nonisolated let id = "apple_health"

    private let reader: HealthSyncReading
    private let store: ProgressStoring
    private let calendar: @Sendable () -> Calendar
    private let plan: [HealthSyncType]

    /// This run's state: what it has already read.
    private var run: (trigger: SyncTrigger, now: Date, deltaDone: Bool, reconcileDone: Bool)?

    init(reader: HealthSyncReading, store: ProgressStoring, plan: [HealthSyncType] = HealthSyncPlan.all, calendar: @escaping @Sendable () -> Calendar = { Calendar.current }) {
        self.reader = reader
        self.store = store
        self.plan = plan
        self.calendar = calendar
    }

    private var zone: String { calendar().timeZone.identifier }

    func beginRun(trigger: SyncTrigger, instanceId: String, now: Date) async throws {
        run = (trigger, now, false, false)
        var progress = await store.load()
        if trigger == .manual, !progress.unsupported.isEmpty, let backfill = progress.backfill {
            // Types this Rome once refused were left out of the history: it is
            // read again, so no type is synced through without its months.
            // The Rome takes the rest again as unchanged.
            progress.unsupported = []
            let calendar = calendar()
            progress.backfill?.cursor = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: backfill.start)) ?? backfill.start
        }
        guard progress.instanceId != instanceId || progress.backfill == nil else {
            await store.save(progress)
            return
        }
        // A Rome that has nothing from this phone yet: every anchor is taken
        // now, before the history is read, so a change made during the
        // backfill comes through the next delta.
        var fresh = SyncProgress(instanceId: instanceId)
        let calendar = calendar()
        let today = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: 1, to: today) ?? now
        let floor = calendar.date(byAdding: .day, value: -HealthSyncPlan.historyDays, to: today) ?? today
        for type in plan {
            fresh.anchors[type.name] = try await reader.currentAnchor(type, from: HealthSyncPlan.anchorFrom(type, start: now, floor: floor))
        }
        fresh.backfill = SyncProgress.Backfill(start: now, floor: floor, cursor: end)
        // One look per type: a type with nothing in the window is left out
        // of the history, which then reads only what the phone recorded.
        var skipped = Set<String>()
        let window = DateInterval(start: floor, end: max(floor, now))
        for type in plan {
            if try await !reader.hasSamples(type, in: window) { skipped.insert(type.name) }
        }
        fresh.backfill?.skipped = skipped
        await store.save(fresh)
    }

    func nextChunk() async throws -> SyncChunk? {
        guard let current = run else { return nil }
        let progress = await store.load()
        if !current.deltaDone {
            run?.deltaDone = true
            let chunk = try await delta(progress, now: current.now)
            if chunk.itemCount > 0 || !chunk.marks.isEmpty || chunk.commit != progress { return chunk }
        }
        if !current.reconcileDone {
            run?.reconcileDone = true
            if let chunk = try await reconcile(progress, now: current.now) { return chunk }
        }
        if let backfill = progress.backfill, !backfill.isDone {
            return try await history(progress, backfill: backfill)
        }
        return nil
    }

    func confirm(_ chunk: SyncChunk, unsupported: Set<String>) async {
        // Reset meanwhile: what the chunk read belongs to progress that is gone.
        guard run != nil else { return }
        let before = await store.load()
        var progress = chunk.commit
        for type in unsupported {
            progress.anchors[type] = before.anchors[type]
            progress.syncedThrough[type] = before.syncedThrough[type]
            progress.unsupported.insert(type)
        }
        await store.save(progress)
    }

    func reset() async {
        run = nil
        await store.removeAll()
    }

    func historyCursor() async -> Date? {
        let progress = await store.load()
        guard let backfill = progress.backfill, !backfill.isDone else { return nil }
        return backfill.cursor
    }

    private func active(_ progress: SyncProgress) -> [HealthSyncType] {
        plan.filter { !progress.unsupported.contains($0.name) }
    }

    // MARK: Delta

    private func delta(_ progress: SyncProgress, now: Date) async throws -> SyncChunk {
        var chunk = SyncChunk(kind: .delta, commit: progress)
        let calendar = calendar()
        let floor = progress.backfill?.floor ?? calendar.date(byAdding: .day, value: -HealthSyncPlan.historyDays, to: now) ?? now
        for type in active(progress) {
            let from = HealthSyncPlan.anchorFrom(type, start: progress.backfill?.start ?? now, floor: floor)
            let anchor: Data
            if let saved = progress.anchors[type.name] {
                anchor = saved
            } else {
                chunk.commit.anchors[type.name] = try await reader.currentAnchor(type, from: from)
                continue
            }
            let changes = try await reader.changes(type, since: anchor, from: from)
            chunk.commit.anchors[type.name] = changes.anchor
            switch type.shape {
            case .bucket:
                var days = Set<Date>()
                for record in changes.added { days.formUnion(Self.days(from: record.start, to: record.end, calendar: calendar)) }
                if !changes.deleted.isEmpty {
                    let today = calendar.startOfDay(for: now)
                    for back in 0..<HealthSyncPlan.deletionDays {
                        if let day = calendar.date(byAdding: .day, value: -back, to: today) { days.insert(day) }
                    }
                }
                for range in Self.ranges(days.filter { $0 >= floor && $0 <= now }, calendar: calendar) {
                    try await addBuckets(type, in: range, emptyDeletes: !changes.deleted.isEmpty, now: now, to: &chunk)
                }
            case .sample, .workouts:
                for record in changes.added where record.start >= floor { add(record, of: type, to: &chunk) }
                for id in changes.deleted { chunk.deletes.append("\(type.name):\(id)") }
            case .sleep:
                var nights = Set<String>()
                for record in changes.added where record.end >= floor {
                    let night = Self.wakeDay(record.end, calendar: calendar)
                    nights.insert(night)
                    chunk.commit.sleepNights[record.id] = night
                }
                for id in changes.deleted {
                    if let night = chunk.commit.sleepNights.removeValue(forKey: id) { nights.insert(night) }
                }
                for night in nights.sorted() { try await addNight(night, to: &chunk, calendar: calendar) }
            }
            // Synced through now only once the history below it is in: the
            // Rome never hears of coverage the phone has not sent.
            if progress.backfill?.isDone ?? true {
                chunk.marks.append(.init(type: type.name, syncedThrough: WireTime.string(now)))
                chunk.commit.syncedThrough[type.name] = now
            }
        }
        chunk.commit.deltaThrough = now
        Self.trimSleepMap(&chunk.commit, now: now, calendar: calendar)
        return chunk
    }

    // MARK: Reconcile

    /// The last 7 days once a day and the last 90 once a week, computed again
    /// in full. Only after the backfill: until then the history covers them.
    private func reconcile(_ progress: SyncProgress, now: Date) async throws -> SyncChunk? {
        guard let backfill = progress.backfill, backfill.isDone else { return nil }
        let weekly = progress.lastWeeklyReconcile.map { now.timeIntervalSince($0) >= 7 * 86_400 } ?? true
        let daily = progress.lastDailyReconcile.map { now.timeIntervalSince($0) >= 86_400 } ?? true
        guard weekly || daily else { return nil }
        let calendar = calendar()
        let days = weekly ? HealthSyncPlan.weeklyReconcileDays : HealthSyncPlan.dailyReconcileDays
        let today = calendar.startOfDay(for: now)
        let start = max(backfill.floor, calendar.date(byAdding: .day, value: -(days - 1), to: today) ?? today)
        let end = calendar.date(byAdding: .day, value: 1, to: today) ?? now
        var chunk = SyncChunk(kind: .reconcile, commit: progress)
        let window = DateInterval(start: start, end: end)
        for type in active(progress) {
            switch type.shape {
            case .bucket: try await addBuckets(type, in: window, emptyDeletes: true, now: now, to: &chunk)
            case .sleep:
                // One read for every night of the window, not one per night.
                let segments = try await reader.records(type, in: DateInterval(start: start.addingTimeInterval(-18 * 3600), end: end))
                var day = start
                while day < end {
                    try await addNight(WireTime.day(day, calendar: calendar), to: &chunk, calendar: calendar, segments: segments)
                    guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
                    day = next
                }
            case .sample, .workouts: break
            }
        }
        chunk.commit.lastDailyReconcile = now
        if weekly { chunk.commit.lastWeeklyReconcile = now }
        return chunk
    }

    // MARK: History

    /// A week back from the cursor, every type: a few thousand items at
    /// most, so a background wake can finish one and keep it.
    private func history(_ progress: SyncProgress, backfill: SyncProgress.Backfill) async throws -> SyncChunk {
        let calendar = calendar()
        let weekBack = calendar.date(byAdding: .day, value: -HealthSyncPlan.historyChunkDays, to: backfill.cursor) ?? backfill.cursor
        let start = max(backfill.floor, calendar.startOfDay(for: weekBack))
        let window = DateInterval(start: start, end: backfill.cursor)
        var chunk = SyncChunk(kind: .backfill, historyMonth: start, commit: progress)
        for type in active(progress) where !(backfill.skipped ?? []).contains(type.name) {
            switch type.shape {
            case .bucket:
                try await addBuckets(type, in: window, emptyDeletes: false, now: backfill.start, to: &chunk)
            case .sample, .workouts:
                for record in try await reader.records(type, in: window) { add(record, of: type, to: &chunk) }
            case .sleep:
                // A night belongs to the day it ends on, so the window's first
                // night starts the evening before.
                var nights = Set<String>()
                let segments = try await reader.records(type, in: DateInterval(start: window.start.addingTimeInterval(-18 * 3600), end: window.end))
                let mapFloor = calendar.date(byAdding: .day, value: -HealthSyncPlan.sleepMapDays, to: backfill.start) ?? backfill.start
                for segment in segments {
                    let night = Self.wakeDay(segment.end, calendar: calendar)
                    guard let date = Self.date(day: night, calendar: calendar), window.contains(date) else { continue }
                    nights.insert(night)
                    if segment.end >= mapFloor { chunk.commit.sleepNights[segment.id] = night }
                }
                for night in nights.sorted() { try await addNight(night, to: &chunk, calendar: calendar, segments: segments) }
            }
        }
        chunk.commit.backfill?.cursor = start
        if start <= backfill.floor {
            // The last month of history: from the floor to the backfill's
            // start is in, and the deltas carry on from there with no gap.
            // The history is fresh, so the first reconcile waits its turn.
            chunk.commit.lastDailyReconcile = backfill.start
            chunk.commit.lastWeeklyReconcile = backfill.start
            let through = max(backfill.start, progress.deltaThrough ?? backfill.start)
            for type in active(progress) {
                chunk.marks.append(.init(type: type.name, syncedThrough: WireTime.string(through)))
                chunk.commit.syncedThrough[type.name] = through
            }
        }
        return chunk
    }

    // MARK: Items

    /// Hour buckets for the last `hourlyDays` as of `now`, day buckets for
    /// the whole window. HealthKit's statistics have no bucket for an hour
    /// or day without samples, so an empty one is never sent.
    private func addBuckets(_ type: HealthSyncType, in window: DateInterval, emptyDeletes: Bool, now: Date, to chunk: inout SyncChunk) async throws {
        let calendar = calendar()
        let hourFloor = HealthSyncPlan.hourFloor(now, calendar: calendar)
        for resolution in [BucketResolution.hour, .day] {
            var window = window
            if resolution == .hour {
                guard window.end > hourFloor else { continue }
                window = DateInterval(start: max(window.start, hourFloor), end: window.end)
            }
            let values = try await reader.buckets(type, resolution, in: window, calendar: calendar)
            var seen = Set<String>()
            for value in values {
                let key = Self.bucketKey(type.name, resolution, value.start, calendar: calendar)
                seen.insert(key)
                var fields: [String: Double]?
                if case .bucket(cumulative: false) = type.shape {
                    var extra: [String: Double] = [:]
                    if let min = value.min { extra["min"] = Self.rounded(min) }
                    if let max = value.max { extra["max"] = Self.rounded(max) }
                    fields = extra.isEmpty ? nil : extra
                }
                chunk.upserts.append(PersonalDataPoint(
                    key: key, type: type.name, shape: .bucket, resolution: resolution.rawValue,
                    start: WireTime.string(value.start), end: WireTime.string(value.end), tz: zone,
                    value: Self.rounded(value.value), unit: type.unit, fields: fields
                ))
                count(type.name, value.start, value.end, in: &chunk)
            }
            // A bucket whose samples were all deleted has no value now: its
            // old one goes. Hours only inside the hourly days.
            guard emptyDeletes else { continue }
            for start in Self.slots(resolution, in: window, calendar: calendar) {
                let key = Self.bucketKey(type.name, resolution, start, calendar: calendar)
                if !seen.contains(key) { chunk.deletes.append(key) }
            }
        }
    }

    private func add(_ record: HealthRecord, of type: HealthSyncType, to chunk: inout SyncChunk) {
        var point = PersonalDataPoint(
            key: "\(type.name):\(record.id)", type: type.name, shape: type.shape == .workouts ? .record : .sample,
            start: WireTime.string(record.start), end: WireTime.string(record.end), tz: zone, unit: type.unit
        )
        var metadata: [String: String] = [:]
        if let app = record.sourceApp, !app.isEmpty { metadata["sourceApp"] = String(app.prefix(100)) }
        switch type.shape {
        case .workouts:
            guard let workout = record.workout else { return }
            point.value = Self.rounded(workout.durationMinutes)
            var fields: [String: Double] = [:]
            if let energy = workout.activeEnergyKcal { fields["activeEnergyKcal"] = Self.rounded(energy) }
            if let distance = workout.distanceMeters { fields["distanceMeters"] = Self.rounded(distance) }
            point.fields = fields.isEmpty ? nil : fields
            metadata["activity"] = workout.activity
        case .sample where type.type.kind == .mindful:
            point.value = Self.rounded(record.end.timeIntervalSince(record.start) / 60)
        default:
            guard let value = record.value else { return }
            point.value = Self.rounded(value)
        }
        // A workout or session longer than the Rome takes is not a reading it can use.
        guard record.end >= record.start, record.end.timeIntervalSince(record.start) <= 7 * 86_400 else { return }
        if type.shape == .workouts, record.end == record.start { return }
        point.metadata = metadata.isEmpty ? nil : metadata
        chunk.upserts.append(point)
        count(type.name, record.start, record.end, in: &chunk)
    }

    /// The night that ends on `day`: asleep minutes and minutes per stage, the
    /// merge `health.stats` uses. A night with nothing left is deleted.
    private func addNight(_ day: String, to chunk: inout SyncChunk, calendar: Calendar, segments: [HealthRecord]? = nil) async throws {
        guard let wake = Self.date(day: day, calendar: calendar), let type = plan.first(where: { $0.shape == .sleep }) else { return }
        let window = Self.nightWindow(wake, calendar: calendar)
        let found: [HealthRecord]
        if let segments {
            found = segments
        } else {
            found = try await reader.records(type, in: DateInterval(start: window.start.addingTimeInterval(-18 * 3600), end: window.end))
        }
        let mine = found.filter { window.contains($0.end) || $0.end == window.end }
        let key = "sleep:night:\(day)"
        let summary = SleepMath.summarize(mine.map { HealthSegment(start: $0.start, end: $0.end, stage: $0.stage) }, in: window)
        guard let first = mine.map(\.start).min(), let last = mine.map(\.end).max(), summary.asleepMinutes > 0 || (summary.stages[.inBed] ?? 0) > 0 else {
            chunk.deletes.append(key)
            return
        }
        var fields: [String: Double] = [:]
        for (stage, minutes) in summary.stages where minutes > 0 { fields[stage.rawValue] = Self.rounded(minutes) }
        let start = max(first, window.start), end = min(last, window.end)
        guard end > start else { return }
        chunk.upserts.append(PersonalDataPoint(
            key: key, type: "sleep", shape: .record, start: WireTime.string(start), end: WireTime.string(end), tz: zone,
            value: Self.rounded(summary.asleepMinutes), unit: "min", fields: fields
        ))
        count("sleep", start, end, in: &chunk)
    }

    private func count(_ type: String, _ start: Date, _ end: Date, in chunk: inout SyncChunk) {
        var entry = chunk.counts[type] ?? SyncTypeCount(items: 0)
        entry.items += 1
        entry.start = min(entry.start ?? start, start)
        entry.end = max(entry.end ?? end, end)
        chunk.counts[type] = entry
    }

    // MARK: Time

    static func bucketKey(_ type: String, _ resolution: BucketResolution, _ start: Date, calendar: Calendar) -> String {
        switch resolution {
        case .hour: return "\(type):hour:\(WireTime.string(start))"
        // The bucket's start instant, as the Rome keys it: a local date alone
        // reads as UTC midnight there, and a delete would miss its bucket.
        case .day: return "\(type):day:\(WireTime.string(start))"
        }
    }

    /// The local days a sample touches.
    static func days(from start: Date, to end: Date, calendar: Calendar) -> [Date] {
        var days: [Date] = []
        var day = calendar.startOfDay(for: start)
        let last = calendar.startOfDay(for: max(start, end.addingTimeInterval(end > start ? -1 : 0)))
        while day <= last, days.count <= HealthSyncPlan.historyDays {
            days.append(day)
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }
        return days
    }

    /// Days joined into runs of consecutive days.
    static func ranges(_ days: Set<Date>, calendar: Calendar) -> [DateInterval] {
        var ranges: [DateInterval] = []
        for day in days.sorted() {
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { continue }
            if let last = ranges.last, last.end >= day {
                ranges[ranges.count - 1] = DateInterval(start: last.start, end: max(last.end, next))
            } else {
                ranges.append(DateInterval(start: day, end: next))
            }
        }
        return ranges
    }

    /// The starts of the whole hours or days in the window.
    static func slots(_ resolution: BucketResolution, in window: DateInterval, calendar: Calendar) -> [Date] {
        let component: Calendar.Component = resolution == .hour ? .hour : .day
        guard var cursor = calendar.dateInterval(of: component, for: window.start)?.start else { return [] }
        var slots: [Date] = []
        while cursor < window.end {
            slots.append(cursor)
            guard let next = calendar.date(byAdding: component, value: 1, to: cursor), next > cursor else { break }
            cursor = next
        }
        return slots
    }

    /// A night belongs to the day it ends on: from 6 PM the evening before to
    /// 6 PM that day.
    static func nightWindow(_ wake: Date, calendar: Calendar) -> DateInterval {
        let day = calendar.startOfDay(for: wake)
        let end = calendar.date(byAdding: .hour, value: 18, to: day) ?? day
        let start = calendar.date(byAdding: .day, value: -1, to: end) ?? day
        return DateInterval(start: start, end: end)
    }

    /// The wake date of a sleep segment that ends at `end`.
    static func wakeDay(_ end: Date, calendar: Calendar) -> String {
        let day = calendar.startOfDay(for: end)
        let evening = calendar.date(byAdding: .hour, value: 18, to: day) ?? day
        let wake = end > evening ? calendar.date(byAdding: .day, value: 1, to: day) ?? day : day
        return WireTime.day(wake, calendar: calendar)
    }

    static func date(day: String, calendar: Calendar) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func trimSleepMap(_ progress: inout SyncProgress, now: Date, calendar: Calendar) {
        guard let floor = calendar.date(byAdding: .day, value: -HealthSyncPlan.sleepMapDays, to: now) else { return }
        let cutoff = WireTime.day(floor, calendar: calendar)
        progress.sleepNights = progress.sleepNights.filter { $0.value >= cutoff }
    }

    /// Four decimals: enough for every Health unit, and a value read twice
    /// hashes the same on the Rome.
    static func rounded(_ value: Double) -> Double {
        (value * 10_000).rounded() / 10_000
    }
}
