import Foundation
import Observation

/// An instance below `minimumInstanceVersion` lacks an API the app calls:
/// the update page covers the app until it is updated. A newer release for
/// an instance at or above it is only offered, in the drawer, and updates in
/// the background.
/// These are the rules, kept free of state so tests can read them.
enum UpdateGate {
    /// The oldest instance release with every API the app calls. Raise it
    /// only when the app starts calling an API a newer release brought.
    static let minimumInstanceVersion = "1.1.196"

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

    /// Whether `version` reads as a release number at all.
    static func isVersion(_ version: String) -> Bool { numbers(version) != nil }

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

    /// Rome Cloud's instance statuses while an upgrade is still its own: it
    /// claims `upgrading` before it accepts the upgrade, and a new release
    /// passes through `provisioning` on its way to `running`.
    static let upgradeUnderway: Set<String> = ["upgrading", "provisioning"]

    /// Whether the upgrade is over without the target: Rome Cloud no longer
    /// holds it as upgrading, and the instance still answers on the release
    /// it started from. A failed upgrade and a rolled-back one both end so.
    /// An unknown status or starting release never decides.
    static func endedWithoutTarget(cloudStatus: String?, version: String?, from: String?) -> Bool {
        guard let cloudStatus, let version, let from else { return false }
        return !upgradeUnderway.contains(cloudStatus) && version == from
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
    static func statusLine(_ state: InstanceUpdater.State, progress: Progress, agentName: String? = nil) -> String? {
        switch state {
        case .starting:
            return String(localized: "Asking Rome Cloud to start the update…")
        case .updating(let target, _):
            switch progress {
            case .downloading: return String(localized: "\(UpdateCopy.agent(agentName)) is upgrading to \(target)…")
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
                return String(localized: "Couldn't start the update. Try again in a moment.")
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
    /// Started from the drawer: it runs behind the app, with no update page.
    /// Absent from a record kept before background upgrades: the page's.
    var background = false

    init(target: String, since: Date, from: String? = nil, background: Bool = false) {
        self.target = target
        self.since = since
        self.from = from
        self.background = background
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decode(String.self, forKey: .target)
        since = try container.decode(Date.self, forKey: .since)
        from = try container.decodeIfPresent(String.self, forKey: .from)
        background = try container.decodeIfPresent(Bool.self, forKey: .background) ?? false
    }
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
/// below the minimum version, and while an upgrade started from the page
/// runs. An upgrade started from the drawer runs in the background, its
/// progress in the drawer's row.
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
        /// Rome Cloud ended the upgrade and the instance is back on `from`:
        /// it failed, or was rolled back.
        case rolledBack(target: String, from: String)
    }

    /// What the drawer's update row shows.
    enum RowState: Equatable {
        /// A release the instance can do without: confirm, then update.
        case offered(String)
        case starting
        case updating(target: String)
        case failed(Failure)
    }

    private(set) var state: State = .idle
    /// While updating: what the last look at the instance found.
    private(set) var progress: UpdateGate.Progress = .downloading

    /// The guardian opened the update page from the banner or the drawer.
    private(set) var presented = false
    /// The release the guardian closed the banner for, on this instance.
    private(set) var dismissedVersion: String?
    /// The release an upgrade from this device just reached. A background
    /// upgrade's is said once above the composer.
    private(set) var justUpdated: (instanceID: String, version: String, background: Bool)?
    /// The upgrade under way, or failed, was started from the drawer.
    private(set) var runsInBackground = false
    /// The instance's release when the check last found it behind.
    private var behindOn: String?
    /// The release the open instance runs, as its last check answered.
    private(set) var runningVersion: String?

    var blocking: Bool {
        switch state {
        // `behindOn` is the release the upgrade started from.
        case .starting, .updating: return presented || !UpdateGate.isSupported(behindOn)
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

    /// The drawer's row: the offer, then a background upgrade's progress and
    /// failure. Nil when there is nothing to offer or the page shows it.
    var rowState: RowState? {
        if let offered { return .offered(offered) }
        guard runsInBackground, !blocking else { return nil }
        switch state {
        case .starting: return .starting
        case .updating(let target, _): return .updating(target: target)
        case .failed(let failure): return .failed(failure)
        default: return nil
        }
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

    /// An upgrade is starting or waited on.
    var isUnderway: Bool {
        switch state {
        case .starting, .updating: return true
        default: return false
        }
    }

    /// This device started a background upgrade on `instanceID` that is still
    /// waited on: Rome Cloud reporting it as not running is the upgrade.
    func backgroundUpgradePending(for instanceID: String) -> Bool {
        guard let pending = store.load(instanceID) else { return false }
        return pending.background && !expired(pending)
    }

    var cannotCheck: Bool {
        if case .unknown = state { return true }
        return false
    }

    /// Called once the instance answers on the target release; true for an
    /// upgrade that ran in the background.
    var onFinished: ((_ background: Bool) async -> Void)?
    /// Rome Cloud's status for an instance id, or nil when it cannot say.
    /// It tells a failed or rolled-back upgrade from one still running.
    var cloudStatus: ((String) async -> String?)?

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
    /// Probes since Rome Cloud's status was last read while waiting.
    private var probesSinceStatus = 0
    /// Rome Cloud's looks in a row that found the upgrade over without the
    /// target. Two end the wait: one could catch a passing state.
    private var endedLooks = 0

    /// How long the poll waits between looks at an upgrading instance.
    private let pollInterval: Duration
    /// The time now; tests move it on instead of waiting.
    private let now: () -> Date

    init(store: PendingUpgradeStore = PendingUpgradeStore(), banners: UpdateBannerStore = UpdateBannerStore(), pollInterval: Duration = UpdateGate.pollInterval, now: @escaping () -> Date = { .now }) {
        self.store = store
        self.banners = banners
        self.pollInterval = pollInterval
        self.now = now
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
            case .timedOut(let target), .rolledBack(let target, _): state = .required(current: behindOn, latest: target, latestChanged: false)
            }
        }
    }

    /// The release reached, while it is still to be said.
    var updatedTo: String? { justUpdated?.version }

    /// The release a background upgrade reached, said once above the composer.
    var updatedInBackgroundTo: String? { justUpdated?.background == true ? justUpdated?.version : nil }

    /// The "updated" line was shown.
    func clearUpdated() { justUpdated = nil }

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
        if justUpdated?.instanceID != instanceID { justUpdated = nil }
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
        runsInBackground = false
        dismissedVersion = nil
        behindOn = nil
        runningVersion = nil
    }

    /// Keeps the release a check that answered reports.
    private func noteRunning(_ result: Result<UpgradeCheck, Error>) {
        if case .success(let check) = result, let version = check.current?.version, !version.isEmpty {
            runningVersion = version
        }
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
        noteRunning(result)
        guard mine == generation else { return }
        apply(UpdateGate.verdict(result), latestChanged: false)
    }

    private func checkWhileWaiting(_ pending: PendingUpgrade) async {
        guard let backend, let instanceID else { return }
        probesSinceCheck = 0
        let mine = generation
        let result: Result<UpgradeCheck, Error>
        do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
        noteRunning(result)
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
        runsInBackground = false
        switch verdict {
        case .upToDate: state = .upToDate
        case .unknown(let reason): state = .unknown(reason: reason)
        case .required(let current, let latest):
            behindOn = current
            state = .required(current: current, latest: latest, latestChanged: latestChanged)
        }
    }

    // MARK: Updating

    /// From the update page: the page stays up until the upgrade ends.
    func updateNow() async {
        await start(background: false)
    }

    /// From the drawer, once confirmed: the app stays usable, and the
    /// drawer's row shows how it goes. A release the app needs never runs
    /// in the background.
    func updateInBackground() async {
        guard offered != nil else { return }
        await start(background: true)
    }

    private func start(background: Bool) async {
        guard let backend, let instanceID, case .required(let current, let latest, _) = state else { return }
        if !background { presented = true }
        runsInBackground = background
        state = .starting(current: current, latest: latest)
        let mine = generation
        do {
            let started = try await backend.startUpgrade(target: latest)
            guard mine == generation else { return }
            let pending = PendingUpgrade(target: started.target ?? latest, since: now(), from: current, background: background)
            store.save(pending, for: instanceID)
            startPolling(pending)
        } catch {
            guard mine == generation else { return }
            if UpdateGate.isTargetNotLatest(error) {
                // A newer release came out: show it and let the guardian confirm again.
                let result: Result<UpgradeCheck, Error>
                do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
                noteRunning(result)
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
        let background = runsInBackground
        guard let backend, let instanceID else {
            if case .timedOut(let target) = failure, let instanceID {
                let pending = PendingUpgrade(target: target, since: now(), from: behindOn, background: background)
                store.save(pending, for: instanceID)
                startPolling(pending)
            }
            return
        }
        store.clear(instanceID)
        let result: Result<UpgradeCheck, Error>
        do { result = .success(try await backend.upgradeCheck()) } catch { result = .failure(error) }
        noteRunning(result)
        let verdict = UpdateGate.verdict(result)
        if case .unknown = verdict, case .timedOut(let target) = failure {
            let pending = PendingUpgrade(target: target, since: now(), from: behindOn, background: background)
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

    /// The drawer's Retry: asks again, and an upgrade still on offer starts
    /// again in the background, as the guardian already confirmed it.
    func retryInBackground() async {
        guard case .failed = state, runsInBackground else { return }
        await retry()
        if offered != nil { await updateInBackground() }
    }

    private func startPolling(_ pending: PendingUpgrade) {
        poll?.cancel()
        probesSinceCheck = 0
        probesSinceStatus = 0
        endedLooks = 0
        progress = .downloading
        // An update from the page keeps it up until the guardian closes it, so
        // a failure, after a relaunch too, is always seen; and the release it
        // started from decides whether the page may close. One from the
        // drawer shows in the drawer.
        runsInBackground = pending.background
        if !pending.background { presented = true }
        behindOn = pending.from ?? behindOn
        state = .updating(target: pending.target, since: pending.since)
        let mine = generation
        poll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, mine == self.generation else { return }
                if await self.probe(pending) { return }
                try? await Task.sleep(for: self.pollInterval)
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
            if UpdateGate.pollOutcome(version: nil, target: pending.target, from: pending.from, since: pending.since, now: now()) == .timedOut {
                state = .failed(.timedOut(target: pending.target))
                return true
            }
            return false
        }
        let version = try? await backend.buildInfo().version
        guard mine == generation else { return true }
        progress = UpdateGate.progress(version: version, target: pending.target)
        switch UpdateGate.pollOutcome(version: version, target: pending.target, from: pending.from, since: pending.since, now: now()) {
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
            if await upgradeEnded(pending, version: version) {
                guard mine == generation else { return true }
                if let instanceID { store.clear(instanceID) }
                state = .failed(.rolledBack(target: pending.target, from: pending.from ?? ""))
                return true
            }
            guard mine == generation else { return true }
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

    /// While the instance answers on the release it started from, Rome
    /// Cloud's status is read every other probe: an upgrade it no longer
    /// holds as running ended without the target.
    private func upgradeEnded(_ pending: PendingUpgrade, version: String?) async -> Bool {
        guard let cloudStatus, let instanceID, let from = pending.from, version == from else {
            endedLooks = 0
            return false
        }
        probesSinceStatus += 1
        guard probesSinceStatus >= 2 else { return false }
        probesSinceStatus = 0
        let status = await cloudStatus(instanceID)
        if UpdateGate.endedWithoutTarget(cloudStatus: status, version: version, from: from) {
            endedLooks += 1
        } else {
            endedLooks = 0
        }
        return endedLooks >= 2
    }

    private func finish() async {
        let background = runsInBackground
        if let instanceID {
            store.clear(instanceID)
            switch state {
            case .updating(let target, _), .failed(.timedOut(let target)): justUpdated = (instanceID, target, background)
            default: break
            }
        }
        poll?.cancel()
        poll = nil
        presented = false
        runsInBackground = false
        state = .upToDate
        await onFinished?(background)
    }

    private func expired(_ pending: PendingUpgrade) -> Bool {
        now().timeIntervalSince(pending.since) >= UpdateGate.upgradeTimeout
    }

    #if DEBUG
    /// Snapshot runs only: the line said after a background upgrade.
    func debugShowUpdated(_ version: String) {
        if let instanceID { justUpdated = (instanceID, version, true) }
    }

    /// Snapshot runs only: show a state without a server round trip.
    /// `background`: as an upgrade started from the drawer.
    func debugShow(_ state: State, progress: UpdateGate.Progress = .downloading, background: Bool = false) {
        poll?.cancel()
        poll = nil
        self.state = state
        self.progress = progress
        runsInBackground = background
        switch state {
        // From the page unless shown as a background upgrade, as before.
        case .starting, .updating, .failed: presented = !background
        default: break
        }
        if case .required(let current, _, _) = state { behindOn = current }
    }
    #endif
}
