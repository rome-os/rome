import Foundation
import Observation

/// An instance below `minimumInstanceVersion` lacks an API the app calls:
/// the update page covers the app until it is updated. A newer release for
/// an instance at or above it is only offered, in a banner and the drawer.
/// These are the rules, kept free of state so tests can read them.
enum UpdateGate {
    /// The oldest instance release with every API the app calls. Raise it
    /// only when the app starts calling an API a newer release brought.
    static let minimumInstanceVersion = "1.1.185"

    /// Whether the app works with an instance on `version`. An unknown or
    /// unreadable version is never held against it.
    static func isSupported(_ version: String?, minimum: String = minimumInstanceVersion) -> Bool {
        guard let version, let have = numbers(version), let need = numbers(minimum) else { return true }
        for index in 0..<max(have.count, need.count) {
            let a = index < have.count ? have[index] : 0, b = index < need.count ? need[index] : 0
            if a != b { return a > b }
        }
        return true
    }

    /// "v1.1.185" or "1.1.185-rc.1" as [1, 1, 185]; nil when it is not a version.
    private static func numbers(_ version: String) -> [Int]? {
        var text = version.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("v") { text.removeFirst() }
        let core = text.prefix { $0.isNumber || $0 == "." }
        let parts = core.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard !parts.isEmpty, !parts.contains(nil) else { return nil }
        return parts.compactMap { $0 }
    }

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

    /// Where an update stands, as far as the app can see it.
    enum Progress: Equatable {
        /// The instance still answers on its old release.
        case downloading
        /// The instance cannot be reached: it is restarting.
        case restarting
        /// The target release answered.
        case almostDone
    }

    static func progress(version: String?, target: String) -> Progress {
        guard let version else { return .restarting }
        return version == target ? .almostDone : .downloading
    }

