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

    @Test func leavingTheSignedInPhasesClosesTheGame() {
        let model = AppModel()
        model.stackGame = StackGameLaunch(fromUpdate: true)
        // An upgrade that ends reopens the instance: the game stays.
        model.debugSetPhase(.connecting(host: "me.romeos.cc"))
        model.debugSetPhase(.ready)
        #expect(model.stackGame != nil)
        model.debugSetPhase(.signedOut)
        #expect(model.stackGame == nil)
    }

    @Test func aTappedPushClosesTheGame() async {
        let model = AppModel()
        model.stackGame = StackGameLaunch()
        await model.openFromPush(PushTarget(instanceId: "b", chatId: "concierge"))
        #expect(model.stackGame == nil)
    }
}
