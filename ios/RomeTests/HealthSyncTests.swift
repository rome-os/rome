import Foundation
import Testing
@testable import Rome

// MARK: - Fakes

/// Health as the sync reads it: samples per type, each stamped with the
/// version it was added at, so an anchor is just a version number.
final class FakeHealthSync: HealthSyncReading, @unchecked Sendable {
    struct Stored {
        var record: HealthRecord
        var version: Int
    }

    private let lock = NSLock()
    private var version = 0
    private var stored: [String: [Stored]] = [:]
    private var deletions: [String: [(id: String, version: Int)]] = [:]
    private(set) var readCount = 0
    var failure: Error?

    func add(_ type: String, id: String, start: Date, end: Date? = nil, value: Double? = nil, stage: SleepStage? = nil, workout: WorkoutRecord? = nil) {
        lock.withLock {
            version += 1
            stored[type, default: []].append(Stored(record: HealthRecord(id: id, start: start, end: end ?? start.addingTimeInterval(60), value: value, stage: stage, workout: workout, sourceApp: "Health"), version: version))
        }
    }

    func delete(_ type: String, id: String) {
        lock.withLock {
            version += 1
            stored[type]?.removeAll { $0.record.id == id }
            deletions[type, default: []].append((id, version))
        }
    }

    private func anchor(_ value: Int) -> Data { Data(String(value).utf8) }
    private func version(_ data: Data) -> Int { Int(String(data: data, encoding: .utf8) ?? "") ?? 0 }

    private func read() throws {
        try lock.withLock {
            readCount += 1
            if let failure { throw failure }
        }
    }

    func currentAnchor(_ type: HealthSyncType, from: Date) async throws -> Data {
        try read()
        return lock.withLock { anchor(version) }
    }

    func changes(_ type: HealthSyncType, since anchor: Data, from: Date) async throws -> HealthChanges {
        try read()
        let since = version(anchor)
        return lock.withLock {
            HealthChanges(
                added: (stored[type.name] ?? []).filter { $0.version > since && $0.record.start >= from }.map(\.record),
                deleted: (deletions[type.name] ?? []).filter { $0.version > since }.map(\.id),
                anchor: self.anchor(version)
            )
        }
    }

    func buckets(_ type: HealthSyncType, _ resolution: BucketResolution, in window: DateInterval, calendar: Calendar) async throws -> [HealthBucketValue] {
        try read()
        let records = lock.withLock { (stored[type.name] ?? []).map(\.record) }
        var grouped: [Date: [Double]] = [:]
        for record in records where record.start >= window.start && record.start < window.end {
            guard let value = record.value, let slot = calendar.dateInterval(of: resolution == .hour ? .hour : .day, for: record.start)?.start else { continue }
            grouped[slot, default: []].append(value)
        }
        return grouped.keys.sorted().map { start in
            let values = grouped[start]!
            let end = calendar.date(byAdding: resolution == .hour ? .hour : .day, value: 1, to: start)!
            if case .bucket(cumulative: true) = type.shape { return HealthBucketValue(start: start, end: end, value: values.reduce(0, +)) }
            return HealthBucketValue(start: start, end: end, value: values.reduce(0, +) / Double(values.count), min: values.min(), max: values.max())
        }
    }

    private(set) var lookups: [String] = []

    func hasSamples(_ type: HealthSyncType, in window: DateInterval) async throws -> Bool {
        try read()
        return lock.withLock {
            lookups.append(type.name)
            return (stored[type.name] ?? []).contains { $0.record.start >= window.start && $0.record.start < window.end }
        }
    }

    func records(_ type: HealthSyncType, in window: DateInterval) async throws -> [HealthRecord] {
        try read()
        return lock.withLock { (stored[type.name] ?? []).map(\.record).filter { $0.start >= window.start && $0.start < window.end } }
    }
}

/// The Rome's personal-data routes: keeps every batch, answers as told.
actor FakePersonalDataBackend: PersonalDataBackend {
    private(set) var envelopes: [PersonalDataEnvelope] = []
    private(set) var states: [String] = []
    private(set) var deletes = 0
    /// Each ingest takes the next failure, if any.
    var failures: [PersonalDataFailure] = []
    var rejectUnknown: Set<String> = []
    var gate: CheckedContinuation<Void, Never>?
    var holding = false

    func fail(_ failures: PersonalDataFailure...) { self.failures = failures }
    func reject(_ types: Set<String>) { rejectUnknown = types }
    func hold() { holding = true }
    func release() {
        holding = false
        gate?.resume()
        gate = nil
    }

    var upserts: [PersonalDataPoint] { envelopes.flatMap(\.upserts) }
    var deleteKeys: [String] { envelopes.flatMap(\.deletes).map(\.key) }

    func ingest(_ envelope: PersonalDataEnvelope) async throws(PersonalDataFailure) -> PersonalDataIngestReply {
        if holding { await withCheckedContinuation { gate = $0 } }
        if !failures.isEmpty { throw failures.removeFirst() }
        envelopes.append(envelope)
        let rejected = envelope.upserts.enumerated().filter { rejectUnknown.contains($0.element.type) }.map {
            PersonalDataIngestReply.Rejected(index: $0.offset, key: $0.element.key, code: "unknown_type")
        }
        return PersonalDataIngestReply(
            batchId: envelope.batch.id, status: rejected.isEmpty ? "ok" : "partial", inserted: envelope.upserts.count - rejected.count,
            updated: 0, unchanged: 0, deleted: envelope.deletes.count, rejected: rejected, receivedAt: nil
        )
    }

    func sources() async throws(PersonalDataFailure) -> [PersonalDataCatalogSource] { [] }

    func setState(source: String, origin: String, state: String) async throws(PersonalDataFailure) { states.append(state) }

    func deleteOrigin(source: String, origin: String) async throws(PersonalDataFailure) -> Int {
        if !failures.isEmpty { throw failures.removeFirst() }
        deletes += 1
        return 42
    }
}

