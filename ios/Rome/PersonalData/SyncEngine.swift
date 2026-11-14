import Foundation

// Runs one source's syncs: one at a time, triggers that arrive meanwhile
// merged into one follow-up, a throttle on the foreground, batches with caps,
// and a backoff after a failure. A sync reads nothing while the phone is
// locked (Health is encrypted then) or while sync is paused, and stops all
// retries once the session is over, until the guardian signs in again.

/// What the engine says while it works, for the Health page's status line.
struct SyncActivity: Equatable, Sendable {
    var running = false
    /// The month the backfill is reading.
    var historyMonth: Date?
}

/// The settings the engine reads at the start of every sync.
struct SyncSwitches: Equatable, Sendable {
    var enabled: Bool
    var paused: Bool
}

actor SyncEngine {
    static let maxItems = 1000
    static let maxBytes = 512 * 1024
    static let foregroundThrottle: TimeInterval = 15 * 60
    /// How long a background wake may send before it stops cleanly.
    static let backgroundBudget: TimeInterval = 25

    private let source: any PersonalDataSource
    private let target: @Sendable () async -> PersonalDataTarget?
    private let log: SyncLogging
    private let origin: @Sendable () async -> PersonalDataEnvelope.Origin?
    private let switches: @Sendable () async -> SyncSwitches
    private let protectedData: @Sendable () async -> Bool
    private let now: @Sendable () -> Date
    private let random: @Sendable () -> Double
    private let pause: @Sendable (TimeInterval) async throws -> Void
    private let onActivity: @Sendable (SyncActivity) async -> Void
    private let onLogged: @Sendable (SyncLogEntry) async -> Void

    private var running = false
    private var pending: Set<SyncTrigger> = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var lastRunAt: Date?
    private var failures = 0
    private var retryAt: Date?
    private var retryTask: Task<Void, Never>?
    /// The session is over: only the guardian can fix it, so nothing retries.
    private(set) var signedOut = false
    /// The Rome has no personal-data routes.
    private(set) var needsUpdate = false

    init(
        source: any PersonalDataSource,
        target: @escaping @Sendable () async -> PersonalDataTarget?,
        log: SyncLogging,
        origin: @escaping @Sendable () async -> PersonalDataEnvelope.Origin?,
        switches: @escaping @Sendable () async -> SyncSwitches,
        protectedData: @escaping @Sendable () async -> Bool,
        now: @escaping @Sendable () -> Date = { Date() },
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
        pause: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        onActivity: @escaping @Sendable (SyncActivity) async -> Void = { _ in },
        onLogged: @escaping @Sendable (SyncLogEntry) async -> Void = { _ in }
    ) {
        self.source = source
        self.target = target
        self.log = log
        self.origin = origin
        self.switches = switches
        self.protectedData = protectedData
        self.now = now
        self.random = random
        self.pause = pause
        self.onActivity = onActivity
        self.onLogged = onLogged
    }

    /// 30 s, doubling to 6 h, scattered by 0.75 to 1.25.
    static func backoff(attempt: Int, random: Double) -> TimeInterval {
        min(6 * 3600, 30 * pow(2, Double(min(attempt, 10)))) * (0.75 + random * 0.5)
    }

    /// Asks for a sync and returns when one that covers it has run. A sync
    /// asked for while one runs joins the next run, which serves every
    /// trigger that waited. `budget`: seconds a background wake may take.
    func sync(_ trigger: SyncTrigger, budget: TimeInterval? = nil) async {
        if running {
            pending.insert(trigger)
            await withCheckedContinuation { waiters.append($0) }
            return
        }
        running = true
        var triggers: Set<SyncTrigger> = [trigger]
        while true {
            await run(Self.lead(triggers), served: triggers, budget: budget)
            guard !pending.isEmpty else { break }
            triggers = pending
            pending = []
        }
        running = false
        let held = waiters
        waiters = []
        for waiter in held { waiter.resume() }
    }

    /// The trigger a merged run is named after: what the guardian asked for wins.
    private static func lead(_ triggers: Set<SyncTrigger>) -> SyncTrigger {
        for trigger in [SyncTrigger.manual, .backfill, .foreground, .retry, .observer] where triggers.contains(trigger) { return trigger }
        return .observer
    }

    /// The guardian signed in again: the next sync may try.
    func signedIn() {
        signedOut = false
        needsUpdate = false
        retryAt = nil
        failures = 0
    }

    /// Sync was turned off, paused or reset: no retry waits.
    func cancelRetries() {
        retryTask?.cancel()
        retryTask = nil
        retryAt = nil
        failures = 0
    }

    // MARK: One run

    private func run(_ trigger: SyncTrigger, served: Set<SyncTrigger>, budget: TimeInterval?) async {
        let state = await switches()
        guard state.enabled, !state.paused else { return }
        let started = now()
        let asked = served.contains(.manual) || served.contains(.backfill)
        if trigger == .foreground, !asked, let lastRunAt, started.timeIntervalSince(lastRunAt) < Self.foregroundThrottle { return }
        if !asked, let retryAt, started < retryAt { return }
        // Only the guardian can end these: a background wake does not try.
        if (signedOut || needsUpdate), !served.contains(.manual), !served.contains(.foreground) { return }
        lastRunAt = started
        var entry = SyncLogEntry(seq: 0, time: started, trigger: trigger, outcome: .ok)
        guard await protectedData() else {
            entry.outcome = .skipped
            entry.errorCode = "locked"
            await finish(entry)
            return
        }
        guard let target = await target(), let origin = await origin() else {
            entry.outcome = .error
            entry.errorCode = "signed_out"
            signedOut = true
            await finish(entry)
            return
        }
        await onActivity(SyncActivity(running: true, historyMonth: await source.historyCursor()))
        let deadline = budget.map { started.addingTimeInterval($0) }
        do {
            try await source.beginRun(trigger: trigger, instanceId: target.instanceId, now: started)
            var index = 0
            while true {
                if let deadline, now() >= deadline {
                    entry.outcome = .interrupted
                    break
                }
                guard let chunk = try await source.nextChunk() else { break }
                if chunk.kind == .backfill { entry.history = true }
                await onActivity(SyncActivity(running: true, historyMonth: chunk.historyMonth))
                let unsupported = try await send(chunk, origin: origin, trigger: trigger, backend: target.backend, index: &index, entry: &entry)
                await source.confirm(chunk, unsupported: unsupported)
                for (type, count) in chunk.counts { entry.types[type] = Self.merged(entry.types[type], count) }
                if !unsupported.isEmpty { entry.outcome = .partial }
            }
            if entry.rejected > 0, entry.outcome == .ok { entry.outcome = .partial }
            failures = 0
            retryAt = nil
            signedOut = false
            needsUpdate = false
        } catch let failure as PersonalDataFailure {
            fail(&entry, failure, trigger: trigger)
        } catch HealthReadError.locked {
            entry.outcome = .skipped
            entry.errorCode = "locked"
        } catch is CancellationError {
            entry.outcome = .interrupted
        } catch {
            entry.outcome = .error
            entry.errorCode = "health_failed"
        }
        entry.durationMs = Int(now().timeIntervalSince(started) * 1000)
        await onActivity(SyncActivity())
        await finish(entry)
    }

    private func finish(_ entry: SyncLogEntry) async {
        let written = await log.append(entry)
        await onLogged(written)
    }

    private func fail(_ entry: inout SyncLogEntry, _ failure: PersonalDataFailure, trigger: SyncTrigger) {
        entry.outcome = .error
        switch failure {
        case .signedOut, .noInstance:
            entry.errorCode = "signed_out"
            signedOut = true
            cancelRetries()
        case .needsUpdate:
            entry.errorCode = "needs_update"
            needsUpdate = true
            cancelRetries()
        case .rateLimited(let after):
            entry.errorCode = "rate_limited"
            scheduleRetry(after: after)
        case .retryable(let code):
            entry.errorCode = code == "network" ? "network" : "server"
            scheduleRetry(after: nil)
        case .refused(let status, let code):
            // The same batch would be refused again: logged, not retried, and
            // the anchors stay, so the data is sent again with the next sync.
            entry.errorCode = code ?? "http_\(status)"
        }
    }

    private func scheduleRetry(after seconds: TimeInterval?) {
        let delay = seconds ?? Self.backoff(attempt: failures, random: random())
        failures += 1
        retryAt = now().addingTimeInterval(delay)
        retryTask?.cancel()
        let pause = pause
        retryTask = Task { [weak self] in
            do { try await pause(delay) } catch { return }
            await self?.retry()
        }
    }

    private func retry() async {
        retryTask = nil
        retryAt = nil
        await sync(.retry)
    }

    // MARK: Sending

    /// Sends a chunk in batches, one after the other. The type marks go with
    /// the last batch, so the Rome counts a type as synced only once it has
    /// all of it. Returns the types the Rome does not know.
    private func send(
        _ chunk: SyncChunk, origin: PersonalDataEnvelope.Origin, trigger: SyncTrigger, backend: any PersonalDataBackend,
        index: inout Int, entry: inout SyncLogEntry
    ) async throws(PersonalDataFailure) -> Set<String> {
        let batches = Self.batches(chunk)
        var unsupported = Set<String>()
        for (number, batch) in batches.enumerated() {
            let last = number == batches.count - 1
            let envelope = PersonalDataEnvelope(
                source: source.id, origin: origin,
                batch: .init(id: UUID().uuidString.lowercased(), trigger: trigger.rawValue, index: index, last: last),
                types: last ? chunk.marks : [],
                upserts: batch.upserts, deletes: batch.deletes.map { .init(key: $0) }
            )
            index += 1
            let reply = try await backend.ingest(envelope)
            entry.batches += 1
            entry.inserted += reply.inserted ?? 0
            entry.updated += reply.updated ?? 0
            entry.unchanged += reply.unchanged ?? 0
            entry.deleted += reply.deleted ?? 0
            for rejected in reply.rejected ?? [] {
                entry.rejected += 1
                guard rejected.code == "unknown_type", let index = rejected.index, index < batch.upserts.count else { continue }
                unsupported.insert(batch.upserts[index].type)
            }
        }
        return unsupported
    }

    /// At most `maxItems` items and about `maxBytes` of JSON per request. A
    /// chunk with nothing to send but its marks is one empty batch.
    static func batches(_ chunk: SyncChunk) -> [(upserts: [PersonalDataPoint], deletes: [String])] {
        var batches: [(upserts: [PersonalDataPoint], deletes: [String])] = []
        var upserts: [PersonalDataPoint] = []
        var deletes: [String] = []
        var bytes = 0
        func flush() {
            batches.append((upserts, deletes))
            upserts = []
            deletes = []
            bytes = 0
        }
        for point in chunk.upserts {
            let size = (try? PersonalDataClient.encoder.encode(point).count) ?? 300
            if upserts.count + deletes.count >= maxItems || bytes + size > maxBytes { flush() }
            upserts.append(point)
            bytes += size + 1
        }
        for key in chunk.deletes {
            let size = key.utf8.count + 10
            if upserts.count + deletes.count >= maxItems || bytes + size > maxBytes { flush() }
            deletes.append(key)
            bytes += size
        }
        if !upserts.isEmpty || !deletes.isEmpty || batches.isEmpty && !chunk.marks.isEmpty { flush() }
        return batches
    }

    private static func merged(_ old: SyncTypeCount?, _ new: SyncTypeCount) -> SyncTypeCount {
        guard let old else { return new }
        return SyncTypeCount(
            items: old.items + new.items,
            start: [old.start, new.start].compactMap { $0 }.min(),
            end: [old.end, new.end].compactMap { $0 }.max()
        )
    }
}
