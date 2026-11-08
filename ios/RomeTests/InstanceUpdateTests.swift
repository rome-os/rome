import Foundation
import Testing
@testable import Rome

private func check(current: String?, latest: String?, available: Bool?) -> UpgradeCheck {
    UpgradeCheck(current: .init(version: current), latest: latest.map { .init(version: $0) }, upgradeAvailable: available)
}

@Suite struct UpdateGateTests {
    @Test func blocksOnlyWhenANewerReleaseIsAvailable() {
        #expect(UpdateGate.verdict(.success(check(current: "0.41.0", latest: "0.42.0", available: true))) == .required(current: "0.41.0", latest: "0.42.0"))
        #expect(UpdateGate.verdict(.success(check(current: "0.42.0", latest: "0.42.0", available: false))) == .upToDate)
        // The flag and the versions disagree: never block on the same version.
        #expect(UpdateGate.verdict(.success(check(current: "0.42.0", latest: "0.42.0", available: true))) == .upToDate)
        #expect(UpdateGate.verdict(.success(check(current: nil, latest: nil, available: nil))) == .upToDate)
    }

    @Test func neverBlocksWhenTheCheckCannotDecide() {
        for reason in ["unversioned_build", "pantheon_unconfigured", "pantheon_unreachable"] {
            let verdict = UpdateGate.verdict(.failure(APIError.server(status: 503, message: reason)))
            #expect(verdict == .unknown(reason: reason))
        }
        #expect(UpdateGate.verdict(.failure(APIError.offline)) == .unknown(reason: "offline"))
        #expect(UpdateGate.verdict(.failure(APIError.network)) == .unknown(reason: "network"))
        #expect(UpdateGate.verdict(.failure(URLError(.timedOut))) == .unknown(reason: "network"))
        // Available but no latest version to update to.
        #expect(UpdateGate.verdict(.success(check(current: "0.41.0", latest: nil, available: true))) == .unknown(reason: "no_latest_version"))
    }

    @Test func pollingEndsOnlyOnTheTargetOrTheTimeout() {
        let since = Date(timeIntervalSince1970: 1_800_000_000)
        let soon = since.addingTimeInterval(60)
        #expect(UpdateGate.pollOutcome(version: nil, target: "0.42.0", from: "0.41.0", since: since, now: soon) == .wait)
        #expect(UpdateGate.pollOutcome(version: "0.41.0", target: "0.42.0", from: "0.41.0", since: since, now: soon) == .wait)
        #expect(UpdateGate.pollOutcome(version: "0.42.0", target: "0.42.0", from: "0.41.0", since: since, now: soon) == .done)
        let late = since.addingTimeInterval(UpdateGate.upgradeTimeout)
        #expect(UpdateGate.pollOutcome(version: nil, target: "0.42.0", from: "0.41.0", since: since, now: late) == .timedOut)
        // The target answering at the deadline still counts.
        #expect(UpdateGate.pollOutcome(version: "0.42.0", target: "0.42.0", from: "0.41.0", since: since, now: late) == .done)
    }