actor MemorySyncLog: SyncLogging {
    private(set) var entries: [SyncLogEntry] = []

    func append(_ entry: SyncLogEntry) -> SyncLogEntry {
        var entry = entry
        entry.seq = entries.count + 1
        entries.append(entry)
        return entry
    }

    func recent(limit: Int) -> [SyncLogEntry] { Array(entries.reversed().prefix(limit)) }
    func removeAll() { entries = [] }
}

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ start: Date) { value = start }

    var now: Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

final class Flags: @unchecked Sendable {
    private let lock = NSLock()
    private var state = (enabled: true, unlocked: true, instance: "inst-1")

    var switches: SyncSwitches { lock.withLock { SyncSwitches(enabled: state.enabled) } }
    var unlocked: Bool { lock.withLock { state.unlocked } }
    var instance: String { lock.withLock { state.instance } }
    func set(enabled: Bool) { lock.withLock { state.enabled = enabled } }
    func set(unlocked: Bool) { lock.withLock { state.unlocked = unlocked } }
    func set(instance: String) { lock.withLock { state.instance = instance } }
}

/// An engine over the fakes, in Shanghai, on 2026-11-09 18:30.
struct SyncRig {
    let health = FakeHealthSync()
    let backend = FakePersonalDataBackend()
    let log = MemorySyncLog()
    let progress = MemoryProgressStore()
    let clock = Clock(HealthFixtures.now)
    let flags = Flags()
    let calendar = HealthFixtures.calendar("Asia/Shanghai")
    let source: AppleHealthSource
    let engine: SyncEngine

