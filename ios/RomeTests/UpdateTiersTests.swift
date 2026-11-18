import Foundation
import Testing
@testable import Rome

/// Two minimum instance versions: below the blocking one the update page
/// covers the app; below the background one only, it asks once and hands
/// the upgrade to the drawer; at or above both, a newer release is only
/// offered in the drawer.
@MainActor
@Suite struct UpdateTiersTests {
    /// Blocking below 1.1.190, background below 1.1.197.
    private let minimums = UpdateGate.Minimums(blocking: "1.1.190", background: "1.1.197")

    private func updater(on version: String, latest: String = "1.1.198") -> (InstanceUpdater, FakeBackend, PendingUpgradeStore) {
        let backend = FakeBackend()
        backend.check = .success(UpgradeCheck(current: .init(version: version), latest: .init(version: latest), upgradeAvailable: true))
        let defaults = UserDefaults(suiteName: "UpdateTiersTests-\(UUID().uuidString)")!
        let store = PendingUpgradeStore(defaults: defaults)
        let updater = InstanceUpdater(store: store, banners: UpdateBannerStore(defaults: defaults), minimums: minimums, pollInterval: .milliseconds(5))
        return (updater, backend, store)
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    @Test func theTierFollowsBothMinimums() {
        #expect(UpdateGate.tier("1.1.189", minimums: minimums) == .blocking)
        #expect(UpdateGate.tier("1.1.190", minimums: minimums) == .background)
        #expect(UpdateGate.tier("1.1.196", minimums: minimums) == .background)
        #expect(UpdateGate.tier("1.1.197", minimums: minimums) == .supported)
        #expect(UpdateGate.tier("v1.2.0", minimums: minimums) == .supported)
        // An unknown version is never held against the instance.
        #expect(UpdateGate.tier(nil, minimums: minimums) == .supported)
        #expect(UpdateGate.tier("dev", minimums: minimums) == .supported)
    }

    @Test func whichPageShowsForEachVersion() async {
        let cases: [(String, InstanceUpdater.PageVariant?, Bool)] = [
            ("1.1.150", .blocking, true),
            ("1.1.190", .background, true),
            ("1.1.196", .background, true),
            ("1.1.197", nil, false),
        ]
        for (version, variant, blocking) in cases {
            let (updater, backend, _) = updater(on: version)
            await updater.attach(backend: backend, instanceID: "i1")
            #expect(updater.pageVariant == variant, "\(version)")
            #expect(updater.blocking == blocking, "\(version)")
            // Neither page has a way past it but updating.
            #expect(updater.canClose == (variant == nil), "\(version)")
            updater.reset()
        }
    }

    /// At or above both minimums: offered in the drawer only, as before.
    @Test func aSupportedInstanceIsOnlyOffered() async {
        let (updater, backend, _) = updater(on: "1.1.197")
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(!updater.blocking)
        #expect(updater.rowState == .offered("1.1.198"))
        updater.reset()
    }

    /// The background page's button starts the upgrade, closes the page, and
    /// the drawer takes over: its row, the updated line, the background finish.
    @Test func theBackgroundPageHandsOverToTheDrawer() async throws {
        let (updater, backend, store) = updater(on: "1.1.195")
        var finishedInBackground: Bool?
        updater.onFinished = { finishedInBackground = $0 }
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.pageVariant == .background)
        #expect(updater.blocking)

        await updater.updateFromBackgroundPage()
        #expect(backend.started == ["1.1.198"])
        #expect(!updater.blocking)
        #expect(updater.pageVariant == nil)
        #expect(updater.runsInBackground)
        #expect(updater.rowState == .updating(target: "1.1.198"))
        #expect(store.load("i1")?.background == true)

        backend.buildVersion = "1.1.198"
        try await waitFor { finishedInBackground != nil }
        #expect(finishedInBackground == true)
        #expect(updater.updatedInBackgroundTo == "1.1.198")
        #expect(!updater.blocking)
    }

    /// A failure shows in the drawer's row, not the page, and the drawer's
    /// Retry starts it again in the background without the page coming back.
    @Test func aHandedOverFailureStaysInTheDrawer() async {
        let (updater, backend, _) = updater(on: "1.1.195")
        backend.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        await updater.attach(backend: backend, instanceID: "i1")
        await updater.updateFromBackgroundPage()
        guard case .failed(.start) = updater.state else { Issue.record("\(updater.state)"); return }
        #expect(!updater.blocking)
        if case .failed(.start)? = updater.rowState {} else { Issue.record("row: \(String(describing: updater.rowState))") }

        await updater.retryInBackground()
        #expect(backend.started == ["1.1.198", "1.1.198"])
        #expect(!updater.blocking)
        #expect(updater.rowState == .updating(target: "1.1.198"))
        updater.reset()
    }

    /// A newer release than the one handed over asks again.
    @Test func aNewerReleaseAsksAgain() async {
        let (updater, backend, _) = updater(on: "1.1.195")
        backend.startResults = [.failure(APIError.server(status: 503, message: "pantheon_unreachable"))]
        await updater.attach(backend: backend, instanceID: "i1")
        await updater.updateFromBackgroundPage()
        backend.check = .success(UpgradeCheck(current: .init(version: "1.1.195"), latest: .init(version: "1.1.199"), upgradeAvailable: true))
        await updater.retry()
        #expect(updater.pageVariant == .background)
        #expect(updater.blocking)
        updater.reset()
    }

    /// Below the blocking minimum the page is today's: the background button
    /// does nothing, and an upgrade from it keeps the page up.
    @Test func theBlockingPathIsUnchanged() async {
        let (updater, backend, _) = updater(on: "1.1.150")
        await updater.attach(backend: backend, instanceID: "i1")
        #expect(updater.belowMinimum)
        #expect(updater.offered == nil)
        #expect(updater.rowState == nil)
        await updater.updateFromBackgroundPage()
        await updater.updateInBackground()
        #expect(backend.started.isEmpty)
        updater.closePage()
        #expect(updater.blocking)

        await updater.updateNow()
        #expect(backend.started == ["1.1.198"])
        #expect(updater.blocking)
        #expect(!updater.runsInBackground)
        #expect(updater.rowState == nil)
        updater.reset()
    }
}
