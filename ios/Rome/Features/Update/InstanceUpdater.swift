import Foundation
import Observation

/// The app always requires the instance's latest release. The instance API
/// stays backward compatible, so the app never pins an instance version: it
/// only asks whether the instance is behind, and if so, has it updated.
/// These are the rules, kept free of state so tests can read them.
enum UpdateGate {
    /// How long Rome Cloud may take to roll out a new release.
    static let upgradeTimeout: TimeInterval = 40 * 60
    static let pollInterval: Duration = .seconds(5)

    enum Verdict: Equatable {
        case upToDate
        case required(current: String?, latest: String)
        /// The check could not decide (a dev build, Rome Cloud out of reach, no
        /// network). The app never blocks on this.
        case unknown(reason: String)
    }

    static func verdict(_ result: Result<UpgradeCheck, Error>) -> Verdict {
        switch result {
        case .failure(let error):
            if case APIError.server(_, let message) = error { return .unknown(reason: message ?? "server_error") }
            if let error = error as? APIError { return .unknown(reason: "\(error)") }
            return .unknown(reason: "network")
        case .success(let check):
            guard check.upgradeAvailable == true else { return .upToDate }
            guard let latest = check.latest?.version?.trimmingCharacters(in: .whitespaces), !latest.isEmpty else {
                return .unknown(reason: "no_latest_version")
            }
            if latest == check.current?.version { return .upToDate }
            return .required(current: check.current?.version, latest: latest)
        }
    }

    enum PollOutcome: Equatable {
        case done, wait, timedOut
        /// The instance came back on a release that is neither the one it
        /// started from nor the target: the target will never answer.
        case movedOn
    }

    /// After an upgrade starts, the instance restarts on the target release.
    /// Failed probes while it restarts are expected (`version` nil). The target
    /// answering ends the wait; so does another release than the one it started
    /// from (someone updated further, or Rome Cloud rolled back to an older
    /// one), and the timeout ends it as a failure.
    static func pollOutcome(version: String?, target: String, from: String?, since: Date, now: Date) -> PollOutcome {
        if version == target { return .done }
        if let version, let from, version != from { return .movedOn }
        return now.timeIntervalSince(since) >= upgradeTimeout ? .timedOut : .wait
    }

    enum PendingDecision: Equatable {
        case keepWaiting
        /// The instance is on its latest release.
        case finished
        /// The remembered target is not what Rome Cloud offers anymore.
        case stale(Verdict)
    }

    /// What a check that answers says about a remembered target. A check that
    /// cannot decide (the instance is restarting) keeps the wait.
    static func pending(target: String, after verdict: Verdict) -> PendingDecision {
        switch verdict {
        case .upToDate: return .finished
        case .unknown: return .keepWaiting
        case .required(_, let latest): return latest == target ? .keepWaiting : .stale(verdict)
        }
    }

    /// Why Rome Cloud did not start an upgrade, in words. Codes from the
    /// instance or Rome Cloud never reach the screen as they are.
    static func startFailureMessage(_ error: Error) -> String {
        if case APIError.server(_, let code) = error {
            switch code {
            case "pantheon_unreachable":
                return String(localized: "Rome Cloud could not be reached. Try again in a moment.")
            case "pantheon_unconfigured":
                return String(localized: "This Rome is not connected to Rome Cloud, so it cannot update here.")
            case "unversioned_build":
                return String(localized: "This Rome is a development build and cannot be updated.")
            default:
                return String(localized: "Rome Cloud could not start the update. Try again in a moment.")
            }
        }
        return (error as? LocalizedError)?.errorDescription ?? String(localized: "Could not reach your Rome")
    }

    /// Rome Cloud refused the target because a newer release came out.
    static func isTargetNotLatest(_ error: Error) -> Bool {
        if case APIError.server(409, "target_not_latest") = error { return true }
        return false
    }
}

/// An upgrade this device started, remembered per instance so a relaunch
/// goes back to waiting instead of asking again.
struct PendingUpgrade: Codable, Equatable {
    var target: String
    var since: Date
    /// The release the instance ran when the upgrade started.
    var from: String?
}

struct PendingUpgradeStore {
    var defaults: UserDefaults = .standard

    func load(_ instanceID: String) -> PendingUpgrade? {
        defaults.data(forKey: key(instanceID)).flatMap { try? JSONDecoder().decode(PendingUpgrade.self, from: $0) }
    }

    func save(_ pending: PendingUpgrade, for instanceID: String) {
        defaults.set(try? JSONEncoder().encode(pending), forKey: key(instanceID))
    }

    func clear(_ instanceID: String) {
        defaults.removeObject(forKey: key(instanceID))
    }

