import Foundation
import Testing
@testable import Rome

@MainActor
@Suite struct VoiceInputTests {
    @Test func spokenWordsGetASpaceAfterAWordTheWayTypingDoes() {
        #expect(SpokenText.insertion(before: "hello", heard: "world") == " world")
        #expect(SpokenText.insertion(before: "hello ", heard: "world") == "world")
        #expect(SpokenText.insertion(before: "", heard: " world ") == "world")
        #expect(SpokenText.insertion(before: "say", heard: "hi", after: "there") == " hi ")
        #expect(SpokenText.insertion(before: "hello", heard: "") == "")
    }

    @Test func chineseTakesNoSpace() {
        #expect(SpokenText.insertion(before: "你好", heard: "世界") == "世界")
        #expect(SpokenText.insertion(before: "hello", heard: "世界") == "世界")
        #expect(SpokenText.insertion(before: "你好", heard: "world") == "world")
    }

    @Test func readsTheInstancesMessages() {
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"text","settled":"a","pending":"b"}"#.utf8)) == .text(settled: "a", pending: "b"))
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"alive"}"#.utf8)) == .alive)
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"ended"}"#.utf8)) == .ended)
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"error","reason":"no-speech"}"#.utf8)) == .error(VoiceInputStop(reason: .noSpeech)))
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"error","reason":"service-refused","detail":"voice_input_rate_limited"}"#.utf8)) == .error(VoiceInputStop(reason: .serviceRefused, detail: "voice_input_rate_limited")))
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"something-new"}"#.utf8)) == nil)
    }

    @Test func aReasonFromANewerInstanceStillStopsListening() {
        #expect(VoiceInputServerMessage(json: Data(#"{"type":"error","reason":"from-the-future"}"#.utf8)) == .error(VoiceInputStop(reason: .providerUnavailable)))
    }

    @Test func namesRomeCloudsReasonsInItsOwnWords() {
        #expect(VoiceInputStop(reason: .serviceRefused, detail: "voice_input_rate_limited").notice == String(localized: "Too many voice inputs in the last minute. Try again shortly"))
        #expect(VoiceInputStop(reason: .serviceRefused, detail: "unknown").notice == VoiceInputStopReason.serviceRefused.notice)
    }

    @Test func playsOnlyTheSamplesOfARecording() {
        var wav = Data("RIFF".utf8) + Data([0, 0, 0, 0]) + Data("WAVE".utf8)
        wav += Data("fmt ".utf8) + Data([16, 0, 0, 0]) + Data(count: 16)
        wav += Data("data".utf8) + Data([4, 0, 0, 0]) + Data([1, 2, 3, 4])
        #expect(RecordingAudioSource.pcm(wav) == Data([1, 2, 3, 4]))
    }

    @Test func aRefusedMicrophoneNeedsNoRecording() async throws {
        let defaults = UserDefaults.standard
        defaults.set("denied", forKey: RecordingAudioSource.microphoneArgument)
        defer { defaults.removeObject(forKey: RecordingAudioSource.microphoneArgument) }
        let source = try #require(RecordingAudioSource.fromLaunchArguments())
        #expect(await source.requestAccess() == false)
    }

    @Test func standInsOfferNoVoiceInput() async throws {
        let backend = DemoBackend()
        #expect(try await backend.voiceInputInfo() == nil)
        #expect(backend.voiceInputSocket() == nil)
    }
}