    @Test func aTargetThatWillNeverComeEndsTheWait() {
        let since = Date(timeIntervalSince1970: 1_800_000_000)
        let soon = since.addingTimeInterval(60)
        // Back on another release than it started from: updated further, or rolled back.
        #expect(UpdateGate.pollOutcome(version: "0.43.0", target: "0.42.0", from: "0.41.0", since: since, now: soon) == .movedOn)
        #expect(UpdateGate.pollOutcome(version: "0.40.0", target: "0.42.0", from: "0.41.0", since: since, now: soon) == .movedOn)
        // Without the starting release, only the check can tell.
        #expect(UpdateGate.pollOutcome(version: "0.43.0", target: "0.42.0", from: nil, since: since, now: soon) == .wait)

        #expect(UpdateGate.pending(target: "0.42.0", after: .upToDate) == .finished)
        #expect(UpdateGate.pending(target: "0.42.0", after: .unknown(reason: "network")) == .keepWaiting)
        #expect(UpdateGate.pending(target: "0.42.0", after: .required(current: "0.41.0", latest: "0.42.0")) == .keepWaiting)
        #expect(UpdateGate.pending(target: "0.42.0", after: .required(current: "0.41.0", latest: "0.43.0"))
                == .stale(.required(current: "0.41.0", latest: "0.43.0")))
    }

    @Test func startFailuresReadAsWords() {
        for code in ["pantheon_unreachable", "pantheon_unconfigured", "unversioned_build", "upgrade_in_progress"] {
            let message = UpdateGate.startFailureMessage(APIError.server(status: 502, message: code))
            #expect(!message.contains("_"), "\(code) shows as \(message)")
        }
        #expect(UpdateGate.startFailureMessage(APIError.offline) == APIError.offline.errorDescription)
    }

    @Test func recognizesANewerReleaseRefusal() {
        #expect(UpdateGate.isTargetNotLatest(APIError.server(status: 409, message: "target_not_latest")))
        #expect(!UpdateGate.isTargetNotLatest(APIError.server(status: 409, message: "upgrade_in_progress")))
        #expect(!UpdateGate.isTargetNotLatest(APIError.network))
    }
}

@MainActor
@Suite struct InstanceUpdaterTests {
    private func makeStore() -> PendingUpgradeStore {
        PendingUpgradeStore(defaults: UserDefaults(suiteName: "InstanceUpdaterTests-\(UUID().uuidString)")!)
    }

    @Test func unversionedBuildDoesNotBlock() async {
        let backend = FakeBackend()
        backend.check = .failure(APIError.server(status: 503, message: "unversioned_build"))
        let updater = InstanceUpdater(store: makeStore())
        await updater.attach(backend: backend, instanceID: "local")
        #expect(!updater.blocking)
        #expect(updater.cannotCheck)
    }

    @Test func behindBlocksAndUpdatesUntilTheTargetAnswers() async throws {
        let backend = FakeBackend()
        backend.check = .success(check(current: "0.41.0", latest: "0.42.0", available: true))
        let store = makeStore()
        let updater = InstanceUpdater(store: store)
        var finished = false
        updater.onFinished = { finished = true }
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.blocking)

        await updater.updateNow()
        #expect(backend.started == ["0.42.0"])
        guard case .updating(let target, _) = updater.state else { Issue.record("not updating"); return }
        #expect(target == "0.42.0")
        #expect(store.load("i1")?.target == "0.42.0")

        // The instance comes back on the target.
        backend.buildVersion = "0.42.0"
        await updater.check()
        #expect(finished)
        #expect(!updater.blocking)
        #expect(store.load("i1") == nil)
    }

    @Test func aNewerReleaseAsksAgain() async {
        let backend = FakeBackend()
        backend.check = .success(check(current: "0.41.0", latest: "0.42.0", available: true))
        let updater = InstanceUpdater(store: makeStore())
        await updater.attach(backend: backend, instanceID: "i1")

        backend.startResults = [.failure(APIError.server(status: 409, message: "target_not_latest"))]
        backend.check = .success(check(current: "0.41.0", latest: "0.43.0", available: true))
        await updater.updateNow()
        #expect(updater.state == .required(current: "0.41.0", latest: "0.43.0", latestChanged: true))
    }

    @Test func aRelaunchResumesWaiting() async {
        let backend = FakeBackend()
        let store = makeStore()
        store.save(PendingUpgrade(target: "0.42.0", since: .now), for: "i1")
        // While it restarts the check fails; the pending target wins.
        backend.check = .failure(APIError.network)
        let updater = InstanceUpdater(store: store)
        await updater.attach(backend: backend, instanceID: "i1")
        guard case .updating(let target, _) = updater.state else { Issue.record("not waiting"); return }
        #expect(target == "0.42.0")
        updater.reset()
    }

    @Test func aRememberedTargetIsDroppedWhenTheCheckSaysUpToDate() async {
        let backend = FakeBackend()
        let store = makeStore()
        store.save(PendingUpgrade(target: "0.42.0", since: .now, from: "0.41.0"), for: "i1")
        // Someone updated it from the web; Rome Cloud says it is current.
        backend.check = .success(check(current: "0.43.0", latest: "0.43.0", available: false))
        let updater = InstanceUpdater(store: store)
        var finished = false
        updater.onFinished = { finished = true }
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(!updater.blocking)
        #expect(finished)
        #expect(store.load("i1") == nil)
    }

    @Test func aStaleTargetShowsTheNewLatest() async {
        let backend = FakeBackend()
        let store = makeStore()
        store.save(PendingUpgrade(target: "0.42.0", since: .now, from: "0.41.0"), for: "i1")
        backend.check = .success(check(current: "0.41.0", latest: "0.43.0", available: true))
        let updater = InstanceUpdater(store: store)
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.state == .required(current: "0.41.0", latest: "0.43.0", latestChanged: false))
        #expect(store.load("i1") == nil)
    }

    @Test func resetLeavesNothingBehindForTheNextInstance() async {
        let backend = FakeBackend()
        backend.check = .success(check(current: "0.41.0", latest: "0.42.0", available: true))
        let updater = InstanceUpdater(store: makeStore())
        await updater.attach(backend: backend, instanceID: "a")
        #expect(updater.blocking)

        // Switching away (to an instance that then fails to open) resets it.
        updater.reset()
        #expect(!updater.blocking)
        await updater.updateNow()
        #expect(backend.started.isEmpty)
        await updater.check()
        #expect(updater.state == .idle)
    }
}