    private func key(_ instanceID: String) -> String { "pendingUpgrade.\(instanceID)" }
}

/// Whether the open instance is on its latest release, and the upgrade that
/// brings it there. While `blocking`, the update page covers the app.
@MainActor
@Observable
final class InstanceUpdater {
    enum State: Equatable {
        /// Not checked yet; the app works as usual.
        case idle
        case upToDate
        /// The check could not decide; the app works as usual.
        case unknown(reason: String)
        /// `latestChanged`: Rome Cloud refused the last target for a newer one.
        case required(current: String?, latest: String, latestChanged: Bool)
        case starting(current: String?, latest: String)
        case updating(target: String, since: Date)
        case failed(Failure)
    }

    enum Failure: Equatable {
        /// Rome Cloud refused or could not be reached when starting.
        case start(current: String?, latest: String, message: String)
        /// The target never answered within `UpdateGate.upgradeTimeout`.
        case timedOut(target: String)
    }

    private(set) var state: State = .idle

    var blocking: Bool {
        switch state {
        case .required, .starting, .updating, .failed: return true
        case .idle, .upToDate, .unknown: return false
        }
    }

    var cannotCheck: Bool {
        if case .unknown = state { return true }
        return false
    }

    /// Called once the instance answers on the target release.
    var onFinished: (() async -> Void)?

    private var backend: RomeBackend?
    private var instanceID: String?
    /// Tries to reach an instance that Rome Cloud reports as not running yet,
    /// used while it restarts with no backend open.
    private var reconnect: (() async -> Void)?
    private let store: PendingUpgradeStore
    private var generation = 0
    private var poll: Task<Void, Never>?
    private var reconnecting = false
    /// Probes since the last check while waiting; a check runs every few.
    private var probesSinceCheck = 0

    init(store: PendingUpgradeStore = PendingUpgradeStore()) {
        self.store = store
    }

    // MARK: Attaching

    /// A new instance opened: start over for it.
    func attach(backend: RomeBackend, instanceID: String) async {
        reset()
        self.backend = backend
        self.instanceID = instanceID
        await check()
    }

    /// Rome Cloud reports the instance as not running and this device started
    /// an upgrade on it: keep waiting, trying to reach it on each tick.
    /// Returns false when nothing is pending.
    func waitWithoutInstance(instanceID: String, reconnect: @escaping () async -> Void) -> Bool {
        guard let pending = store.load(instanceID), !expired(pending) else { return false }
        reset()
        self.instanceID = instanceID
        self.reconnect = reconnect
        startPolling(pending)
        return true
    }

