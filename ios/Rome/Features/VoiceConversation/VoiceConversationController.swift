import AVFoundation
import SwiftUI
import UIKit

/// One message field's voice conversation: whether it runs, Rome's state,
/// mute, and why the last one ended on its own. As in a call, it goes on with
/// the screen locked or another app in front (the `audio` background mode). A
/// call or Siri pauses it, and it goes on after unless the system says not to.
/// The screen stays on while it runs in front.
@MainActor
@Observable
final class VoiceConversationController {
    private(set) var active = false
    private(set) var state: VoiceConversationState = .listening
    private(set) var muted = false
    /// Why the last conversation ended on its own; it goes on the next edit,
    /// send or start. One without a fault also goes once seen for a while.
    private(set) var notice: VoiceConversationStopReason?
    @ObservationIgnored private let noticeTimer: VoiceNoticeTimer
    @ObservationIgnored private let makeAudio: @MainActor () -> VoiceConversationAudio
    @ObservationIgnored private var conversation: VoiceConversation?
    @ObservationIgnored private var audio: VoiceConversationAudio?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    /// The Lock Screen and Dynamic Island's sign that a conversation runs.
    @ObservationIgnored private let presence: VoiceConversationPresence
    /// Where the app's trips to the background and audio interruptions are told.
    @ObservationIgnored private let center: NotificationCenter

    init(noticeTimer: VoiceNoticeTimer = VoiceNoticeTimer(), center: NotificationCenter = .default,
         makeAudio: @escaping @MainActor () -> VoiceConversationAudio = VoiceConversationAudios.make,
         presence: VoiceConversationPresence = VoiceConversationLiveActivityPresence()) {
        self.noticeTimer = noticeTimer
        self.center = center
        self.makeAudio = makeAudio
        self.presence = presence
    }

    /// Starts a voice conversation in `chat`. Does nothing while one runs, or
    /// without a signed-in instance.
    func start(service: VoiceInputService, chat: String) {
        guard conversation == nil, let request = service.conversationSocketRequest() else { return }
        start(request: request, chat: chat)
    }

    func start(request: URLRequest, chat: String, session: URLSession = .shared) {
        guard conversation == nil else { return }
        notice = nil
        noticeTimer.cancel()
        state = .listening
        muted = false
        active = true
        // In front, the screen stays on while the conversation runs.
        UIApplication.shared.isIdleTimerDisabled = true
        // On the Lock Screen and in the Dynamic Island, while it runs.
        presence.show()
        let audio = makeAudio()
        self.audio = audio
        let conversation = VoiceConversation(
            request: request,
            chatId: chat,
            audio: audio,
            session: session,
            handlers: .init(
                onState: { [weak self] state in self?.state = state },
                onEnded: { [weak self] reason in self?.ended(reason) }
            )
        )
        self.conversation = conversation
        observe()
        conversation.start()
    }

    /// The guardian's End.
    func end() { conversation?.end() }

    /// The field now writes in the chat itself, or, `here` false, in a thread
    /// or a reply to one message. A conversation's turns go to the chat itself,
    /// where the thread would not show them, so it ends, as the guardian's End
    /// does, with no line.
    func fieldMoved(here: Bool) {
        if !here { end() }
    }

    func toggleMute() {
        guard let conversation else { return }
        muted.toggle()
        conversation.setMuted(muted)
    }

    /// How loud whoever is talking is, 0 to 1: Rome while it speaks, the guardian otherwise.
    func level() -> Float {
        guard active, let audio else { return 0 }
        if state == .speaking { return audio.replyLevel }
        return muted ? 0 : audio.microphoneLevel
    }

    /// The field is going away with the chat: the conversation ends, as on
    /// the dashboard, and a notice that goes by itself goes too.
    func leave() {
        conversation?.end()
        if let notice, notice.endsWithoutFault { dismissNotice() }
    }

    /// The guardian's own edit in the field, or a send: the notice goes.
    func edited() {
        guard notice != nil, !active else { return }
        dismissNotice()
    }

    private func ended(_ reason: VoiceConversationStopReason?) {
        conversation = nil
        audio = nil
        active = false
        muted = false
        state = .listening
        UIApplication.shared.isIdleTimerDisabled = false
        presence.hide()
        for observer in observers { center.removeObserver(observer) }
        observers = []
        guard let reason else { return }
        notice = reason
        UIAccessibility.post(notification: .announcement, argument: reason.notice)
        if reason.endsWithoutFault {
            noticeTimer.start { [weak self] in self?.notice = nil }
        }
    }

    private func dismissNotice() {
        notice = nil
        noticeTimer.cancel()
    }

    /// A call, Siri or another app taking the microphone stops the audio. When
    /// that ends and the system says the app may go on, the conversation goes
    /// on; otherwise it ends with a line that goes by itself. iOS may never
    /// say it ended: the app coming to the front resumes it too.
    private func observe() {
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.conversation?.cameToFront() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                MainActor.assumeIsolated { self?.conversation?.interrupted() }
                return
            }
            guard type == AVAudioSession.InterruptionType.ended.rawValue else { return }
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated {
                if options.contains(.shouldResume) {
                    self?.conversation?.resumeAudio()
                } else {
                    self?.conversation?.end(.interrupted)
                }
            }
        })
    }
}