    /// `pause`: how the engine waits for a retry or a background deadline;
    /// by default a retry never fires by itself in a test.
    init(pause: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in try await Task.sleep(for: .seconds(3600)) }) {
        let calendar = calendar
        source = AppleHealthSource(reader: health, store: progress, calendar: { calendar })
        let backend = backend, flags = flags, clock = clock
        engine = SyncEngine(
            source: source,
            target: { PersonalDataTarget(instanceId: flags.instance, backend: backend) },
            log: log,
            origin: { .init(id: "origin-1", name: "iPhone", platform: "ios", appVersion: "1.6.0") },
            switches: { flags.switches },
            protectedData: { flags.unlocked },
            now: { clock.now },
            random: { 0.5 },
            pause: pause
        )
    }

    func date(_ text: String) -> Date { HealthFixtures.date(text) }

    /// Syncs until the backfill is done, as the first turn-on would.
    func backfill() async {
        await engine.sync(.backfill)
        #expect(await source.historyCursor() == nil, "6 months read in one foreground sync")
    }

    func lastEntry() async -> SyncLogEntry? { await log.entries.last }

    /// Steps in three different weeks, so the history sends three chunks.
    func addThreeWeeks() {
        for (index, day) in ["2026-11-09", "2026-11-01", "2026-10-25"].enumerated() {
            health.add("stepCount", id: "w\(index)", start: date("\(day)T02:00:00Z"), value: 100)
        }
    }

    /// Until the backend holds a batch.
    func waitUntilHeld() async {
        for _ in 0..<500 {
            if await backend.gate != nil { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("no batch was held")
    }
}

// MARK: - Source and engine

@Suite struct HealthSyncTests {
    @Test func theFirstSyncSendsSixMonthsAsBucketsRecordsAndNights() async throws {
        let rig = SyncRig()
        // Steps today, and two months ago; a night's sleep; a run; a weight.
        rig.health.add("stepCount", id: "s1", start: rig.date("2026-11-09T01:10:00Z"), value: 500)
        rig.health.add("stepCount", id: "s2", start: rig.date("2026-11-09T01:40:00Z"), value: 300)
        rig.health.add("stepCount", id: "s3", start: rig.date("2026-09-01T02:00:00Z"), value: 1000)
        rig.health.add("sleep", id: "n1", start: rig.date("2026-11-08T15:00:00Z"), end: rig.date("2026-11-08T21:00:00Z"), stage: .core)
        rig.health.add("workouts", id: "w1", start: rig.date("2026-11-07T10:00:00Z"), end: rig.date("2026-11-07T10:40:00Z"),
                       workout: WorkoutRecord(start: rig.date("2026-11-07T10:00:00Z"), end: rig.date("2026-11-07T10:40:00Z"), activity: "running", durationMinutes: 40, activeEnergyKcal: 380, distanceMeters: 6000))
        rig.health.add("bodyMass", id: "m1", start: rig.date("2026-11-05T00:00:00Z"), value: 70.2)
        // Older than 6 months: never read.
        rig.health.add("stepCount", id: "old", start: rig.date("2026-03-01T02:00:00Z"), value: 9999)
        await rig.backfill()

        let upserts = await rig.backend.upserts
        let keys = Set(upserts.map(\.key))
        #expect(keys.contains("stepCount:hour:2026-11-09T01:00:00Z"))
        #expect(keys.contains("stepCount:day:2026-11-08T16:00:00Z"))
        #expect(keys.contains("stepCount:day:2026-08-31T16:00:00Z"))
        #expect(!keys.contains("stepCount:day:2026-02-28T16:00:00Z"), "nothing older than 6 months")
        #expect(upserts.first { $0.key == "stepCount:hour:2026-11-09T01:00:00Z" }?.value == 800, "an hour sums its samples")
        let night = try #require(upserts.first { $0.key == "sleep:night:2026-11-09" })
        #expect(night.value == 360)
        #expect(night.fields?["core"] == 360)
        let run = try #require(upserts.first { $0.key == "workouts:w1" })
        #expect(run.shape == .record)
        #expect(run.value == 40)
        #expect(run.metadata?["activity"] == "running")
        #expect(run.fields?["distanceMeters"] == 6000)
        #expect(upserts.first { $0.key == "bodyMass:m1" }?.value == 70.2)
        #expect(upserts.allSatisfy { $0.tz == "Asia/Shanghai" })
        #expect(upserts.first { $0.key == "stepCount:hour:2026-11-09T01:00:00Z" }?.unit == "count")
        // Hours for the last 14 days only; older days are day buckets alone.
        #expect(!keys.contains("stepCount:hour:2026-09-01T02:00:00Z"), "no hours for a day two months back")
        // No empty bucket: the two November samples share one hour.
        #expect(upserts.filter { $0.type == "stepCount" }.count == 3, "one hour and one day in November, one day in September")
        #expect(upserts.allSatisfy { $0.value != nil })
        // Each type looked at once; one with nothing is left out of the history but still marked.
        #expect(Set(rig.health.lookups) == Set(HealthSyncPlan.all.map(\.name)))
        #expect(rig.health.lookups.count == HealthSyncPlan.all.count)
        let skipped = await rig.progress.load().backfill?.skipped ?? []
        #expect(skipped.contains("vo2Max") && !skipped.contains("stepCount"))
        let marks = await rig.backend.envelopes.last?.types.map(\.type) ?? []
        #expect(marks.contains("vo2Max"), "an empty window is a complete one")

        let entry = try #require(await rig.lastEntry())
        #expect(entry.outcome == .ok)
        #expect(entry.trigger == .backfill)
        #expect(entry.history)
        #expect(entry.types["stepCount"]?.items == 3)
    }

    @Test func syncedThroughNeverClaimsWhatThePhoneHasNotSent() async throws {
        let rig = SyncRig()
        rig.health.add("stepCount", id: "s1", start: rig.date("2026-11-09T01:10:00Z"), value: 500)
        // A background wake runs out of time before any history is in.
        await rig.engine.sync(.observer, budget: 0)
        #expect(await rig.backend.envelopes.allSatisfy { $0.types.isEmpty }, "nothing is synced through yet")
        // The history goes in, newest month first: no mark until the last month is in.
        await rig.backfill()
        let envelopes = await rig.backend.envelopes
        let marked = envelopes.enumerated().filter { !$0.element.types.isEmpty }
        #expect(marked.count == 1, "one mark, with the oldest month")
        let last = try #require(marked.first)
        #expect(last.offset == envelopes.count - 1, "after every batch of history")
        #expect(Set(last.element.types.map(\.type)) == Set(HealthSyncPlan.all.map(\.name)))
        let through = try #require(last.element.types.first.flatMap { RomeDate.parse($0.syncedThrough) })
        #expect(through <= rig.clock.now, "never past what the deltas have read")
        #expect(through >= HealthFixtures.now, "up to the backfill's start, where the deltas begin")
        // From then on, each delta says how far it has read.
        rig.clock.advance(3600)
        await rig.engine.sync(.manual)
        let next = await rig.backend.envelopes.last { !$0.types.isEmpty }
        #expect(next?.types.first?.syncedThrough == WireTime.string(rig.clock.now))
    }

    @Test func aFailedHistoryBatchMovesNoMark() async throws {
        let rig = SyncRig()
        await rig.engine.sync(.observer, budget: 0)
        // A month of history fails: the Rome never hears the type is complete.
        await rig.backend.fail(.retryable("network"))
        await rig.engine.sync(.manual)
        #expect(await rig.backend.envelopes.allSatisfy { $0.types.isEmpty })
        #expect(await rig.progress.load().syncedThrough.isEmpty)
    }

    @Test func aBatchHoldsAtMostAThousandItemsAndTheMarksGoLast() {
        let points = (0..<2500).map { index in
            PersonalDataPoint(key: "stepCount:hour:\(index)", type: "stepCount", shape: .bucket, resolution: "hour", start: "s", end: "e", tz: "UTC", value: 1, unit: "count")
        }
        let chunk = SyncChunk(kind: .backfill, upserts: points, deletes: ["a", "b"], marks: [.init(type: "stepCount", syncedThrough: "t")], commit: SyncProgress())
        let batches = SyncEngine.batches(chunk)
        #expect(batches.count == 3)
        #expect(batches.allSatisfy { $0.upserts.count + $0.deletes.count <= SyncEngine.maxItems })
        #expect(batches.map { $0.upserts.count + $0.deletes.count }.reduce(0, +) == 2502)
        #expect(SyncEngine.batches(SyncChunk(kind: .delta, marks: [.init(type: "x", syncedThrough: "t")], commit: SyncProgress())).count == 1, "marks alone still go")
        #expect(SyncEngine.batches(SyncChunk(kind: .delta, commit: SyncProgress())).isEmpty)
    }

    @Test func aDeltaSendsOnlyTheDaysThatChanged() async throws {
        let rig = SyncRig()
        rig.health.add("stepCount", id: "s1", start: rig.date("2026-11-01T02:00:00Z"), value: 100)
        await rig.backfill()
        // The day's reconcile, out of the way.
        await rig.engine.sync(.manual)
        let sent = await rig.backend.envelopes.count
        rig.health.add("stepCount", id: "s2", start: rig.date("2026-11-09T03:10:00Z"), value: 250)
        rig.clock.advance(3600)
        await rig.engine.sync(.manual)
        let fresh = await rig.backend.envelopes.dropFirst(sent)
        let keys = Set(fresh.flatMap(\.upserts).map(\.key))
        #expect(keys == ["stepCount:hour:2026-11-09T03:00:00Z", "stepCount:day:2026-11-08T16:00:00Z"])
        #expect(fresh.last?.types.contains { $0.type == "stepCount" } == true, "each type says how far it has synced")
        #expect(fresh.flatMap(\.deletes).isEmpty)
    }

    @Test func aDeletedSampleIsDeletedOnTheRome() async throws {
        let rig = SyncRig()
        rig.health.add("bodyMass", id: "m1", start: rig.date("2026-11-05T00:00:00Z"), value: 70.2)
        await rig.backfill()
        rig.health.delete("bodyMass", id: "m1")
        await rig.engine.sync(.manual)
        #expect(await rig.backend.deleteKeys.contains("bodyMass:m1"))
    }

    @Test func aDeletedStepSampleEmptiesItsBucketOnTheRome() async throws {
        let rig = SyncRig()
        rig.health.add("stepCount", id: "s1", start: rig.date("2026-11-08T02:00:00Z"), value: 100)
        await rig.backfill()
        rig.health.delete("stepCount", id: "s1")
        await rig.engine.sync(.manual)
        let deletes = await rig.backend.deleteKeys
        #expect(deletes.contains("stepCount:hour:2026-11-08T02:00:00Z"))
        #expect(deletes.contains("stepCount:day:2026-11-07T16:00:00Z"))
    }

    @Test func theAnchorMovesOnlyOnceTheRomeHasTheBatch() async throws {
        let rig = SyncRig()
        await rig.backfill()
        rig.health.add("bodyMass", id: "m2", start: rig.date("2026-11-09T05:00:00Z"), value: 70)
        await rig.backend.fail(.retryable("network"))
        await rig.engine.sync(.manual)
        #expect(await rig.lastEntry()?.outcome == .error)
        #expect(await rig.lastEntry()?.errorCode == "network")
        #expect(await !rig.backend.upserts.contains { $0.key == "bodyMass:m2" })
        // The next sync reads the same change again.
        await rig.engine.sync(.manual)
        #expect(await rig.backend.upserts.contains { $0.key == "bodyMass:m2" })
    }

    @Test func aFailureWaitsBeforeABackgroundWakeTriesAgain() async throws {
        let rig = SyncRig()
        await rig.backfill()
        await rig.backend.fail(.retryable("network"))
        await rig.engine.sync(.manual)
        let count = await rig.log.entries.count
        await rig.engine.sync(.observer)
        #expect(await rig.log.entries.count == count, "inside the backoff: no run")
        rig.clock.advance(60)
        await rig.engine.sync(.observer)
        #expect(await rig.log.entries.count == count + 1, "30 s × 1.0 has passed")
        #expect(SyncEngine.backoff(attempt: 0, random: 0.5) == 30)
        #expect(SyncEngine.backoff(attempt: 20, random: 0.5) == 6 * 3600)
    }

    @Test func aLockedPhoneReadsNothing() async throws {
        let rig = SyncRig()
        rig.flags.set(unlocked: false)
        await rig.engine.sync(.observer)
        let entry = try #require(await rig.lastEntry())
        #expect(entry.outcome == .skipped)
        #expect(entry.errorCode == "locked")
        #expect(rig.health.readCount == 0)
        #expect(await rig.backend.envelopes.isEmpty)
    }

    @Test func healthsOwnLockedErrorIsSkippedToo() async throws {
        let rig = SyncRig()
        rig.health.failure = HealthReadError.locked
        await rig.engine.sync(.manual)
        #expect(await rig.lastEntry()?.errorCode == "locked")
        #expect(await rig.lastEntry()?.outcome == .skipped)
    }

    @Test func offReadsAndSendsNothing() async {
        let rig = SyncRig()
        rig.flags.set(enabled: false)
        await rig.engine.sync(.manual)
        #expect(rig.health.readCount == 0)
        #expect(await rig.log.entries.isEmpty)
    }

    @Test func anExpiredSessionStopsBackgroundSyncsUntilTheGuardianActs() async throws {
        let rig = SyncRig()
        await rig.backend.fail(.signedOut)
        await rig.engine.sync(.manual)
        #expect(await rig.lastEntry()?.errorCode == "signed_out")
        #expect(await rig.engine.signedOut)
        let count = await rig.log.entries.count
        rig.clock.advance(7 * 3600)
        await rig.engine.sync(.observer)
        #expect(await rig.log.entries.count == count, "a background wake cannot sign in")
        await rig.engine.signedIn()
        await rig.engine.sync(.foreground)
        #expect(await rig.lastEntry()?.outcome == .ok, "after sign-in it goes on from the saved anchors")
    }

    @Test func theForegroundSyncsAtMostEveryFifteenMinutes() async throws {
        let rig = SyncRig()
        await rig.backfill()
        let count = await rig.log.entries.count
        rig.clock.advance(60)
        await rig.engine.sync(.foreground)
        #expect(await rig.log.entries.count == count)
        rig.clock.advance(15 * 60)
        await rig.engine.sync(.foreground)
        #expect(await rig.log.entries.count == count + 1)
        await rig.engine.sync(.manual)
        #expect(await rig.log.entries.count == count + 2, "Sync now is never throttled")
    }

    @Test func triggersThatArriveDuringASyncJoinOneFollowUp() async throws {
        let rig = SyncRig()
        await rig.backfill()
        await rig.backend.hold()
        let first = Task { await rig.engine.sync(.manual) }
        try await Task.sleep(for: .milliseconds(100))
        let second = Task { await rig.engine.sync(.observer) }
        let third = Task { await rig.engine.sync(.manual) }
        try await Task.sleep(for: .milliseconds(100))
        await rig.backend.release()
        await first.value
        await second.value
        await third.value
        let runs = await rig.log.entries.suffix(2)
        #expect(runs.count == 2)
        #expect(runs.last?.trigger == .manual, "one follow-up, named after what the guardian asked for")
    }

    @Test func aTypeTheRomeDoesNotKnowKeepsItsAnchorAndIsLeftOut() async throws {
        let rig = SyncRig()
        await rig.backfill()
        await rig.backend.reject(["bodyMass"])
        rig.health.add("bodyMass", id: "m3", start: rig.date("2026-11-09T05:00:00Z"), value: 71)
        await rig.engine.sync(.manual)
        #expect(await rig.lastEntry()?.outcome == .partial)
        let progress = await rig.progress.load()
        #expect(progress.unsupported.contains("bodyMass"))
        // Updated, the Rome takes it: the saved anchor still has the reading,
        // and the history is read again (the Rome counts the repeat as unchanged).
        await rig.backend.reject([])
        let before = await rig.backend.upserts.filter { $0.key == "bodyMass:m3" }.count
        await rig.engine.sync(.manual)
        #expect(await rig.backend.upserts.filter { $0.key == "bodyMass:m3" }.count > before)
        #expect(await rig.progress.load().unsupported.isEmpty)
    }

    @Test func anotherRomeStartsTheHistoryOver() async throws {
        let rig = SyncRig()
        rig.health.add("stepCount", id: "s1", start: rig.date("2026-10-01T02:00:00Z"), value: 100)
        await rig.backfill()
        rig.flags.set(instance: "inst-2")
        let before = await rig.backend.upserts.filter { $0.key == "stepCount:day:2026-09-30T16:00:00Z" }.count
        await rig.engine.sync(.manual)
        #expect(await rig.backend.upserts.filter { $0.key == "stepCount:day:2026-09-30T16:00:00Z" }.count == before + 1)
        #expect(await rig.progress.load().instanceId == "inst-2")
    }

    @Test func aBackgroundWakeStopsAtItsBudgetAndTheNextGoesOn() async throws {
        let rig = SyncRig()
        await rig.engine.sync(.observer, budget: 0)
        #expect(await rig.lastEntry()?.outcome == .interrupted)
        #expect(await rig.source.historyCursor() != nil, "the history waits for the next wake")
        await rig.engine.sync(.manual)
        #expect(await rig.source.historyCursor() == nil)
    }

    @Test func theDailyReconcileComputesTheLastWeekAgain() async throws {
        let rig = SyncRig()
        rig.health.add("stepCount", id: "s1", start: rig.date("2026-11-05T02:00:00Z"), value: 100)
        await rig.backfill()
        await rig.engine.sync(.manual)
        #expect(await rig.backend.upserts.filter { $0.key == "stepCount:day:2026-11-04T16:00:00Z" }.count == 1, "the history is fresh: no reconcile yet")
        rig.clock.advance(86_400 + 60)
        await rig.engine.sync(.manual)
        let resent = await rig.backend.upserts.filter { $0.key == "stepCount:day:2026-11-04T16:00:00Z" }.count
        #expect(resent == 2, "a day later, the last week once more")
        #expect(await rig.progress.load().lastWeeklyReconcile == HealthFixtures.now, "the 90 days wait a week")
    }

    @Test func aWakeBeforeAnyRomeIsOpenLeavesNoTraceAndBlocksNothing() async throws {
        let health = FakeHealthSync()
        let log = MemorySyncLog()
        let backend = FakePersonalDataBackend()
        let open = Flags()
        open.set(instance: "")
        let engine = SyncEngine(
            source: AppleHealthSource(reader: health, store: MemoryProgressStore()),
            target: { open.instance.isEmpty ? nil : PersonalDataTarget(instanceId: open.instance, backend: backend) },
            log: log,
            origin: { .init(id: "origin-1", name: "iPhone", platform: "ios", appVersion: "1.6.0") },
            switches: { open.switches }, protectedData: { true }
        )
        await engine.sync(.observer)
        await engine.sync(.foreground)
        #expect(await log.entries.isEmpty, "HealthKit's observers fire at launch, before the Rome opens")
        #expect(await !engine.signedOut)
        await engine.sync(.manual)
        #expect(await log.entries.last?.errorCode == "no_instance")
        open.set(instance: "inst-1")
        await engine.sync(.foreground)
        #expect(await log.entries.last?.outcome == .ok, "the launch wake did not use up the foreground throttle")
    }

    @Test func turningOffStopsABackfillUnderWayAndKeepsNothingOfIt() async throws {
        let rig = SyncRig()
        rig.addThreeWeeks()
        await rig.backend.hold()
        let run = Task { await rig.engine.sync(.backfill) }
        await rig.waitUntilHeld()
        let cursor = try #require(await rig.progress.load().backfill?.cursor)
        rig.flags.set(enabled: false)
        await rig.backend.release()
        await run.value
        #expect(await rig.backend.envelopes.count == 1, "the batch already sent, and nothing after it")
        #expect(await rig.lastEntry()?.outcome == .interrupted)
        #expect(await rig.progress.load().backfill?.cursor == cursor, "the week is read again once it is back on")
        let reads = rig.health.readCount
        await rig.engine.sync(.manual)
        #expect(rig.health.readCount == reads, "off reads nothing")
    }

    @Test func aDeleteWaitsForTheSyncUnderWayAndNoLateBatchBringsAnythingBack() async throws {
        let rig = SyncRig()
        rig.addThreeWeeks()
        await rig.backend.hold()
        let run = Task { await rig.engine.sync(.backfill) }
        await rig.waitUntilHeld()
        // Delete: stop and wait, then the Rome's DELETE, then reset.
        let quiet = Task { await rig.engine.quiesce() }
        try await Task.sleep(for: .milliseconds(50))
        await rig.backend.release()
        await quiet.value
        let sent = await rig.backend.envelopes.count
        await rig.source.reset()
        await run.value
        #expect(sent == 1, "the batch in flight landed before the delete; nothing after it")
        #expect(await rig.backend.envelopes.count == sent)
        #expect(await rig.progress.load() == SyncProgress(), "no late confirmation restores the old progress")
    }

    @Test func aBackgroundWakeStopsWaitingWhenItsTimeIsUp() async throws {
        let rig = SyncRig(pause: { try await Task.sleep(for: .seconds($0)) })
        rig.addThreeWeeks()
        await rig.backend.hold()
        let foreground = Task { await rig.engine.sync(.manual) }
        await rig.waitUntilHeld()
        let started = Date()
        await rig.engine.sync(.observer, budget: 0.2)
        #expect(Date().timeIntervalSince(started) < 5, "HealthKit's completion is not held by a long foreground run")
        await rig.backend.release()
        await foreground.value
    }

    @Test func aTypeTheRomeLearnsLaterGetsItsHistoryBeforeItsMark() async throws {
        let rig = SyncRig()
        await rig.backend.reject(["bodyMass"])
        rig.health.add("bodyMass", id: "old", start: rig.date("2026-10-01T00:00:00Z"), value: 70)
        await rig.backfill()
        #expect(await rig.progress.load().unsupported == ["bodyMass"])
        await rig.backend.reject([])
        let sent = await rig.backend.envelopes.count
        await rig.engine.sync(.manual)
        let fresh = Array(await rig.backend.envelopes.dropFirst(sent))
        #expect(fresh.flatMap(\.upserts).contains { $0.key == "bodyMass:old" }, "its history is read again")
        let marked = fresh.enumerated().filter { $0.element.types.contains { $0.type == "bodyMass" } }
        #expect(marked.map(\.offset) == [fresh.count - 1], "synced through only once its history is in")
    }

    @Test func dayBucketsAreKeyedByTheirStartInstant() {
        let calendar = HealthFixtures.calendar("Asia/Shanghai")
        let midnight = HealthFixtures.date("2026-11-08T16:00:00Z")
        #expect(AppleHealthSource.bucketKey("stepCount", .day, midnight, calendar: calendar) == "stepCount:day:2026-11-08T16:00:00Z")
        #expect(AppleHealthSource.bucketKey("stepCount", .hour, midnight, calendar: calendar) == "stepCount:hour:2026-11-08T16:00:00Z")
    }

    @Test func nightsBelongToTheDayTheyEndOn() {
        let calendar = HealthFixtures.calendar("Asia/Shanghai")
        #expect(AppleHealthSource.wakeDay(HealthFixtures.date("2026-11-08T23:00:00Z"), calendar: calendar) == "2026-11-09")
        // 19:00 local on the 9th: the evening of the next night.
        #expect(AppleHealthSource.wakeDay(HealthFixtures.date("2026-11-09T11:00:00Z"), calendar: calendar) == "2026-11-10")
    }
}

// MARK: - Settings and words

@MainActor
@Suite(.serialized) struct HealthSettingsTests {
    /// One fake Rome and one set of stores per instance, kept across launches.
    final class Rig: @unchecked Sendable {
        static let home = HealthInstance(id: "inst-1", name: "Home", isVisitor: false)
        static let work = HealthInstance(id: "inst-2", name: "Work", isVisitor: false)

        let defaults = UserDefaults(suiteName: "rome-health-\(UUID().uuidString)")!
        let reader = FakeHealth()
        let health = FakeHealthSync()
        let observers = FakeObservers()
        let origin = OriginStore.memory()
        private let lock = NSLock()
        private var backends: [String: FakePersonalDataBackend] = [:]
        private var stores: [String: (log: MemorySyncLog, progress: MemoryProgressStore)] = [:]
        private(set) var removedAll = 0

        func backend(_ id: String) -> FakePersonalDataBackend {
            lock.withLock {
                if let backend = backends[id] { return backend }
                let backend = FakePersonalDataBackend()
                backends[id] = backend
                return backend
            }
        }

        func log(_ id: String) -> MemorySyncLog { store(id).log }

        private func store(_ id: String) -> (log: MemorySyncLog, progress: MemoryProgressStore) {
            lock.withLock {
                if let store = stores[id] { return store }
                let store = (log: MemorySyncLog(), progress: MemoryProgressStore())
                stores[id] = store
                return store
            }
        }

        var backend: FakePersonalDataBackend { backend(Self.home.id) }
        var log: MemorySyncLog { log(Self.home.id) }

        @MainActor func make(_ instance: HealthInstance? = Rig.home) -> HealthSettings {
            HealthSettings(
                reader: reader, sync: health, observers: observers,
                stores: { id in
                    let store = self.store(id)
                    return HealthStores(log: store.log, progress: store.progress)
                },
                removeAllStores: { self.lock.withLock { self.stores = [:]; self.removedAll += 1 } },
                originStore: origin, defaults: defaults, device: .iPhone, notifies: false, protectedData: { true },
                instance: instance,
                target: { id in PersonalDataTarget(instanceId: id, backend: self.backend(id)) }
            )
        }
    }

    final class FakeObservers: HealthObserving, @unchecked Sendable {
        private(set) var starts = 0
        private(set) var stops = 0
        func start(onChange: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void) { starts += 1 }
        func stop() { stops += 1 }
    }

    @Test func syncIsOffByDefaultAndKept() async {
        let rig = Rig()
        let settings = rig.make()
        #expect(!settings.isEnabled)
        #expect(!settings.flag.isOn, "live health reads follow it")
        await settings.setEnabled(true).value
        #expect(settings.flag.isOn)
        #expect(rig.observers.starts == 1, "HealthKit may wake the app now")
        #expect(rig.make().isEnabled, "kept across launches")
        #expect(await rig.backend.envelopes.isEmpty == false, "turning it on starts the backfill")
    }

    @Test func turningSyncOnAsksIOSOnlyWhileItHasNeverBeenAsked() async {
        let rig = Rig()
        rig.reader.neverAsked = true
        let settings = rig.make()
        await settings.setEnabled(true).value
        #expect(rig.reader.accessRequests == 1)
        await settings.setEnabled(false).value
        await settings.setEnabled(true).value
        #expect(rig.reader.accessRequests == 1)
    }

    @Test func turningSyncOffTellsTheRomeAndStopsTheObservers() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        let stops = rig.observers.stops
        await settings.setEnabled(false).value
        #expect(rig.observers.stops == stops + 1)
        #expect(await rig.backend.states == ["off"])
    }

    @Test func theOldSwitchIsResetWithANote() {
        let rig = Rig()
        rig.defaults.set(true, forKey: "nodeHealthEnabled")
        let settings = rig.make()
        #expect(!settings.isEnabled, "the old consent did not cover uploading history")
        #expect(settings.showsMigrationNote)
        #expect(rig.defaults.object(forKey: "nodeHealthEnabled") == nil)
        #expect(rig.make().showsMigrationNote, "until sync is turned on")
        settings.setEnabled(true)
        #expect(!settings.showsMigrationNote)
        #expect(!rig.make().showsMigrationNote)
    }

    @Test func aNewInstallShowsNoNote() {
        #expect(!Rig().make().showsMigrationNote)
    }

    @Test func onAgainGoesOnFromTheAnchorsWithNoNewHistory() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        #expect(await rig.log.entries.contains { $0.history }, "the first time, the history")
        await settings.setEnabled(false).value
        await settings.setEnabled(true).value
        #expect(await rig.log.entries.last?.history == false, "on again: a catch-up from the anchors")
        #expect(await rig.backend.states == ["off"], "off tells the Rome; on again, the next batch says it")
    }

    @Test func deletingUploadedDataTurnsSyncOffAndLogsIt() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        #expect(await settings.deleteUploaded())
        #expect(await rig.backend.deletes == 1)
        #expect(!settings.isEnabled)
        #expect(!settings.flag.isOn)
        #expect(await rig.log.entries.last?.outcome == .deleted)
    }

    @Test func aDeleteThatFailsChangesNothing() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        await rig.backend.fail(.retryable("network"))
        #expect(await !settings.deleteUploaded())
        #expect(settings.isEnabled)
    }

    @Test func signingOutForgetsEverythingButTheRomesCopy() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        _ = rig.origin.id()
        await settings.forgetAccount().value
        #expect(!settings.isEnabled)
        #expect(!settings.flag.isOn)
        #expect(rig.origin.read() == nil)
        #expect(rig.removedAll == 1, "every Rome's anchors and history")
        #expect(settings.instance == nil)
        #expect(await rig.backend.deletes == 0, "only Delete uploaded data removes the Rome's copy")
        #expect(!rig.make().isEnabled)
    }

    @Test func eachRomeHasItsOwnSwitchAndOnlyTheOpenOneSyncs() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        let toHome = await rig.backend(Rig.home.id).envelopes.count
        #expect(toHome > 0)
        settings.select(Rig.work)
        #expect(!settings.isEnabled, "off on a Rome until it is turned on there")
        #expect(!settings.flag.isOn, "and so are live reads")
        #expect(settings.history.isEmpty)
        await settings.setEnabled(true).value
        #expect(await !rig.backend(Rig.work.id).envelopes.isEmpty, "turned on there, it syncs there")
        #expect(await rig.backend(Rig.home.id).envelopes.count == toHome, "the Rome left behind gets nothing")
        // Back home: its own switch and anchors, a catch-up and no new history.
        settings.select(Rig.home)
        #expect(settings.isEnabled)
        await settings.syncNow().value
        let homeLog = await rig.log(Rig.home.id).entries
        #expect(homeLog.last?.trigger == .manual)
        #expect(homeLog.last?.history == false, "a catch-up from its anchors, not a new 6 months")
        #expect(rig.make(Rig.work).isEnabled, "each Rome's switch is kept")
    }

    @Test func deleteReachesOnlyTheOpenRome() async {
        let rig = Rig()
        let settings = rig.make()
        await settings.setEnabled(true).value
        settings.select(Rig.work)
        await settings.setEnabled(true).value
        #expect(await settings.deleteUploaded())
        #expect(await rig.backend(Rig.work.id).deletes == 1)
        #expect(await rig.backend(Rig.home.id).deletes == 0)
        #expect(rig.make(Rig.home).isEnabled, "the other Rome keeps syncing")
    }

    @Test func aVisitorsRomeCannotSync() async {
        let rig = Rig()
        let settings = rig.make(HealthInstance(id: "friend", name: "A friend's Rome", isVisitor: true))
        #expect(!settings.canSync)
        await settings.setEnabled(true).value
        #expect(!settings.isEnabled)
        #expect(await rig.backend("friend").envelopes.isEmpty)
    }

    @Test func noRomeOpenMeansNoSync() async {
        let settings = Rig().make(nil)
        #expect(!settings.canSync)
        #expect(!settings.isEnabled)
    }

    @Test func theStatusComesFromTheSwitchesAndTheNewestSync() {
        func entry(_ outcome: SyncOutcome, _ code: String? = nil) -> SyncLogEntry {
            SyncLogEntry(seq: 1, time: HealthFixtures.now, trigger: .observer, outcome: outcome, errorCode: code)
        }
        let idle = SyncActivity()
        #expect(HealthSyncStatus.make(enabled: false, activity: idle, newest: nil, lastGood: nil) == .off)
        #expect(HealthSyncStatus.make(enabled: true, activity: idle, newest: nil, lastGood: nil) == .waiting)
        #expect(HealthSyncStatus.make(enabled: true, activity: SyncActivity(running: true, historyMonth: HealthFixtures.now), newest: nil, lastGood: nil) == .syncingHistory(HealthFixtures.now))
        #expect(HealthSyncStatus.make(enabled: true, activity: idle, newest: entry(.error, "signed_out"), lastGood: nil) == .needsSignIn)
        #expect(HealthSyncStatus.make(enabled: true, activity: idle, newest: entry(.skipped, "locked"), lastGood: nil) == .locked)
        #expect(HealthSyncStatus.make(enabled: true, activity: idle, newest: entry(.error, "network"), lastGood: nil) == .failed)
        #expect(HealthSyncStatus.make(enabled: true, activity: idle, newest: entry(.ok), lastGood: entry(.ok)) == .synced(HealthFixtures.now))
    }

    @Test func theSettingsRowSaysWhenSyncNeedsASignIn() {
        #expect(HealthRowState(status: .needsSignIn).value == "Needs sign-in")
        #expect(HealthRowState(status: .off).value == "Off")
        #expect(HealthRowState(status: .synced(.now)).value == "On")
    }

    @Test func theStatusLineOffersSignInOrRetry() {
        let locale = Locale(identifier: "en_US")
        #expect(HealthStatusLine(.needsSignIn).action == .signIn)
        #expect(HealthStatusLine(.needsSignIn).text == "Sign in again to keep Health syncing")
        #expect(HealthStatusLine(.failed).action == .retry)
        #expect(HealthStatusLine(.locked, device: .iPad).text == "Can't sync while iPad is locked")
        #expect(HealthStatusLine(.off).text == nil)
        #expect(HealthStatusLine(.syncingHistory(HealthFixtures.date("2026-08-15T00:00:00Z")), locale: locale).text == "Syncing history · Aug")
        let synced = HealthStatusLine(.synced(HealthFixtures.now), rome: "Home", now: HealthFixtures.now.addingTimeInterval(20), locale: locale)
        #expect(synced.text == "Synced just now · to Home")
        #expect(synced.action == .syncNow, "Sync now sits at the end of the line")
        #expect(HealthStatusLine(.synced(HealthFixtures.now), now: HealthFixtures.now.addingTimeInterval(20), locale: locale).text == "Synced just now")
    }
}

