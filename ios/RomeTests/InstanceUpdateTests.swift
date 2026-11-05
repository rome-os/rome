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
        #expect(UpdateGate.pollOutcome(version: nil, target: "0.42.0", since: since, now: soon) == .wait)
        #expect(UpdateGate.pollOutcome(version: "0.41.0", target: "0.42.0", since: since, now: soon) == .wait)
        #expect(UpdateGate.pollOutcome(version: "0.42.0", target: "0.42.0", since: since, now: soon) == .done)
        let late = since.addingTimeInterval(UpdateGate.upgradeTimeout)
        #expect(UpdateGate.pollOutcome(version: nil, target: "0.42.0", since: since, now: late) == .timedOut)
        // The target answering at the deadline still counts.
        #expect(UpdateGate.pollOutcome(version: "0.42.0", target: "0.42.0", since: since, now: late) == .done)
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
}
