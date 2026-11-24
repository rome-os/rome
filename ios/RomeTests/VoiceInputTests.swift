import Foundation
import UIKit
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
        // Stops as soon as capture runs, before the socket to nowhere fails.
        await withCheckedContinuation { stopped in
            source.onStart = {
                dictation.stop()
                stopped.resume()
            }
            dictation.start()
        }
        // The unreachable socket may close the dictation after, which releases nothing new.
        #expect(Array(log.events.prefix(3)) == ["begin guardian", "finish", "end"])
        #expect(log.events.filter { $0.hasPrefix("begin") }.count == 1)
    }

    @Test func losingTheMicrophoneWhileListeningStopsListening() async {
        let log = StopLog()
        let source = LoggingSource(log: log)
        var dictation: VoiceDictation?
        let stop: VoiceInputStop? = await withCheckedContinuation { done in
            dictation = VoiceDictation(
                request: URLRequest(url: URL(string: "ws://127.0.0.1:1/ws/voice-input")!),
                source: source, stopTiming: LoggingTiming(log: log),
                handlers: .init(onText: { _ in }, onDone: { _, stop in done.resume(returning: stop) }))
            source.onStart = { Task { @MainActor in source.lose?() } }
            dictation?.start()
        }
        #expect(stop?.reason == .microphoneFailed)
        #expect(log.events.contains("close"))
        _ = dictation
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

    @Test func wordsAnOlderBuildKeptAreDroppedOnLaunch() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        defaults.set(["chat": "listening:Remind me to call the dentist"], forKey: "voiceInput.marks.a")
        let relaunched = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        #expect(relaunched.takeNotice(for: "chat") == VoiceInputStop(reason: .appClosed))
        let kept = defaults.dictionary(forKey: "voiceInput.marks.a") as? [String: String]
        #expect(kept?["chat"]?.contains("dentist") == false)
    }

    @Test func signingOutForgetsEveryInstancesNotices() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).listening(in: "chat")
        VoiceInputService(backend: DemoBackend(), instance: "b", defaults: defaults).listening(in: "chat")
        defaults.set("x", forKey: "other")
        VoiceInputMarks.removeAll(defaults: defaults)
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == nil)
        #expect(VoiceInputService(backend: DemoBackend(), instance: "b", defaults: defaults).takeNotice(for: "chat") == nil)
        #expect(defaults.string(forKey: "other") == "x")
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

    // MARK: Which stops leave a notice

    @Test func backgroundedWithNothingHeardLeavesNoNotice() {
        #expect(VoiceInputStop(reason: .backgrounded).notice(afterHearing: "") == nil)
        #expect(VoiceInputStop(reason: .backgrounded).notice(afterHearing: " \n") == nil)
        #expect(VoiceInputStop(reason: .interrupted).notice(afterHearing: "") == nil)
        #expect(VoiceInputStop(reason: .leftChat).notice(afterHearing: "") == nil)
    }

    @Test func backgroundedAfterWordsSaysWhy() {
        #expect(VoiceInputStop(reason: .backgrounded).notice(afterHearing: "Call the dentist") == VoiceInputStop(reason: .backgrounded))
        #expect(VoiceInputStop(reason: .interrupted).notice(afterHearing: "你好") == VoiceInputStop(reason: .interrupted))
        #expect(VoiceInputStop(reason: .leftChat).notice(afterHearing: "hi") == VoiceInputStop(reason: .leftChat))
    }

    @Test func aFaultSaysWhyEvenWithNothingHeard() {
        for reason in [VoiceInputStopReason.noSpeech, .connectionLost, .microphoneBlocked, .serviceRefused] {
            #expect(VoiceInputStop(reason: reason).notice(afterHearing: "") == VoiceInputStop(reason: reason))
        }
    }

    // MARK: How long a notice shows

    @Test func aNoticeGoesAfterItsTimeOnScreen() async {
        let timer = VoiceNoticeTimer(lifetime: .milliseconds(50), center: NotificationCenter(), appActive: { true })
        let expired = Flag()
        timer.start { expired.set() }
        #expect(!expired.value)
        await expired.wait()
        #expect(expired.value)
    }

    @Test func aNoticeFromTheBackgroundWaitsForTheAppThenGoes() async {
        let center = NotificationCenter()
        let timer = VoiceNoticeTimer(lifetime: .milliseconds(50), center: center, appActive: { false })
        let expired = Flag()
        timer.start { expired.set() }
        try? await Task.sleep(for: .milliseconds(200))
        #expect(!expired.value)
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        await expired.wait()
        #expect(expired.value)
    }

    @Test func notificationCenterOverTheAppStopsTheClockUntilItIsBack() async {
        let center = NotificationCenter()
        let timer = VoiceNoticeTimer(lifetime: .milliseconds(50), center: center, appActive: { true })
        let expired = Flag()
        timer.start { expired.set() }
        // Inactive only, longer than the notice's time: no trip to the background.
        center.post(name: UIApplication.willResignActiveNotification, object: nil)
        try? await Task.sleep(for: .milliseconds(250))
        #expect(!expired.value)
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        await expired.wait()
        #expect(expired.value)
    }

    @Test func onlyAStopWithoutAFaultGoesByItself() {
        for reason in [VoiceInputStopReason.backgrounded, .interrupted, .leftChat, .appClosed] { #expect(reason.endsWithoutFault) }
        for reason in [VoiceInputStopReason.noSpeech, .connectionLost, .microphoneBlocked, .serviceRefused, .timeLimit] { #expect(!reason.endsWithoutFault) }
    }

    @Test func aBackgroundNoticeGoesAfterItsTimeAndStaysGoneAfterARelaunch() async {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        let first = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        first.listening(in: "chat")
        first.stopped(in: "chat", VoiceInputStop(reason: .backgrounded))
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        let voice = Self.controller()
        voice.arrive(service: service, chat: "chat")
        #expect(voice.notice == VoiceInputStop(reason: .backgrounded))
        for _ in 0..<100 where voice.notice != nil { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(voice.notice == nil)
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == nil)
    }

    @Test func aFaultsNoticeStaysUntilAnEditOrSend() async {
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: UserDefaults(suiteName: "voice-input-\(UUID())")!)
        let blocked = VoiceInputStop(reason: .microphoneBlocked)
        service.keep(blocked, for: "chat")
        let voice = Self.controller()
        voice.arrive(service: service, chat: "chat")
        try? await Task.sleep(for: .milliseconds(250))
        #expect(voice.notice == blocked)
        voice.edited(service: service, chat: "chat")
        #expect(voice.notice == nil)
    }

    @Test func leavingTheChatCountsABackgroundNoticeAsSeen() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        let first = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        first.listening(in: "chat")
        first.stopped(in: "chat", VoiceInputStop(reason: .backgrounded))
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        let voice = VoiceInputController()
        voice.arrive(service: service, chat: "chat")
        voice.leave(service: service, chat: "chat")
        #expect(voice.notice == nil)
        #expect(service.takeNotice(for: "chat") == nil)
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == nil)
    }

    @Test func leavingTheChatKeepsAFaultsNoticeForTheReturn() {
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: UserDefaults(suiteName: "voice-input-\(UUID())")!)
        let blocked = VoiceInputStop(reason: .microphoneBlocked)
        service.keep(blocked, for: "chat")
        let voice = VoiceInputController()
        voice.arrive(service: service, chat: "chat")
        voice.leave(service: service, chat: "chat")
        let back = VoiceInputController()
        back.arrive(service: service, chat: "chat")
        #expect(back.notice == blocked)
    }

    // MARK: What a stop keeps for the next launch

    @Test func aBackgroundStopWithNothingHeardLeavesNothingForTheNextLaunch() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        service.listening(in: "chat")
        let voice = Self.controller()
        voice.finished(heard: "", stop: VoiceInputStop(reason: .backgrounded), service: service, chat: "chat", text: .constant(""), handle: ComposerTextHandle())
        #expect(voice.notice == nil)
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == nil)
    }

    @Test func aBackgroundStopAfterWordsSaysWhyOnTheNextLaunch() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        service.listening(in: "chat")
        let voice = Self.controller()
        voice.finished(heard: "Call the dentist", stop: VoiceInputStop(reason: .backgrounded), service: service, chat: "chat", text: .constant(""), handle: ComposerTextHandle())
        #expect(VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).takeNotice(for: "chat") == VoiceInputStop(reason: .backgrounded))
    }

    /// A controller whose notices go after 50 ms, in an app that stays active.
    private static func controller() -> VoiceInputController {
        VoiceInputController(noticeTimer: VoiceNoticeTimer(lifetime: .milliseconds(50), center: NotificationCenter(), appActive: { true }))
    }

    @Test func anEditTakesTheNoticeDownBeforeItsTime() async {
        let timer = VoiceNoticeTimer(lifetime: .milliseconds(50), center: NotificationCenter(), appActive: { true })
        let expired = Flag()
        timer.start { expired.set() }
        timer.cancel()
        try? await Task.sleep(for: .milliseconds(200))
        #expect(!expired.value)
    }

    // MARK: The voice control from the first frame

    @Test func theVoiceControlIsThereBeforeTheInstanceAnswers() async {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        #expect(!VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).available)
        defaults.set(true, forKey: VoiceInputMarks.availablePrefix + "a")
        let service = VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults)
        #expect(service.available)
        #expect(!VoiceInputService(backend: DemoBackend(), instance: "b", defaults: defaults).available)
        // The instance's answer wins, and is kept for the next launch.
        await service.refresh(now: true)
        #expect(!service.available)
        #expect(!VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).available)
    }

    @Test func signingOutForgetsWhichInstancesOfferVoiceInput() {
        let defaults = UserDefaults(suiteName: "voice-input-\(UUID())")!
        defaults.set(true, forKey: VoiceInputMarks.availablePrefix + "a")
        VoiceInputMarks.removeAll(defaults: defaults)
        #expect(!VoiceInputService(backend: DemoBackend(), instance: "a", defaults: defaults).available)
    }

    // MARK: Return while listening

    @Test func returnOnTheFieldGoesToVoiceInputOnlyWhileItListens() throws {
        let view = PastingTextView()
        let isReturn = { (command: UIKeyCommand) in command.input == "\r" && command.modifierFlags.isEmpty }
        #expect(view.keyCommands?.contains(where: isReturn) != true)
        var pressed = 0
        view.onReturn = { pressed += 1 }
        let command = try #require(view.keyCommands?.first(where: isReturn))
        #expect(command.action == #selector(PastingTextView.returnPressed))
        view.returnPressed()
        #expect(pressed == 1)
    }

    @Test func returnWhileIdleSendsNothing() {
        var sent = false
        VoiceInputController().stopAndSend { sent = true }
        #expect(!sent)
    }

    @Test func spokenWordsGoWhereTheGuardianLeftTheCursorElseAtTheEnd() {
        let handle = ComposerTextHandle()
        // Typed into a field the app never saw a cursor in, such as one that lost focus.
        #expect(handle.cursor(in: "Typed 17") == NSRange(location: 8, length: 0))
        handle.caret = NSRange(location: 3, length: 2)
        #expect(handle.cursor(in: "Typed 17") == NSRange(location: 3, length: 2))
        // The text got shorter since (a send): the end again.
        #expect(handle.cursor(in: "Ty") == NSRange(location: 2, length: 0))
    }

    @Test func settingsShowsNoProviderOnlyAProblem() {
        let json = #"{"available":true,"place":{"provider":"Soniox","host":"stt-rt.soniox.com"}}"#
        let info = try? JSONDecoder().decode(VoiceInputInfo.self, from: Data(json.utf8))
        #expect(info?.problemText == nil)
        let signedOut = try? JSONDecoder().decode(VoiceInputInfo.self, from: Data(#"{"available":true,"place":null,"placeUnknown":"rome-cloud-signed-out"}"#.utf8))
        #expect(signedOut?.problemText == String(localized: "Sign in to Rome Cloud again"))
        let older = try? JSONDecoder().decode(VoiceInputInfo.self, from: Data(#"{"available":true}"#.utf8))
        #expect(older?.available == true)
        #expect(older?.problemText == nil)
        let unreachable = try? JSONDecoder().decode(VoiceInputInfo.self, from: Data(#"{"available":true,"place":null,"placeUnknown":"rome-cloud-unreachable"}"#.utf8))
        #expect(unreachable?.problemText == String(localized: "Rome Cloud can't be reached"))
    }

    @Test func standInsOfferNoVoiceInput() async throws {
        let backend = DemoBackend()
        #expect(try await backend.voiceInputInfo() == nil)
        #expect(backend.voiceInputSocket() == nil)
    }
}

@MainActor
private final class Flag {
    private(set) var value = false
    func set() { value = true }

    /// Waits for `set`, at most two seconds, so a busy machine passes too.
    func wait() async {
        for _ in 0..<100 where !value { try? await Task.sleep(for: .milliseconds(20)) }
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
    /// Capture stopping by itself, as when the input changes and cannot be followed.
    private(set) var lose: (@MainActor () -> Void)?
    init(log: StopLog) { self.log = log }
    func requestAccess() async -> Bool { true }
    func start(onChunk: @escaping @Sendable (Data) -> Void, onLost: @escaping @MainActor () -> Void) throws {
        lose = onLost
        onStart?()
    }
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