@Suite struct SyncHistoryFormatterTests {
    private let calendar = HealthFixtures.calendar("Asia/Shanghai")
    private var formatter: SyncHistoryFormatter {
        SyncHistoryFormatter(now: HealthFixtures.now, calendar: calendar, locale: Locale(identifier: "en_US"))
    }

    private func plain(_ text: String) -> String { text.replacingOccurrences(of: "\u{202F}", with: " ") }

    @Test func aSyncIsATriggerItsTimeAndACountNeverAValue() {
        var entry = SyncLogEntry(seq: 3, time: HealthFixtures.now, trigger: .observer, outcome: .ok)
        entry.types = ["stepCount": SyncTypeCount(items: 4), "heartRate": SyncTypeCount(items: 3)]
        let row = formatter.row(entry)
        #expect(row.symbol == "moon")
        #expect(row.title == "Background")
        #expect(plain(row.detail) == "6:30 PM")
        #expect(row.count == "7 readings")
        #expect(!row.failed)
    }

    @Test func eachTriggerHasItsWordsAndSymbol() {
        func row(_ trigger: SyncTrigger, history: Bool = false) -> SyncHistoryRow {
            var entry = SyncLogEntry(seq: 1, time: HealthFixtures.now, trigger: trigger, outcome: .ok, history: history)
            entry.types = ["stepCount": SyncTypeCount(items: 1)]
            return formatter.row(entry)
        }
        #expect(row(.foreground).title == "Opened Rome" && row(.foreground).symbol == "iphone")
        #expect(row(.manual).title == "Sync now" && row(.manual).symbol == "arrow.clockwise")
        let history = row(.manual, history: true)
        #expect(history.title == "History" && history.symbol == "clock.arrow.circlepath")
        #expect(plain(history.detail) == "6:30 PM · last 6 months")
    }

