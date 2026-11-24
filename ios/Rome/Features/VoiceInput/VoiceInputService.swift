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
    /// What the instance last said, for Settings to name where speech goes.
    private(set) var info: VoiceInputInfo?
    private let backend: RomeBackend
    private let defaults: UserDefaults
    /// Where the instance's last answer on `available` is kept, so a field
    /// opened before the next answer already has its voice control: one that
    /// appears late lands where the field's end was, under a tap meant for it.
    private let availableKey: String
    private var checkedAt: Date?
    /// Why listening stopped in a chat the guardian left, shown on return.
    private var leftNotices: [String: VoiceInputStop] = [:]
    /// Each chat listening now, or whose notice still shows, kept on this phone
    /// so that a closed app tells why on its next launch.
    private let marks: VoiceInputMarks

    init(backend: RomeBackend, instance: String, defaults: UserDefaults = .standard) {
        self.backend = backend
        self.defaults = defaults
        availableKey = VoiceInputMarks.availablePrefix + instance
        available = defaults.bool(forKey: availableKey)
        marks = VoiceInputMarks(instance: instance, defaults: defaults)
        // The app closed while these chats listened, or before their notice went.
        for (chat, stop) in marks.takeLaunchNotices() { leftNotices[chat] = stop }
    }

    /// Asks the instance again, at most once a minute unless `now`: Rome Cloud
    /// can move voice input to another provider, so Settings asks each time.
    func refresh(now: Bool = false) async {
        if !now, let checkedAt, Date().timeIntervalSince(checkedAt) < 60 { return }
        checkedAt = Date()
        do {
            info = try await backend.voiceInputInfo()
        } catch APIError.notFound {
            // An instance older than voice input: an answer, held for the minute.
            info = nil
        } catch {
            // An instance still waking, or no network: keep what it last said, and let the
            // next field to open ask again.
            checkedAt = nil
            return
        }
        available = info?.available ?? false
        if available { defaults.set(true, forKey: availableKey) } else { defaults.removeObject(forKey: availableKey) }
    }

    func socketRequest() -> URLRequest? { backend.voiceInputSocket() }

    func keep(_ stop: VoiceInputStop, for chat: String) { leftNotices[chat] = stop }
    func takeNotice(for chat: String) -> VoiceInputStop? { leftNotices.removeValue(forKey: chat) }

    /// Listening started in `chat`.
    func listening(in chat: String) { marks.set(chat, .listening) }
    /// Listening in `chat` stopped; a stop's notice is kept until it is seen.
    func stopped(in chat: String, _ stop: VoiceInputStop?) { marks.set(chat, stop.map(VoiceInputMarks.Mark.notice)) }
    /// The guardian edited or sent in `chat`, or its notice showed long enough: it is gone.
    func noticeSeen(in chat: String) {
        leftNotices[chat] = nil
        marks.set(chat, nil)
    }
}

/// Which chats of an instance listen now, or still show a notice, in the
/// phone's defaults: the only voice input state that outlives the app. The
/// words heard live in the chat's draft, never here.
@MainActor
struct VoiceInputMarks {
    enum Mark: Equatable {
        case listening
        case notice(VoiceInputStop)
    }

    private let key: String
    private let defaults: UserDefaults

    init(instance: String, defaults: UserDefaults) {
        key = Self.prefix + instance
        self.defaults = defaults
    }

    func set(_ chat: String, _ mark: Mark?) {
        var all = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        switch mark {
        case .listening: all[chat] = Self.listening
        case .notice(let stop): all[chat] = [stop.reason.rawValue, stop.detail].compactMap(\.self).joined(separator: " ")
        case nil: all[chat] = nil
        }
        if all.isEmpty { defaults.removeObject(forKey: key) } else { defaults.set(all, forKey: key) }
    }

