import AVFoundation
import Foundation
import UIKit
import Testing
@testable import Rome

@MainActor
@Suite struct VoiceConversationTests {
    // MARK: The socket's messages

    @Test func readsWhatDrivesTheAudioAndTheCapsule() {
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"ready","sampleRate":24000}"#.utf8)) == .ready(sampleRate: 24000))
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"state","state":"thinking"}"#.utf8)) == .state(.thinking))
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"clear"}"#.utf8)) == .clear)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"alive"}"#.utf8)) == .alive)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"ended"}"#.utf8)) == .ended)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"error","reason":"chat-refused"}"#.utf8)) == .error(.chatRefused))
    }

    @Test func theWordsAndCaptionsAreLeftToTheChat() {
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"heard","settled":"a","pending":"b"}"#.utf8)) == nil)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"turn","text":"a"}"#.utf8)) == nil)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"caption","text":"a"}"#.utf8)) == nil)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"something-new"}"#.utf8)) == nil)
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"state","state":"dreaming"}"#.utf8)) == nil)
    }

    @Test func aReasonFromANewerInstanceStillEndsTheConversation() {
        #expect(VoiceConversationServerMessage(json: Data(#"{"type":"error","reason":"from-the-future"}"#.utf8)) == .error(.badRequest))
    }

    @Test func theStartNamesTheChatAndTheMicrophonesRate() throws {
        let start = VoiceConversationWire.start(chatId: #"chat "1""#, sampleRate: 16000)
        let object = try #require(JSONSerialization.jsonObject(with: Data(start.utf8)) as? [String: Any])
        #expect(object["type"] as? String == "start")
        #expect(object["chatId"] as? String == #"chat "1""#)
        #expect(object["sampleRate"] as? Int == 16000)
        #expect(VoiceConversationWire.sampleRate == VoiceInputWire.sampleRate)
    }

    @Test func onlyLeavingTheAppOrACallEndsWithoutAFault() {
        let all: [VoiceConversationStopReason] = [
            .unavailable, .listeningFailed, .speakingFailed, .chatRefused, .timeLimit, .badRequest,
            .microphoneBlocked, .microphoneFailed, .connectionLost, .backgrounded, .interrupted,
        ]
        #expect(all.filter(\.endsWithoutFault) == [.backgrounded, .interrupted])
        for reason in all { #expect(!reason.notice.isEmpty) }
        #expect(VoiceConversationStopReason.microphoneBlocked.notice == String(localized: "Microphone blocked. Allow it in Settings"))
    }

    // MARK: Whether the field offers it

    @Test func theInstancesAnswerShowsTheControlAndIsKeptForTheNextLaunch() async {
        let defaults = UserDefaults(suiteName: "voice-conversation-\(UUID())")!
        let backend = StubBackend()
        backend.conversationInfo = VoiceConversationInfo(available: true)
        let service = VoiceInputService(backend: backend, instance: "a", defaults: defaults)
        #expect(!service.conversationAvailable)
        await service.refresh(now: true)
        #expect(service.conversationAvailable)
        #expect(VoiceInputService(backend: StubBackend(), instance: "a", defaults: defaults).conversationAvailable)
        #expect(!VoiceInputService(backend: StubBackend(), instance: "b", defaults: defaults).conversationAvailable)
    }

    @Test func anInstanceOlderThanVoiceConversationsOffersNone() async {
        let defaults = UserDefaults(suiteName: "voice-conversation-\(UUID())")!
        defaults.set(true, forKey: VoiceInputMarks.conversationAvailablePrefix + "a")
        let backend = StubBackend()
        backend.conversationError = .notFound
        let service = VoiceInputService(backend: backend, instance: "a", defaults: defaults)
        #expect(service.conversationAvailable)
        await service.refresh(now: true)
        #expect(!service.conversationAvailable)
        #expect(!VoiceInputService(backend: StubBackend(), instance: "a", defaults: defaults).conversationAvailable)
    }

    @Test func anInstanceThatCannotSayNowKeepsItsLastAnswer() async {
        let defaults = UserDefaults(suiteName: "voice-conversation-\(UUID())")!
        defaults.set(true, forKey: VoiceInputMarks.conversationAvailablePrefix + "a")
        let backend = StubBackend()
        backend.conversationError = .network
        let service = VoiceInputService(backend: backend, instance: "a", defaults: defaults)
        await service.refresh(now: true)
        #expect(service.conversationAvailable)
    }

    @Test func signingOutForgetsWhichInstancesOfferVoiceConversations() {
        let defaults = UserDefaults(suiteName: "voice-conversation-\(UUID())")!
        defaults.set(true, forKey: VoiceInputMarks.conversationAvailablePrefix + "a")
        VoiceInputMarks.removeAll(defaults: defaults)
        #expect(!VoiceInputService(backend: StubBackend(), instance: "a", defaults: defaults).conversationAvailable)
    }

    @Test func standInsOfferNoVoiceConversation() async throws {
        let backend = DemoBackend()
        #expect(try await backend.voiceConversationInfo() == nil)
        #expect(backend.voiceConversationSocket() == nil)
    }

    // MARK: Starting and ending

    @Test func aRefusedMicrophoneEndsAtOnceAndSaysWhere() async {
        let audio = FakeAudio(allowed: false)
        let controller = VoiceConversationController(makeAudio: { audio })
        controller.start(request: Self.request, chat: "chat")
        #expect(controller.active)
        await waitUntil { !controller.active }
        #expect(controller.notice == .microphoneBlocked)
        #expect(!audio.started)
        // The guardian's next edit takes the line down.
        controller.edited()
        #expect(controller.notice == nil)
    }

    @Test func leavingTheAppEndsItWithALineThatGoesByItself() async {
        let audio = FakeAudio(allowed: true)
        // The app's own center would send every other test to the background too.
        let center = NotificationCenter()
        let controller = VoiceConversationController(center: center, makeAudio: { audio })
        controller.start(request: Self.request, chat: "chat")
        center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        await waitUntil { !controller.active }
        #expect(!controller.active)
        #expect(controller.notice == .backgrounded)
        #expect(controller.notice?.endsWithoutFault == true)
        // Leaving the chat takes a line that goes by itself down with it.
        controller.leave()
        #expect(controller.notice == nil)
    }

    @Test func theGuardiansEndLeavesNoLine() async {
        let audio = FakeAudio(allowed: true)
        let controller = VoiceConversationController(makeAudio: { audio })
        controller.start(request: Self.request, chat: "chat")
        controller.end()
        #expect(!controller.active)
        #expect(controller.notice == nil)
        #expect(audio.closed)
    }

    @Test func theBarsFollowWhoeverIsTalking() {
        let audio = FakeAudio(allowed: true)
        audio.microphoneLevel = 0.4
        audio.replyLevel = 0.8
        let controller = VoiceConversationController(makeAudio: { audio })
        #expect(controller.level() == 0)
        controller.start(request: Self.request, chat: "chat")
        #expect(controller.level() == 0.4)
        controller.toggleMute()
        #expect(controller.muted)
        #expect(controller.level() == 0)
        controller.toggleMute()
        #expect(!controller.muted)
        controller.end()
    }

    // MARK: The capsule and the audio

    @Test func mutedBarsRestAndReduceMotionHoldsTheirShape() {
        let muted = VoiceConversationCapsule.values(.muted, at: 12.3, eased: 1, still: false)
        #expect(muted.allSatisfy { $0 == 0 })
        let still = VoiceConversationCapsule.values(.listening, at: 12.3, eased: 1, still: true)
        #expect(still == VoiceConversationCapsule.shape.map { $0 * 0.5 })
        let thinking = VoiceConversationCapsule.values(.thinking, at: 4.2, eased: 0, still: false)
        #expect(thinking.allSatisfy { $0 >= 0.12 && $0 <= 0.42 + 1e-9 })
        let quiet = VoiceConversationCapsule.values(.listening, at: 4.2, eased: 0, still: false)
        #expect(quiet.allSatisfy { $0 == 0 })
        #expect(VoiceConversationCapsule.shape.count == 14)
    }

    @Test func theReplysSamplesPlayAsTheyCame() throws {
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1))
        var samples: [Int16] = [0, 16384, -16384, Int16.max, Int16.min]
        let chunk = Data(bytes: &samples, count: samples.count * 2)
        let buffer = try #require(SpeakerphoneAudio.buffer(chunk, format: format))
        #expect(buffer.frameLength == 5)
        let channel = try #require(buffer.floatChannelData?[0])
        #expect(channel[0] == 0)
        #expect(channel[1] == 0.5)
        #expect(channel[2] == -0.5)
        #expect(channel[4] == -1)
        #expect(SpeakerphoneAudio.buffer(Data(), format: format) == nil)
    }

    @Test func anOldReadingIsSilence() async {
        let reading = LevelReading()
        reading.set(0.7)
        #expect(reading.current == 0.7)
        try? await Task.sleep(for: .milliseconds(Int(LevelReading.stale * 1000) + 100))
        #expect(reading.current == 0)
    }

    // MARK: Helpers

    /// Nowhere: no test reaches a socket.
    private static let request = URLRequest(url: URL(string: "ws://127.0.0.1:9/ws/voice-conversation")!)

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(20)) }
    }
}

/// The microphone and speaker, which Rome doesn't own: it says what was asked of it.
@MainActor
private final class FakeAudio: VoiceConversationAudio {
    let allowed: Bool
    private(set) var started = false
    private(set) var closed = false
    var microphoneLevel: Float = 0
    var replyLevel: Float = 0

    init(allowed: Bool) { self.allowed = allowed }

    func requestAccess() async -> Bool { allowed }
    func start(onChunk: @escaping @Sendable (Data) -> Void, onLost: @escaping @MainActor () -> Void) throws { started = true }
    func play(_ chunk: Data, sampleRate: Int) {}
    func clear() {}
    func close() { closed = true }
}