    /// Returns once the first check answers, or after `limit`.
    func waitForFirstAnswer(upTo limit: Duration) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: limit)
        while state == .idle, clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    func reset() {
        generation += 1
        poll?.cancel()
        poll = nil
        backend = nil
        instanceID = nil
        reconnect = nil
        state = .idle
    }

    // MARK: Checking

    /// Asks whether the instance is behind. While an upgrade is underway it
    /// probes for the target instead; a check would fail while it restarts.
    func check() async {
        guard let backend, let instanceID else { return }
        if case .starting = state { return }
        if let pending = store.load(instanceID), expired(pending) { store.clear(instanceID) }
        if let pending = store.load(instanceID) {
            // Waiting for a remembered target: show the wait at once, and let a
            // check that answers end it if the target is reached or stale.
            if poll == nil {
                startPolling(pending)
            } else if await probe(pending) {
                return
            }
            await checkWhileWaiting(pending)
            return
        }
        if case .updating = state { return }
        generation += 1
        let mine = generation
        let result: Result<UpgradeCheck, Error>
        do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
        guard mine == generation else { return }
        apply(UpdateGate.verdict(result), latestChanged: false)
    }

    private func checkWhileWaiting(_ pending: PendingUpgrade) async {
        guard let backend, let instanceID else { return }
        probesSinceCheck = 0
        let mine = generation
        let result: Result<UpgradeCheck, Error>
        do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
        guard mine == generation, case .updating = state else { return }
        switch UpdateGate.pending(target: pending.target, after: UpdateGate.verdict(result)) {
        case .keepWaiting:
            break
        case .finished:
            await finish()
        case .stale(let verdict):
            store.clear(instanceID)
            stopPolling()
            apply(verdict, latestChanged: false)
        }
    }

    private func stopPolling() {
        generation += 1
        poll?.cancel()
        poll = nil
    }

    private func apply(_ verdict: UpdateGate.Verdict, latestChanged: Bool) {
        switch verdict {
        case .upToDate: state = .upToDate
        case .unknown(let reason): state = .unknown(reason: reason)
        case .required(let current, let latest): state = .required(current: current, latest: latest, latestChanged: latestChanged)
        }
    }

    // MARK: Updating

    func updateNow() async {
        guard let backend, let instanceID, case .required(let current, let latest, _) = state else { return }
        state = .starting(current: current, latest: latest)
        let mine = generation
        do {
            let started = try await backend.startUpgrade(target: latest)
            guard mine == generation else { return }
            let pending = PendingUpgrade(target: started.target ?? latest, since: .now, from: current)
            store.save(pending, for: instanceID)
            startPolling(pending)
        } catch {
            guard mine == generation else { return }
            if UpdateGate.isTargetNotLatest(error) {
                // A newer release came out: show it and let the guardian confirm again.
                let result: Result<UpgradeCheck, Error>
                do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
                guard mine == generation else { return }
                apply(UpdateGate.verdict(result), latestChanged: true)
                return
            }
            state = .failed(.start(current: current, latest: latest, message: UpdateGate.startFailureMessage(error)))
        }
    }

    /// From a failure: asks again. A timed-out upgrade that still cannot be
    /// checked (the instance is down) goes back to waiting.
    func retry() async {
        guard case .failed(let failure) = state else { return }
        poll?.cancel()
        poll = nil
        guard let backend, let instanceID else {
            if case .timedOut(let target) = failure, let instanceID {
                startPolling(PendingUpgrade(target: target, since: .now))
                store.save(PendingUpgrade(target: target, since: .now), for: instanceID)
            }
            return
        }
        store.clear(instanceID)
        let result: Result<UpgradeCheck, Error>
        do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
        let verdict = UpdateGate.verdict(result)
        if case .unknown = verdict, case .timedOut(let target) = failure {
            let pending = PendingUpgrade(target: target, since: .now)
            store.save(pending, for: instanceID)
            startPolling(pending)
            return
        }
        if verdict == .upToDate, case .timedOut = failure {
            await finish()
            return
        }
        apply(verdict, latestChanged: false)
    }

    private func startPolling(_ pending: PendingUpgrade) {
        poll?.cancel()
        probesSinceCheck = 0
        state = .updating(target: pending.target, since: pending.since)
        let mine = generation
        poll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, mine == self.generation else { return }
                if await self.probe(pending) { return }
                try? await Task.sleep(for: UpdateGate.pollInterval)
            }
        }
    }

    /// One look at the instance. Returns true when the wait is over.
    @discardableResult
    private func probe(_ pending: PendingUpgrade) async -> Bool {
        let mine = generation
        guard let backend else {
            // Its own task: a reconnect that opens the instance attaches it,
            // which cancels this poll, and must not cancel the opening with it.
            if let reconnect, !reconnecting {
                reconnecting = true
                Task { [weak self] in
                    await reconnect()
                    self?.reconnecting = false
                }
            }
            if UpdateGate.pollOutcome(version: nil, target: pending.target, from: pending.from, since: pending.since, now: .now) == .timedOut {
                state = .failed(.timedOut(target: pending.target))
                return true
            }
            return false
        }
        let version = try? await backend.buildInfo().version
        guard mine == generation else { return true }
        switch UpdateGate.pollOutcome(version: version, target: pending.target, from: pending.from, since: pending.since, now: .now) {
        case .done:
            await finish()
            return true
        case .timedOut:
            state = .failed(.timedOut(target: pending.target))
            return true
        case .movedOn:
            // Not the target and not where it started: ask what is latest now.
            if let instanceID { store.clear(instanceID) }
            stopPolling()
            state = .idle
            // Its own task: this poll was just cancelled, and so would the check be.
            Task { [weak self] in await self?.check() }
            return true
        case .wait:
            // The instance answers but not on the target yet. Every so often ask
            // Rome Cloud too, which notices a target that will never come.
            probesSinceCheck += 1
            if version != nil, probesSinceCheck >= 6 {
                await checkWhileWaiting(pending)
                if mine == generation, case .updating = state { return false }
                return true
            }
            return false
        }
    }

    private func finish() async {
        if let instanceID { store.clear(instanceID) }
        poll?.cancel()
        poll = nil
        state = .upToDate
        await onFinished?()
    }

    private func expired(_ pending: PendingUpgrade) -> Bool {
        Date.now.timeIntervalSince(pending.since) >= UpdateGate.upgradeTimeout
    }

    #if DEBUG
    /// Snapshot runs only: show a state without a server round trip.
    func debugShow(_ state: State) {
        poll?.cancel()
        poll = nil
        self.state = state
    }
    #endif
}