    /// On launch: a chat still listening says the app closed; a chat with a
    /// notice says it again. Marks stay until the notice is seen.
    func takeLaunchNotices() -> [String: VoiceInputStop] {
        let all = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        var notices: [String: VoiceInputStop] = [:]
        for (chat, value) in all {
            // A build that kept the words wrote them after the prefix.
            if value.hasPrefix(Self.listening) {
                notices[chat] = VoiceInputStop(reason: .appClosed)
                set(chat, .notice(VoiceInputStop(reason: .appClosed)))
            } else {
                let parts = value.split(separator: " ", maxSplits: 1).map(String.init)
                guard let reason = parts.first.flatMap(VoiceInputStopReason.init(rawValue:)) else { set(chat, nil); continue }
                notices[chat] = VoiceInputStop(reason: reason, detail: parts.count > 1 ? parts[1] : nil)
            }
        }
        return notices
    }

    /// Every instance's marks, and whether it offered voice input, on sign-out.
    static func removeAll(defaults: UserDefaults = .standard) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) || key.hasPrefix(availablePrefix) {
            defaults.removeObject(forKey: key)
        }
    }

    private static let prefix = "voiceInput.marks."
    /// `VoiceInputService`'s last answer on whether the instance offers voice input.
    static let availablePrefix = "voiceInput.available."
    private static let listening = "listening:"
}

/// The message field's UIKit view, so spoken text can go in the way typing does.
@MainActor
final class ComposerTextHandle {
    weak var view: PastingTextView?
    /// Where the guardian last left the cursor or selection. The view's own
    /// `selectedRange` is not that once the field has lost focus.
    var caret: NSRange?

    /// Where spoken words go in `text`: the guardian's cursor, else the end.
    func cursor(in text: String) -> NSRange {
        let length = (text as NSString).length
        guard let caret, NSMaxRange(caret) <= length else { return NSRange(location: length, length: 0) }
        return caret
    }

