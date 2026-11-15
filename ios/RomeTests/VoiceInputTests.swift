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

    // MARK: Rule 9's StopListening interval

    @Test func aStopsIntervalEndsOnlyOnceTheMicrophoneIsReleased() async {
        let log = StopLog()
        let source = LoggingSource(log: log)
        let dictation = VoiceDictation(
            request: URLRequest(url: URL(string: "ws://127.0.0.1:1/ws/voice-input")!),
            source: source, stopTiming: LoggingTiming(log: log),
            handlers: .init(onText: { _ in }, onDone: { _, _ in }))
        await withCheckedContinuation { started in
            source.onStart = { started.resume() }
            dictation.start()
        }
        dictation.stop()
        #expect(log.events == ["begin guardian", "finish", "end"])
    }

    @Test func everyOtherStopIsTimedTheSameWay() {
        let stops: [@MainActor (VoiceDictation) -> Void] = [{ $0.end(.noSpeech) }, { $0.cancel() }]
        for stop in stops {
            let log = StopLog()
            let dictation = VoiceDictation(
                request: URLRequest(url: URL(string: "ws://127.0.0.1:1/ws/voice-input")!),
                source: LoggingSource(log: log), stopTiming: LoggingTiming(log: log),
                handlers: .init(onText: { _ in }, onDone: { _, _ in }))
            stop(dictation)
            #expect(log.events.first?.hasPrefix("begin ") == true)
            #expect(Array(log.events.dropFirst()) == ["close", "end"])
        }
    }

    // MARK: Rule 7's notice after a relaunch

    @Test func aChatStillListeningWhenTheAppClosedSaysSoOnTheNextLaunch() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).listening(in: "chat")
        let relaunched = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        #expect(relaunched.takeNotice(for: "chat") == VoiceInputStop(reason: .appClosed))
        #expect(VoiceInputService(backend: DemoBackend(), instance: "b", defaults: defaults).takeNotice(for: "chat") == nil)
    }

    @Test func aNoticeOutlivesTheAppUntilAnEditOrSend() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        service.listening(in: "chat")
        service.stopped(in: "chat", VoiceInputStop(reason: .backgrounded))
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == VoiceInputStop(reason: .backgrounded))
        service.noticeSeen(in: "chat")
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == nil)
    }

    @Test func theGuardiansOwnStopLeavesNothingForTheNextLaunch() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        service.listening(in: "chat")
        service.stopped(in: "chat", nil)
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == nil)
    }

    @Test func standInsOfferNoVoiceInput() async throws {
        let backend = DemoBackend()
        #expect(try await backend.voiceInputInfo() == nil)
        #expect(backend.voiceInputSocket() == nil)
    }
}

@MainActor
private final class StopLog {
    var events: [String] = []
}

/// The microphone, which Rome doesn't own: it says when it was released.
@MainActor
private final class LoggingSource: VoiceAudioSource {
    let log: StopLog
    var onStart: (() -> Void)?
    init(log: StopLog) { self.log = log }
    func requestAccess() async -> Bool { true }
    func start(onChunk: @escaping @Sendable (Data) -> Void) throws { onStart?() }
    func finish() { log.events.append("finish") }
    func close() { log.events.append("close") }
}

/// The signpost, which Rome doesn't own: it says when the interval ran.
@MainActor
private final class LoggingTiming: VoiceStopTiming {
    let log: StopLog
    init(log: StopLog) { self.log = log }
    func begin(cause: String) { log.events.append("begin \(cause)") }
    func end() { log.events.append("end") }
}
