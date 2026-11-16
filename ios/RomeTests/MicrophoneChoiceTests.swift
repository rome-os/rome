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

    @Test func recordsFromTheSystemDefaultWhenTheChosenMicrophoneIsNotConnected() {
        let choice = fresh()
        choice.chosen = "headset"
        #expect(choice.preferred(among: ["built-in"], uid: { $0 }) == nil)
        #expect(choice.isMissing(from: [MicrophoneOption(id: "built-in", name: "iPhone Microphone")]))
    }

    @Test func nothingIsMissingWithNoChoice() {
        let choice = fresh()
        #expect(choice.preferred(among: ["built-in"], uid: { $0 }) == nil)
        #expect(!choice.isMissing(from: []))
    }
}