    /// Puts `original` back, selects `range`, and types `text` there: the
    /// field's change handler sees typed text, and one undo removes it.
    func type(_ text: String, replacing range: NSRange, in original: String) -> Bool {
        guard let view else { return false }
        view.isEditable = true
        view.text = original
        view.selectedRange = range
        view.insertText(text)
        // The next words go after these.
        caret = NSRange(location: range.location + (text as NSString).length, length: 0)
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
    /// Why listening last stopped on its own; it goes away on the next edit
    /// or send, or once it has been on screen for `VoiceNoticeTimer.lifetime`.
    private(set) var notice: VoiceInputStop?
    @ObservationIgnored private let noticeTimer: VoiceNoticeTimer
    /// The loudness of this listening, for the waveform; a new one each start.
    @ObservationIgnored private(set) var meter = VoiceLevelMeter()
    @ObservationIgnored private var dictation: VoiceDictation?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var anchor: (original: String, range: NSRange)?
    /// From the tap until the field shows it listens.
    @ObservationIgnored private var startInterval: OSSignpostIntervalState?
    /// Puts the words shown while listening into the field's text binding.
    @ObservationIgnored private let draftSync = DraftSync()
    /// Draws the words heard into the field while listening.
    @ObservationIgnored private var revealer: SpokenTextRevealer?
    /// Set by `stopAndSend`: the send waits for the last words.
    @ObservationIgnored private var sendWhenDone: (() -> Void)?

    var active: Bool { state != .idle }

    init(noticeTimer: VoiceNoticeTimer = VoiceNoticeTimer()) {
        self.noticeTimer = noticeTimer
    }

    func toggle(service: VoiceInputService, chat: String?, field: VoiceInputField, text: Binding<String>, handle: ComposerTextHandle) {
        switch state {
        case .idle: start(service: service, chat: chat, field: field, text: text, handle: handle)
        case .listening: stop()
        case .finishing: break
        }
    }

    func start(service: VoiceInputService, chat: String?, field: VoiceInputField, text: Binding<String>, handle: ComposerTextHandle) {
        guard dictation == nil, let request = service.socketRequest() else { return }
        startInterval = VoiceInputSignpost.begin(field)
        let original = text.wrappedValue
        let range = handle.cursor(in: original)
        anchor = (original, range)
        notice = nil
        noticeTimer.cancel()
        if let chat { service.listening(in: chat) }
        meter = VoiceLevelMeter()
        state = .listening
        // The screen locking would send the app to the background and end listening.
        UIApplication.shared.isIdleTimerDisabled = true
        let before = (original as NSString).substring(to: range.location)
        let after = (original as NSString).substring(from: NSMaxRange(range))
        let dictation = VoiceDictation(
            request: request,
            source: MeteredAudioSource(VoiceAudioSources.make(), meter: meter),
            handlers: .init(
                onText: { [weak self] heard in
                    let insertion = SpokenText.insertion(before: before, heard: heard, after: after)
                    self?.show(insertion, before: before, after: after, text: text, handle: handle)
                },
                onDone: { [weak self] heard, stop in
                    let said = self?.done(heard: heard, stop: stop, service: service, chat: chat, text: text, handle: handle) ?? stop
                    if let chat { service.stopped(in: chat, said) }
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

    /// Stops listening as `stop` does, then calls `send` once the last words
    /// are in the field. Listening that stops on its own, with a notice, sends
    /// nothing: the guardian reads why first. Does nothing while idle.
    func stopAndSend(_ send: @escaping () -> Void) {
        guard dictation != nil else { return }
        sendWhenDone = send
        stop()
    }

    /// The field is going away with the chat: listening stops, the words stay
    /// in the draft, and the chat says why when the guardian comes back.
    /// A notice showing waits, unseen, until the field shows again.
    func leave(service: VoiceInputService?, chat: String?) {
        noticeTimer.fieldShown(false)
        guard let dictation else { return }
        let heard = dictation.heard
        sendWhenDone = nil
        dictation.cancel()
        finishListening()
        anchor = nil
        guard let service, let chat else { return }
        let stop = VoiceInputStop(reason: .leftChat).notice(afterHearing: heard)
        if let stop { service.keep(stop, for: chat) }
        service.stopped(in: chat, stop)
    }

    /// The field opened: a chat left while listening says why.
    func arrive(service: VoiceInputService?, chat: String?) {
        noticeTimer.fieldShown(true)
        guard let service, let chat, let stop = service.takeNotice(for: chat) else { return }
        show(stop, service: service, chat: chat)
    }

    /// Call on the guardian's own edit in the field, or a send: the notice goes.
    /// Not on text the app puts there, such as a draft coming back.
    func edited(service: VoiceInputService?, chat: String?) {
        guard notice != nil, !active else { return }
        dismissNotice(service: service, chat: chat)
    }

    private func dismissNotice(service: VoiceInputService?, chat: String?) {
        notice = nil
        noticeTimer.cancel()
        if let service, let chat { service.noticeSeen(in: chat) }
    }

    /// Puts the last words in the field, and returns the notice it shows.
    @discardableResult
    private func done(heard: String, stop: VoiceInputStop?, service: VoiceInputService?, chat: String?, text: Binding<String>, handle: ComposerTextHandle) -> VoiceInputStop? {
        let send = sendWhenDone
        sendWhenDone = nil
        defer {
            // A turn later, so the field's text binding has the last words.
            if stop == nil, let send { DispatchQueue.main.async(execute: send) }
        }
        finishListening()
        guard let anchor else { return stop?.notice(afterHearing: heard) }
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
        let said = stop?.notice(afterHearing: insertion)
        if let said { show(said, service: service, chat: chat) }
        return said
    }

    private func show(_ stop: VoiceInputStop, service: VoiceInputService?, chat: String?) {
        notice = stop
        noticeTimer.start { [weak self] in self?.dismissNotice(service: service, chat: chat) }
        UIAccessibility.post(notification: .announcement, argument: stop.notice)
    }

    /// Reveals the words heard so far in the field's view, a character at a
    /// time. The binding, which redraws the whole chat screen, takes the text
    /// shown at most once a second, so that a busy screen never holds up the
    /// guardian's stop tap.
    private func show(_ insertion: String, before: String, after: String, text: Binding<String>, handle: ComposerTextHandle) {
        guard let view = handle.view else {
            text.wrappedValue = before + insertion + after
            return
        }
        let revealer = revealer ?? SpokenTextRevealer(view: view, before: before, after: after) { [weak self] words in
            self?.draftSync.offer(words, to: text)
        }
        self.revealer = revealer
        revealer.show(insertion)
    }

    private func finishListening() {
        revealer?.stop()
        revealer = nil
        draftSync.finish()
        dictation = nil
        state = .idle
        UIApplication.shared.isIdleTimerDisabled = false
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

/// Takes a notice down once it has been on screen for `lifetime`. The clock
/// runs only while the field shows and the app is active, and starts over on
/// each return, so a notice that arrives in the background (listening ended
/// as the app left) still shows when the guardian comes back, and goes soon
/// after. It never stays up for hours over a field nobody is looking at.
@MainActor
final class VoiceNoticeTimer {
    static let lifetime: Duration = .seconds(7)

    private let lifetime: Duration
    nonisolated(unsafe) private let center: NotificationCenter
    private let appActive: @MainActor () -> Bool
    private var expire: (() -> Void)?
    private var shown = true
    private var active = false
    private var countdown: Task<Void, Never>?
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []

    init(lifetime: Duration = VoiceNoticeTimer.lifetime, center: NotificationCenter = .default,
         appActive: @escaping @MainActor () -> Bool = { UIApplication.shared.applicationState == .active }) {
        self.lifetime = lifetime
        self.center = center
        self.appActive = appActive
    }

    deinit {
        for observer in observers { center.removeObserver(observer) }
    }

    /// A notice went up: `expire` takes it down.
    func start(_ expire: @escaping () -> Void) {
        self.expire = expire
        active = appActive()
        if observers.isEmpty { observe() }
        restart()
    }

    /// The notice went for another reason, such as an edit.
    func cancel() {
        expire = nil
        countdown?.cancel()
        countdown = nil
        for observer in observers { center.removeObserver(observer) }
        observers = []
    }

    /// The field left the screen, or came back, with the chat.
    func fieldShown(_ shown: Bool) {
        guard self.shown != shown else { return }
        self.shown = shown
        restart()
    }

    private func restart() {
        countdown?.cancel()
        countdown = nil
        guard expire != nil, shown, active else { return }
        countdown = Task { [weak self, lifetime] in
            try? await Task.sleep(for: lifetime)
            guard !Task.isCancelled, let self, let expire = self.expire else { return }
            self.cancel()
            expire()
        }
    }

    private func observe() {
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.active = false
                self?.restart()
            }
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.active = true
                self?.restart()
            }
        })
    }
}

/// Puts text into a binding at most once per `interval`, and always puts the
/// last text in once the interval has passed, so words that stop arriving
/// still reach the draft. The binding redraws the whole chat screen, so a busy
/// screen never holds up the guardian's stop tap.
@MainActor
final class DraftSync {
    private let interval: Duration
    private var pending: (text: String, binding: Binding<String>)?
    private var syncedAt: ContinuousClock.Instant?
    private var trailing: Task<Void, Never>?

    init(interval: Duration = .seconds(1)) {
        self.interval = interval
    }

    func offer(_ text: String, to binding: Binding<String>) {
        pending = (text, binding)
        let now = ContinuousClock.now
        guard let syncedAt, now - syncedAt < interval else { return write() }
        guard trailing == nil else { return }
        trailing = Task { [weak self, interval] in
            try? await Task.sleep(until: syncedAt + interval, clock: .continuous)
            guard !Task.isCancelled else { return }
            self?.trailing = nil
            self?.write()
        }
    }

    /// Writes what is pending now, and starts the next listening afresh.
    func finish() {
        write()
        syncedAt = nil
    }

    private func write() {
        trailing?.cancel()
        trailing = nil
        guard let pending else { return }
        self.pending = nil
        syncedAt = .now
        if pending.binding.wrappedValue != pending.text { pending.binding.wrappedValue = pending.text }
    }
}