    @Test func aFailureIsRedWithItsReasonAndNoCount() {
        let failed = formatter.row(SyncLogEntry(seq: 2, time: HealthFixtures.now, trigger: .observer, outcome: .error, errorCode: "signed_out"))
        #expect(failed.failed)
        #expect(failed.symbol == "exclamationmark.circle")
        #expect(plain(failed.detail) == "6:30 PM · Signed out of your Rome")
        #expect(failed.count == nil)
        let locked = formatter.row(SyncLogEntry(seq: 1, time: HealthFixtures.now, trigger: .observer, outcome: .skipped, errorCode: "locked"))
        #expect(!locked.failed)
        #expect(plain(locked.detail) == "6:30 PM · Skipped · iPhone locked")
    }

    @Test func syncsAreGroupedByDay() {
        let entries = [
            SyncLogEntry(seq: 3, time: HealthFixtures.now, trigger: .observer, outcome: .error, errorCode: "network"),
            SyncLogEntry(seq: 2, time: HealthFixtures.now.addingTimeInterval(-86_400), trigger: .observer, outcome: .error, errorCode: "network"),
            SyncLogEntry(seq: 1, time: HealthFixtures.date("2026-11-03T12:15:00Z"), trigger: .observer, outcome: .error, errorCode: "network"),
        ]
        #expect(formatter.days(entries).map(\.title) == ["Today", "Yesterday", "Tuesday, Nov 3"])
    }

    @Test func quietSyncsAfterTheNewestAddNoRows() {
        let entries = (1...4).map { SyncLogEntry(seq: 5 - $0, time: HealthFixtures.now.addingTimeInterval(-Double($0) * 60), trigger: .observer, outcome: .ok) }
        #expect(formatter.days(entries).flatMap(\.rows).count == 1)
    }
}
