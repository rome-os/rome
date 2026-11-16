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
        let list = MicrophoneChoice.available(session)
        // Complete only when Settings could activate the session without disturbing audio.
        if AVAudioApplication.shared.recordPermission != .granted { #expect(!list.complete) }
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

    @Test func settingsSwitchesToTheSystemDefaultForGoodWhenACompleteListLacksTheChoice() {
        let choice = fresh()
        choice.chosen = "headset"
        let builtIn = MicrophoneOption(id: "built-in", name: "iPhone Microphone")
        let headset = MicrophoneOption(id: "headset", name: "Headset")
        // Unplugged while Settings is open, with no recording in between.
        #expect(choice.settle(MicrophoneList(options: [builtIn], complete: true)) == nil)
        // Plugged back in: the system default stays chosen.
        #expect(choice.settle(MicrophoneList(options: [builtIn, headset], complete: true)) == nil)
        #expect(choice.chosen == nil)
    }

    @Test func settingsKeepsTheChoiceWhenTheListMayLeaveItOut() {
        let choice = fresh()
        choice.chosen = "headset"
        let builtIn = MicrophoneOption(id: "built-in", name: "iPhone Microphone")
        #expect(choice.settle(MicrophoneList(options: [builtIn], complete: false)) == "headset")
        #expect(choice.chosen == "headset")
    }

    @Test func listeningSwitchesToTheSystemDefaultForGoodWhenTheChosenMicrophoneIsTakenOff() {
        let choice = fresh()
        choice.chosen = "headset"
        // Other route changes while listening keep the choice.
        #expect(choice.routeChanged(.categoryChange, connected: ["built-in"]) == "headset")
        // Taken off while listening, with Settings closed.
        #expect(choice.routeChanged(.oldDeviceUnavailable, connected: ["built-in"]) == nil)
        // Plugged back in before the next listening: the system default stays chosen.
        #expect(choice.routeChanged(.newDeviceAvailable, connected: ["built-in", "headset"]) == nil)
        #expect(choice.preferred(among: ["built-in", "headset"], uid: { $0 }) == nil)
    }
}

/// Capture restarts from whichever input takes over, at that input's sample
/// rate: 48 kHz for the built-in microphone, 16 or 8 kHz for Bluetooth.
@Suite struct MicrophoneCaptureTests {
    private final class Chunks: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func add(_ chunk: Data) { lock.withLock { count += chunk.count } }
        var bytes: Int { lock.withLock { count } }
    }

    @Test(arguments: [48_000.0, 16_000.0, 8_000.0])
    func capturesAtTheWireRateFromAnyInputRate(rate: Double) throws {
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1))
        let chunks = Chunks()
        let chunker = try #require(PCMChunker(from: format, onChunk: { chunks.add($0) }))
        let second = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate)))
        second.frameLength = AVAudioFrameCount(rate)
        chunker.take(second)
        chunker.flush()
        // One second of 16-bit mono at the wire's rate, give or take the converter's own delay.
        let expected = VoiceInputWire.sampleRate * 2
        #expect(abs(chunks.bytes - expected) <= expected / 20, "\(chunks.bytes) bytes from one second at \(rate) Hz")
    }
}