/// Answers every request with one status, for testing the client.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
@Suite(.serialized) struct BuildInfoProbeTests {
    @Test func aRestartingInstancesUnauthorizedIsNotAnExpiredSession() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        StubProtocol.status = 401
        let reported = Counter()
        let client = APIClient(origin: URL(string: "https://rome.test")!, token: { "t" }, configuration: configuration) {
            reported.add()
        }
        let backend = LiveBackend(client: client)

        await #expect(throws: APIError.unauthorized) { try await backend.buildInfo() }
        #expect(reported.value == 0)

        // Any other call still reports it.
        await #expect(throws: APIError.unauthorized) { try await backend.upgradeCheck() }
        #expect(reported.value == 1)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}

@Suite struct UpdateStatusLineTests {
    @Test func eachPhaseHasItsLine() {
        #expect(UpdateGate.statusLine(.starting(current: "1.1.183", latest: "1.1.190"), progress: .downloading) == "Asking Rome Cloud to start the update…")
        let updating = InstanceUpdater.State.updating(target: "1.1.190", since: .now)
        #expect(UpdateGate.statusLine(updating, progress: .downloading) == "Downloading 1.1.190…")
        #expect(UpdateGate.statusLine(updating, progress: .restarting) == "Restarting your Rome…")
        #expect(UpdateGate.statusLine(updating, progress: .almostDone) == "Almost done…")
    }

    @Test func noLineWhenNotWaiting() {
        #expect(UpdateGate.statusLine(.required(current: "1", latest: "2", latestChanged: false), progress: .downloading) == nil)
        #expect(UpdateGate.statusLine(.failed(.timedOut(target: "2")), progress: .restarting) == nil)
    }

