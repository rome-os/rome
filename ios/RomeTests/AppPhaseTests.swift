import Foundation
import Testing
@testable import Rome

/// The phone is a device only while the app is past the sign-in screen.
@MainActor
@Suite struct AppPhaseTests {
    @Test func theSignInScreenAndTheBrowserSignInAreNotSignedIn() {
        let phases: [(AppModel.Phase, Bool)] = [
            (.launching, true), (.connecting(host: "me.romeos.cc"), true), (.stopped(instanceName: "My Rome"), true),
            (.noInstance, true), (.ready, true), (.signedOut, false), (.signingIn, false),
        ]
        for (phase, signedIn) in phases { #expect(phase.isSignedIn == signedIn, "\(phase)") }
    }

    @Test func everyMoveToTheSignInScreenDisconnectsTheDevice() {
        let model = AppModel()
        #expect(model.node.isSignedIn)
        model.debugSetPhase(.signedOut)
        #expect(!model.node.isSignedIn, "failedToConnect, the openInstance fallback and sign-out all set this phase")
        model.debugSetPhase(.ready)
        #expect(model.node.isSignedIn)
        model.debugSetPhase(.signingIn)
        #expect(!model.node.isSignedIn)
        model.debugSetPhase(.connecting(host: "me.romeos.cc"))
        #expect(model.node.isSignedIn)
    }
}
