import Foundation
import Testing
@testable import Rome

/// Rome Cloud's status for the instance, as a test sets it.
@MainActor
final class CloudStatusBox {
    var status: String?
    var reads = 0
}

/// An optional upgrade runs behind the app, its progress in the drawer's row;
/// one the app needs keeps the page.
@MainActor
@Suite struct BackgroundUpdateTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "BackgroundUpdateTests-\(UUID().uuidString)")! }

    private func offered() -> FakeBackend {
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.197"), latest: .init(version: "1.1.198"), upgradeAvailable: true))
        return backend
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    @Test func anOptionalUpgradeRunsInTheBackground() async throws {
        let backend = offered()
        let defaults = defaults()
        let store = PendingUpgradeStore(defaults: defaults)
        let updater = InstanceUpdater(store: store, banners: UpdateBannerStore(defaults: defaults), pollInterval: .milliseconds(5))
        var finishedInBackground: Bool?
        updater.onFinished = { finishedInBackground = $0 }
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.rowState == .offered("1.1.198"))

        await updater.updateInBackground()
        #expect(backend.started == ["1.1.198"])
        #expect(!updater.blocking)
        #expect(updater.rowState == .updating(target: "1.1.198"))
        #expect(store.load("i1")?.background == true)

        // The instance comes back on the target: the row leaves, and the
        // composer has its line once.
        backend.buildVersion = "1.1.198"
        try await waitFor { finishedInBackground != nil }
        #expect(finishedInBackground == true)
        #expect(!updater.blocking)
        #expect(updater.rowState == nil)
        #expect(updater.updatedInBackgroundTo == "1.1.198")
        updater.clearUpdated()
        #expect(updater.updatedInBackgroundTo == nil)
    }

    /// The page's own upgrade keeps the page and reopens; the composer says nothing.
    @Test func anUpgradeFromThePageStaysOnThePage() async throws {
        let backend = offered()
        let defaults = defaults()
        let updater = InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults), pollInterval: .milliseconds(5))
        var finishedInBackground: Bool?
        updater.onFinished = { finishedInBackground = $0 }
        await updater.attach(backend: backend, instanceID: "i1")
        await updater.updateNow()
        #expect(updater.blocking)
        #expect(updater.rowState == nil)
        backend.buildVersion = "1.1.198"
        try await waitFor { finishedInBackground != nil }
        #expect(finishedInBackground == false)
        #expect(updater.updatedTo == "1.1.198")
        #expect(updater.updatedInBackgroundTo == nil)
    }

    /// Below the minimum the page blocks before, during and after, and the
    /// drawer never offers a background upgrade.
    @Test func aRequiredUpgradeStillBlocks() async {
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.100"), latest: .init(version: "1.1.198"), upgradeAvailable: true))
        let defaults = defaults()
        let updater = InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults))
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.blocking)
        #expect(updater.rowState == nil)
        await updater.updateInBackground()
        #expect(backend.started.isEmpty)
        await updater.updateNow()
        #expect(updater.blocking)
        #expect(updater.rowState == nil)
        updater.reset()
    }

    /// A relaunch picks a background upgrade up in the background, and one
    /// kept before background upgrades on the page.
    @Test func aRelaunchKeepsWhereTheUpgradeRuns() async throws {
        let defaults = defaults()
        let store = PendingUpgradeStore(defaults: defaults)
        store.save(PendingUpgrade(target: "1.1.198", since: .now, from: "1.1.197", background: true), for: "i1")
        let backend = FakeBackend()
        backend.check = .failure(APIError.network)
        let updater = InstanceUpdater(store: store, banners: UpdateBannerStore(defaults: defaults), pollInterval: .milliseconds(5))
        #expect(updater.backgroundUpgradePending(for: "i1"))
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(!updater.blocking)
        #expect(updater.rowState == .updating(target: "1.1.198"))
        updater.reset()

        // A record from before has no `background`: the page's.
        let old = #"{"target":"1.1.198","since":\#(Date.now.timeIntervalSinceReferenceDate),"from":"1.1.197"}"#
        defaults.set(Data(old.utf8), forKey: "pendingUpgrade.i2")
        #expect(store.load("i2")?.background == false)
        #expect(!updater.backgroundUpgradePending(for: "i2"))
        await updater.attach(backend: backend, instanceID: "i2")
        #expect(updater.blocking)
        updater.reset()
    }

    /// Rome Cloud no longer holds the upgrade and the instance still answers
    /// on its old release: failed at once, not after the 40-minute timeout.
    @Test func aRolledBackUpgradeFailsEarly() async throws {
        let backend = offered()
        let defaults = defaults()
        let store = PendingUpgradeStore(defaults: defaults)
        let updater = InstanceUpdater(store: store, banners: UpdateBannerStore(defaults: defaults), pollInterval: .milliseconds(5))
        let cloud = CloudStatusBox()
        cloud.status = "upgrading"
        updater.cloudStatus = { _ in cloud.reads += 1; return cloud.status }
        await updater.attach(backend: backend, instanceID: "i1")
        backend.buildVersion = "1.1.197"
        await updater.updateInBackground()

        // Still upgrading on Rome Cloud: it waits however often it looks.
        try await waitFor { cloud.reads >= 4 }
        #expect(updater.rowState == .updating(target: "1.1.198"))

        cloud.status = "running"
        try await waitFor { if case .failed = updater.state { true } else { false } }
        #expect(updater.state == .failed(.rolledBack(target: "1.1.198", from: "1.1.197")))
        #expect(!updater.blocking)
        #expect(updater.rowState == .failed(.rolledBack(target: "1.1.198", from: "1.1.197")))
        #expect(store.load("i1") == nil)

        // Retry from the drawer starts it again, in the background.
        cloud.status = "upgrading"
        await updater.retryInBackground()
        #expect(backend.started == ["1.1.198", "1.1.198"])
        #expect(updater.rowState == .updating(target: "1.1.198"))
        updater.reset()
    }

    /// The instance away mid-restart, or Rome Cloud still on its way, decides nothing.
    @Test func onlyAnOverUpgradeOnTheOldReleaseHasFailed() {
        #expect(UpdateGate.endedWithoutTarget(cloudStatus: "running", version: "1.1.197", from: "1.1.197"))
        #expect(UpdateGate.endedWithoutTarget(cloudStatus: "unhealthy", version: "1.1.197", from: "1.1.197"))
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: "upgrading", version: "1.1.197", from: "1.1.197"))
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: "provisioning", version: "1.1.197", from: "1.1.197"))
        // A status the app does not know keeps the wait; the timeout ends it.
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: "pulling", version: "1.1.197", from: "1.1.197"))
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: "running", version: nil, from: "1.1.197"))
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: "running", version: "1.1.198", from: "1.1.197"))
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: nil, version: "1.1.197", from: "1.1.197"))
        #expect(!UpdateGate.endedWithoutTarget(cloudStatus: "running", version: "1.1.197", from: nil))
    }

    /// A start Rome Cloud refuses shows in the row, and Retry asks again.
    @Test func aFailedStartShowsInTheRow() async {
        let backend = offered()
        backend.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        let defaults = defaults()
        let updater = InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults))
        await updater.attach(backend: backend, instanceID: "i1")
        await updater.updateInBackground()
        guard case .failed(.start) = updater.state else { Issue.record("\(updater.state)"); return }
        #expect(!updater.blocking)
        if case .failed(.start)? = updater.rowState {} else { Issue.record("row: \(String(describing: updater.rowState))") }
        // Two taps on Retry start it once.
        async let first: Void = updater.retryInBackground()
        async let second: Void = updater.retryInBackground()
        _ = await (first, second)
        #expect(backend.started == ["1.1.198", "1.1.198"])
        #expect(updater.rowState == .updating(target: "1.1.198"))
        updater.reset()
    }

    /// A newer release out since the confirm goes back to the offer.
    @Test func retryNeverStartsAnUnconfirmedRelease() async {
        let backend = offered()
        backend.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        let defaults = defaults()
        let updater = InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults))
        await updater.attach(backend: backend, instanceID: "i1")
        await updater.updateInBackground()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.197"), latest: .init(version: "1.1.199"), upgradeAvailable: true))
        await updater.retryInBackground()
        #expect(backend.started == ["1.1.198"])
        #expect(updater.rowState == .offered("1.1.199"))
    }

    /// A Retry whose check answers after another instance opened leaves that
    /// instance alone.
    @Test func aSlowRetryNeverStartsAnotherInstance() async throws {
        let first = offered()
        first.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        let defaults = defaults()
        let updater = InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults))
        await updater.attach(backend: first, instanceID: "a")
        await updater.updateInBackground()
        first.checkDelay = .milliseconds(200)
        let retry = Task { await updater.retryInBackground() }
        try await Task.sleep(for: .milliseconds(20))
        // Another instance, offered the same release, opens meanwhile.
        let second = offered()
        await updater.attach(backend: second, instanceID: "b")
        await retry.value
        #expect(second.started.isEmpty)
        #expect(first.started == ["1.1.198"])
        #expect(updater.rowState == .offered("1.1.198"))
    }

    /// A Retry that cannot check keeps the failure and its Retry.
    @Test func aRetryThatCannotCheckKeepsTheRow() async {
        let backend = offered()
        backend.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        let defaults = defaults()
        let updater = InstanceUpdater(store: PendingUpgradeStore(defaults: defaults), banners: UpdateBannerStore(defaults: defaults))
        await updater.attach(backend: backend, instanceID: "i1")
        await updater.updateInBackground()
        backend.check = .failure(APIError.network)
        await updater.retryInBackground()
        if case .failed(.start)? = updater.rowState {} else { Issue.record("row: \(String(describing: updater.rowState))") }
        // Back online, Retry starts it.
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.197"), latest: .init(version: "1.1.198"), upgradeAvailable: true))
        await updater.retryInBackground()
        #expect(updater.rowState == .updating(target: "1.1.198"))
        updater.reset()
    }

    /// A check that finds the instance current on another release ends the
    /// wait without saying the target was reached.
    @Test func onlyTheTargetAnsweringIsAnnounced() async {
        let defaults = defaults()
        let store = PendingUpgradeStore(defaults: defaults)
        store.save(PendingUpgrade(target: "1.1.198", since: .now, from: "1.1.197", background: true), for: "i1")
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.199"), latest: .init(version: "1.1.199"), upgradeAvailable: false))
        let updater = InstanceUpdater(store: store, banners: UpdateBannerStore(defaults: defaults))
        var finished: Bool?
        updater.onFinished = { finished = $0 }
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(finished == true)
        #expect(store.load("i1") == nil)
        #expect(updater.updatedInBackgroundTo == nil)
    }
}