    @Test func whatTheInstanceAnswersDecidesThePhase() {
        #expect(UpdateGate.progress(version: "1.1.183", target: "1.1.190") == .downloading)
        #expect(UpdateGate.progress(version: nil, target: "1.1.190") == .restarting)
        #expect(UpdateGate.progress(version: "1.1.190", target: "1.1.190") == .almostDone)
    }
}

/// The minimum version decides between the blocking page and the offer.
@MainActor
@Suite struct SoftUpdateTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "SoftUpdateTests-\(UUID().uuidString)")! }

    private func updater(_ defaults: UserDefaults) -> InstanceUpdater {
        InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults))
    }

    @Test func theMinimumVersionReadsReleases() {
        let floor = UpdateGate.minimumInstanceVersion
        #expect(UpdateGate.isSupported(floor))
        #expect(UpdateGate.isSupported("v\(floor)"))
        #expect(UpdateGate.isSupported("1.1.185", minimum: "1.1.185"))
        #expect(!UpdateGate.isSupported("1.1.184", minimum: "1.1.185"))
        #expect(!UpdateGate.isSupported("1.0.999", minimum: "1.1.185"))
        #expect(UpdateGate.isSupported("1.2.0", minimum: "1.1.185"))
        #expect(UpdateGate.isSupported("1.1.185-rc.1", minimum: "1.1.185"))
        // Unknown or unreadable versions are never held against the instance.
        #expect(UpdateGate.isSupported(nil))
        #expect(UpdateGate.isSupported("dev"))
    }

    @Test func behindButSupportedIsOnlyOffered() async {
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.186"), latest: .init(version: "1.1.190"), upgradeAvailable: true))
        let updater = updater(defaults())
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(!updater.blocking)
        #expect(updater.offered == "1.1.190")
        #expect(updater.showsBanner)

        updater.openPage()
        #expect(updater.blocking)
        #expect(updater.canClose)
        #expect(!updater.showsBanner)
        updater.closePage()
        #expect(!updater.blocking)
        #expect(updater.showsBanner)
    }

    @Test func belowTheMinimumBlocksWithNoWayPast() async {
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.100"), latest: .init(version: "1.1.190"), upgradeAvailable: true))
        let updater = updater(defaults())
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.blocking)
        #expect(updater.belowMinimum)
        #expect(!updater.canClose)
        #expect(updater.offered == nil)
        #expect(!updater.showsBanner)
        updater.closePage()
        #expect(updater.blocking)
    }

    @Test func aClosedBannerStaysClosedForThatRelease() async {
        let store = defaults()
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.186"), latest: .init(version: "1.1.190"), upgradeAvailable: true))
        let first = updater(store)
        await first.attach(backend: backend, instanceID: "i1")
        first.dismissBanner()
        #expect(!first.showsBanner)
        // The drawer's line stays while the instance is behind.
        #expect(first.offered == "1.1.190")

        // Next launch: still closed for this release, not for another instance.
        let again = updater(store)
        await again.attach(backend: backend, instanceID: "i1")
        #expect(!again.showsBanner)
        let other = updater(store)
        await other.attach(backend: backend, instanceID: "i2")
        #expect(other.showsBanner)

        // A newer release shows it once more.
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.186"), latest: .init(version: "1.1.191"), upgradeAvailable: true))
        let newer = updater(store)
        await newer.attach(backend: backend, instanceID: "i1")
        #expect(newer.showsBanner)
    }

    @Test func aFailedOfferedUpdateCanBeClosed() async {
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.186"), latest: .init(version: "1.1.190"), upgradeAvailable: true))
        backend.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        let updater = updater(defaults())
        await updater.attach(backend: backend, instanceID: "i1")
        updater.openPage()
        await updater.updateNow()
        guard case .failed = updater.state else { Issue.record("not failed"); return }
        #expect(updater.blocking)
        #expect(updater.canClose)
        updater.closePage()
        #expect(!updater.blocking)
        #expect(updater.offered == "1.1.190")
    }

    /// A visitor cannot update: their workspace is never checked, so no page,
    /// banner or drawer line.
    @Test func visitorsAreNotOffered() async {
        let backend = FakeBackend()
        let drafts = DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-soft-\(UUID().uuidString)/Drafts"), instance: "t")
        let guardianSpace = Workspace(backend: backend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        backend.identity = .success(AccountIdentity(name: "Owner", isGuardian: true))
        await guardianSpace.readRole()
        #expect(AppModel.offersUpdates(to: guardianSpace))

        let visitorBackend = FakeBackend()
        visitorBackend.identity = .success(AccountIdentity(name: "Visitor", isGuardian: false))
        let visitorSpace = Workspace(backend: visitorBackend, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        await visitorSpace.readRole()
        #expect(!AppModel.offersUpdates(to: visitorSpace))
        // What a visitor's never-attached updater shows.
        let idle = updater(defaults())
        #expect(!idle.blocking && idle.offered == nil && !idle.showsBanner)
    }
}
