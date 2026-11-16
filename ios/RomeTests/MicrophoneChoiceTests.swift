import Foundation
import Testing
@testable import Rome

@Suite struct MicrophoneChoiceTests {
    private func fresh() -> MicrophoneChoice {
        let name = "microphone-choice-\(UUID().uuidString)"
        return MicrophoneChoice(defaults: UserDefaults(suiteName: name)!)
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
