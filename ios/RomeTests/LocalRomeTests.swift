import Foundation
import Testing
@testable import Rome

/// A local Rome (DEBUG, `ROME_LOCAL_*`) is no Rome Cloud workspace: a Cloud
/// failure never signs it out or replaces it.
@MainActor
@Suite struct LocalRomeTests {
    private func localModel() -> (AppModel, Workspace) {
        let model = AppModel()
        let workspace = Workspace(backend: DemoBackend(), instanceName: "Local Rome", host: "local.test", accountLabel: "dev")
        model.debugOpenLocal(workspace)
        return (model, workspace)
    }

    @Test func aRejectedNodeCredentialKeepsTheLocalRomeOpen() {
        let (model, workspace) = localModel()
        #expect(model.opensLocal)
        model.node.onCredentialRejected?()
        #expect(model.phase == .ready)
        #expect(model.workspace === workspace)
        #expect(model.currentInstance?.id == AppModel.localInstanceID)
    }

    @Test func aCloudInstanceIsNoLocalRome() {
        let model = AppModel()
        #expect(!model.opensLocal)
    }
}
