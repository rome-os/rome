import os
import AVFoundation
import SwiftUI
import UIKit

/// Voice input on one instance: whether it is there, and where its socket is.
/// Lives with the workspace, so every message field of the instance shares it.
@MainActor
@Observable
final class VoiceInputService {
    /// False hides the voice control: the instance is not signed in to Rome
    /// Cloud, Rome Cloud does not allow the account, or the instance is older
    /// than voice input.
    private(set) var available = false
    private let backend: RomeBackend
    private var checkedAt: Date?
    /// Why listening stopped in a chat the guardian left, shown on return.
    private var leftNotices: [String: VoiceInputStop] = [:]

    init(backend: RomeBackend) {
        self.backend = backend
    }

    /// Asks the instance again, at most once a minute.
    func refresh() async {
        if let checkedAt, Date().timeIntervalSince(checkedAt) < 60 { return }
        checkedAt = Date()
        available = (try? await backend.voiceInputInfo())?.available ?? false
    }

    func socketRequest() -> URLRequest? { backend.voiceInputSocket() }

    func keep(_ stop: VoiceInputStop, for chat: String) { leftNotices[chat] = stop }
    func takeNotice(for chat: String) -> VoiceInputStop? { leftNotices.removeValue(forKey: chat) }
}

/// The message field's UIKit view, so spoken text can go in the way typing does.
@MainActor
final class ComposerTextHandle {
    weak var view: PastingTextView?

    /// Puts `original` back, selects `range`, and types `text` there: the
    /// field's change handler sees typed text, and one undo removes it.
    func type(_ text: String, replacing range: NSRange, in original: String) -> Bool {
        guard let view else { return false }
        view.isEditable = true
        view.text = original
        view.selectedRange = range
        view.insertText(text)
        view.delegate?.textViewDidChange?(view)
        return true
    }
}

/// One message field's voice input: listening, finishing, and the notice.
@MainActor
@Observable
final class VoiceInputController {
    enum State { case idle, listening, finishing }

    private(set) var state: State = .idle
    /// Why listening last stopped on its own; it goes away on the next edit or send.
    private(set) var notice: VoiceInputStop?
    /// The field's text when the notice went up: any other text is an edit.
    @ObservationIgnored private var noticeText: String?
    @ObservationIgnored private var dictation: VoiceDictation?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var anchor: (original: String, range: NSRange)?
    /// From the tap until the field shows it listens.
    @ObservationIgnored private var startInterval: OSSignpostIntervalState?

    var active: Bool { state != .idle }

    func toggle(service: VoiceInputService, field: VoiceInputField, text: Binding<String>, handle: ComposerTextHandle) {
        switch state {
        case .idle: start(service: service, field: field, text: text, handle: handle)
        case .listening: stop()
        case .finishing: break
        }
    }

    func start(service: VoiceInputService, field: VoiceInputField, text: Binding<String>, handle: ComposerTextHandle) {
        guard dictation == nil, let request = service.socketRequest() else { return }
        startInterval = VoiceInputSignpost.begin(field)
        let original = text.wrappedValue
        let length = (original as NSString).length
        let selected = handle.view?.selectedRange ?? NSRange(location: length, length: 0)
        let range = NSIntersectionRange(selected, NSRange(location: 0, length: length))
        anchor = (original, range)
        notice = nil
        noticeText = nil
        state = .listening
        let before = (original as NSString).substring(to: range.location)
        let after = (original as NSString).substring(from: NSMaxRange(range))
        let dictation = VoiceDictation(
            request: request,
            source: VoiceAudioSources.make(),
            handlers: .init(
                onText: { heard in
                    text.wrappedValue = before + SpokenText.insertion(before: before, heard: heard, after: after) + after
                },
                onDone: { [weak self] heard, stop in
                    self?.done(heard: heard, stop: stop, text: text, handle: handle)
                }
            )
        )
        self.dictation = dictation
        observe()
        dictation.start()
    }

    /// Call when the field has drawn `state`: a start's interval ends once
    /// the field shows that it listens.
    func stateShown() {
        guard let interval = startInterval, state != .idle else { return }
        startInterval = nil
        VoiceInputSignpost.end(interval)
    }

    func stop() {
        guard state == .listening, let dictation else { return }
        state = .finishing
        dictation.stop()
    }

    /// The field is going away with the chat: listening stops, the words stay
    /// in the draft, and the chat says why when the guardian comes back.
    func leave(service: VoiceInputService?, chat: String?) {
        guard let dictation else { return }
        dictation.cancel()
        finishListening()
        anchor = nil
        if let service, let chat { service.keep(VoiceInputStop(reason: .leftChat), for: chat) }
    }

    /// The field opened: a chat left while listening says why.
    func arrive(service: VoiceInputService?, chat: String?, text: String) {
        guard let service, let chat, let stop = service.takeNotice(for: chat) else { return }
        show(stop, text: text)
    }

    /// Call when the field's text changes: an edit or a send clears the notice.
    func textChanged(_ text: String) {
        guard notice != nil, !active, text != noticeText else { return }
        notice = nil
        noticeText = nil
    }

    private func done(heard: String, stop: VoiceInputStop?, text: Binding<String>, handle: ComposerTextHandle) {
        finishListening()
        guard let anchor else { return }
        self.anchor = nil
        let original = anchor.original as NSString
        let before = original.substring(to: anchor.range.location)
        let after = original.substring(from: NSMaxRange(anchor.range))
        let insertion = SpokenText.insertion(before: before, heard: heard, after: after)
        if insertion.isEmpty {
            text.wrappedValue = anchor.original
        } else if !handle.type(insertion, replacing: anchor.range, in: anchor.original) {
            text.wrappedValue = before + insertion + after
        }
        if let stop { show(stop, text: handle.view?.text ?? text.wrappedValue) }
    }

    private func show(_ stop: VoiceInputStop, text: String) {
        notice = stop
        noticeText = text
        UIAccessibility.post(notification: .announcement, argument: stop.notice)
    }

    private func finishListening() {
        dictation = nil
        state = .idle
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
    }

    /// The app going to the background, or a call, Siri or another app taking
    /// the microphone, stops listening at once. It never resumes by itself.
    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.dictation?.end(.backgrounded) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            MainActor.assumeIsolated { self?.dictation?.end(.interrupted) }
        })
    }
}