    /// The update page's one status line while it waits, or nil when it
    /// does not wait.
    static func statusLine(_ state: InstanceUpdater.State, progress: Progress) -> String? {
        switch state {
        case .starting:
            return String(localized: "Asking Rome Cloud to start the update…")
        case .updating(let target, _):
            switch progress {
            case .downloading: return String(localized: "Upgrading to \(target)…")
            case .restarting: return String(localized: "Restarting your Rome…")
            case .almostDone: return String(localized: "Almost done…")
            }
        default:
            return nil
        }
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

/// The latest release whose banner the guardian closed, per instance: a
/// newer release shows the banner again.
struct UpdateBannerStore {
    var defaults: UserDefaults = .standard

    func dismissed(_ instanceID: String) -> String? { defaults.string(forKey: key(instanceID)) }
    func dismiss(_ version: String, for instanceID: String) { defaults.set(version, forKey: key(instanceID)) }
    private func key(_ instanceID: String) -> String { Self.prefix + instanceID }
    static let prefix = "updateBannerDismissed."

    /// Sign-out, or another account: the banner was that guardian's to close.
    static func removeAll(defaults: UserDefaults = .standard) {
        defaults.removeKeys(prefix: prefix)
    }
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
/// brings it there. While `blocking`, the update page covers the app: always
/// below the minimum version and while an update runs, otherwise only once
/// the guardian opens it.
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
    /// While updating: what the last look at the instance found.
    private(set) var progress: UpdateGate.Progress = .downloading

    /// The guardian opened the update page from the banner or the drawer.
    private(set) var presented = false
    /// The release the guardian closed the banner for, on this instance.
    private(set) var dismissedVersion: String?
    /// The instance's release when the check last found it behind.
    private var behindOn: String?

    var blocking: Bool {
        switch state {
        case .starting, .updating: return true
        case .required, .failed: return belowMinimum || presented
        case .idle, .upToDate, .unknown: return false
        }
    }

    /// Behind and missing an API the app calls: no way past the page.
    var belowMinimum: Bool {
        switch state {
        case .required, .failed: return !UpdateGate.isSupported(behindOn)
        default: return false
        }
    }

    /// A newer release this instance can do without: offered, never forced.
    var offered: String? {
        guard case .required(_, let latest, _) = state, !belowMinimum else { return nil }
        return latest
    }

    /// The banner: offered, not open, and not closed for this release.
    var showsBanner: Bool {
        guard let offered, !presented else { return false }
        return dismissedVersion != offered
    }

    /// The page can be closed: it was only offered, and nothing is running.
    var canClose: Bool {
        switch state {
        case .required, .failed: return !belowMinimum
        default: return false
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
    /// The instance an upgrade is waited on while no workspace is open
    /// (`waitWithoutInstance`). Nil once the wait ends, a timeout or a
    /// failure included: then nothing reopens the instance on its own.
    var waitingInstanceID: String? {
        guard reconnect != nil, case .updating = state else { return nil }
        return instanceID
    }
    /// Tries to reach an instance that Rome Cloud reports as not running yet,
    /// used while it restarts with no backend open.
    private var reconnect: (() async -> Void)?
    private let store: PendingUpgradeStore
    private let banners: UpdateBannerStore
    private var generation = 0
    private var poll: Task<Void, Never>?
    private var reconnecting = false
    /// Probes since the last check while waiting; a check runs every few.
    private var probesSinceCheck = 0

    init(store: PendingUpgradeStore = PendingUpgradeStore(), banners: UpdateBannerStore = UpdateBannerStore()) {
        self.store = store
        self.banners = banners
    }

    // MARK: Offering

    func openPage() {
        guard offered != nil || canClose else { return }
        presented = true
    }

    /// Back to the app; a failed start goes back to being offered.
    func closePage() {
        guard canClose else { return }
        presented = false
        if case .failed(let failure) = state {
            switch failure {
            case .start(let current, let latest, _): state = .required(current: current, latest: latest, latestChanged: false)
            case .timedOut(let target): state = .required(current: behindOn, latest: target, latestChanged: false)
            }
        }
    }

    /// Closes the banner for this release; a newer one shows it again.
    func dismissBanner() {
        guard let offered, let instanceID else { return }
        banners.dismiss(offered, for: instanceID)
        dismissedVersion = offered
    }

    // MARK: Attaching

    /// A new instance opened: start over for it.
    func attach(backend: RomeBackend, instanceID: String) async {
        reset()
        self.backend = backend
        self.instanceID = instanceID
        dismissedVersion = banners.dismissed(instanceID)
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
        presented = false
        dismissedVersion = nil
        behindOn = nil
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
        case .required(let current, let latest):
            behindOn = current
            state = .required(current: current, latest: latest, latestChanged: latestChanged)
        }
    }

    // MARK: Updating

    func updateNow() async {
        guard let backend, let instanceID, case .required(let current, let latest, _) = state else { return }
        presented = true
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
        progress = .downloading
        // A running update keeps the page up until the guardian closes it, so
        // a failure, after a relaunch too, is always seen; and the release it
        // started from decides whether the page may close.
        presented = true
        behindOn = pending.from ?? behindOn
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
            progress = .restarting
            if UpdateGate.pollOutcome(version: nil, target: pending.target, from: pending.from, since: pending.since, now: .now) == .timedOut {
                state = .failed(.timedOut(target: pending.target))
                return true
            }
            return false
        }
        let version = try? await backend.buildInfo().version
        guard mine == generation else { return true }
        progress = UpdateGate.progress(version: version, target: pending.target)
        switch UpdateGate.pollOutcome(version: version, target: pending.target, from: pending.from, since: pending.since, now: .now) {
        case .done:
            // Long enough to read "Almost done…" before the app opens.
            try? await Task.sleep(for: .milliseconds(800))
            guard mine == generation else { return true }
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
        presented = false
        state = .upToDate
        await onFinished?()
    }

    private func expired(_ pending: PendingUpgrade) -> Bool {
        Date.now.timeIntervalSince(pending.since) >= UpdateGate.upgradeTimeout
    }

    #if DEBUG
    /// Snapshot runs only: show a state without a server round trip.
    func debugShow(_ state: State, progress: UpdateGate.Progress = .downloading) {
        poll?.cancel()
        poll = nil
        self.state = state
        self.progress = progress
        if case .required(let current, _, _) = state { behindOn = current }
    }
    #endif
}
