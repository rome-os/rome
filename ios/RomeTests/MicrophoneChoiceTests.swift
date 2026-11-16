import AVFoundation
import Foundation
import Testing
@testable import Rome

@Suite struct MicrophoneChoiceTests {
    private func fresh() -> MicrophoneChoice {
        let name = "microphone-choice-\(UUID().uuidString)"
        return MicrophoneChoice(defaults: UserDefaults(suiteName: name)!)
    }

    @Test func settingsRefreshesOnlyWhenAMicrophoneIsPluggedInOrTakenOff() {
        #expect(MicrophoneRow.refreshes(on: .newDeviceAvailable))
        #expect(MicrophoneRow.refreshes(on: .oldDeviceUnavailable))
        // Listing the microphones changes the category and back; that must not refresh again.
        #expect(!MicrophoneRow.refreshes(on: .categoryChange))
        #expect(!MicrophoneRow.refreshes(on: .override))
        #expect(!MicrophoneRow.refreshes(on: nil))
    }

    @MainActor
    @Test func listingTheMicrophonesLeavesTheAudioSessionAsItWas() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        defer { try? session.setCategory(.soloAmbient) }
        // iOS adds options of its own, such as mixing with others when ducking.
        let options = session.categoryOptions
        _ = MicrophoneChoice.available(session)
        #expect(session.category == .playback)
        #expect(session.mode == .spokenAudio)
        #expect(session.categoryOptions == options)
    }

    @Test func isTheSystemDefaultUntilOneIsChosenAndAgainAfterItIsCleared() {
        let choice = fresh()
        #expect(choice.chosen == nil)
        choice.chosen = "usb"
        #expect(choice.chosen == "usb")
        choice.chosen = nil
        #expect(choice.chosen == nil)
    }

    @Test func recordsFromTheChosenMicrophoneWhileItIsConnected() {
        let choice = fresh()
        choice.chosen = "headset"
        #expect(choice.preferred(among: ["built-in", "headset"], uid: { $0 }) == "headset")
    }

    @Test func switchesToTheSystemDefaultWhenTheChosenMicrophoneIsUnplugged() {
        let choice = fresh()
        choice.chosen = "headset"
        #expect(choice.settle(connected: ["built-in"]) == nil)
        #expect(choice.chosen == nil)
        #expect(choice.preferred(among: ["built-in"], uid: { $0 }) == nil)
    }

    @Test func keepsTheChoiceWhileItIsConnectedOrIOSHasNotListedInputsYet() {
        let choice = fresh()
        choice.chosen = "headset"
        #expect(choice.settle(connected: ["built-in", "headset"]) == "headset")
        #expect(choice.settle(connected: []) == "headset")
    }
}
