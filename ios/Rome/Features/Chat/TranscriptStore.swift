import UIKit
import Foundation
import Observation

/// One chat's transcript: the Concierge chat or a task chat. It loads pages,
/// sends with an optimistic bubble, follows live events, and tracks whether the
/// agent is working.
@MainActor
@Observable
final class TranscriptStore {
    enum Kind { case concierge, task }

    let sessionId: String
    let kind: Kind
    private let backend: RomeBackend

    private(set) var messages: [ChatMessage] = []
    private(set) var pending: [PendingSend] = []
    private(set) var loaded = false
    private(set) var loadError: APIError?
    private(set) var loadingOlder = false
    /// An older page fetched and waiting for the list to place it.
    private(set) var olderPage: MessagePage?
    /// An older page is going in above the rows.
    private(set) var placingOlder = false
    private(set) var hasOlder = false
    /// The chat is running a turn.
    private(set) var running = false
    /// The running turn is one the guardian should see as typing (not a quiet background turn).
    private(set) var visibleTurn = false
    private(set) var activeTurnId: String?
    private(set) var stopping = false
    /// The guardian stopped the last turn. Cleared when a new turn starts.
    private(set) var stopped = false
    /// Bumps when a new message arrives, so the view can scroll or count it.
    private(set) var arrivals = 0

    /// Approval records fetched from the server, by approval id.
    private(set) var approvals: [String: ApprovalRecord] = [:]
    private(set) var resolvingApproval: [String: Bool] = [:]
    private(set) var approvalErrors: [String: String] = [:]
    /// Answers sent this session, before the server echoes them.
    private(set) var localAnswers: [String: JSONValue] = [:]
    private(set) var answering: Set<String> = []
    /// Each connect card's state, by row, kept while the card scrolls away.
    private(set) var connectPhases: [String: ConnectPhase] = [:]
    @ObservationIgnored private var connectRuns: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private lazy var connectBrowser = WebSignInBrowser()
    /// The instance's routines, for routine cards; nil until read, or when
    /// they cannot be read (a visitor, an error), which leaves the status out.
    private(set) var routines: [RoutineRef]?
    @ObservationIgnored private var routinesRead: (at: Date, task: Task<Void, Never>)?
    /// Tool calls fetched for an expanded tool summary, by trace message id.
    private(set) var toolCalls: [String: [ToolCall]] = [:]

    private var cursor: String?
    /// The order each message id was first received in.
    private var seen: [String: Int] = [:]
    private var tokens: [UUID] = []
    private var approvalPolls: [String: Task<Void, Never>] = [:]
    /// Where a send is kept until the server takes it.
    var drafts: ChatDrafts?
    /// Where the newest messages are kept across launches: the main Chat and
    /// topic chats only.
    var cache: TranscriptCache?
    /// The rows came from `cache`: the first fetch sets the paging and
    /// replaces what it covers.
    private var fromCache = false
    private var resyncWork: Task<Void, Never>?
    private var resyncAgain = false

    init(sessionId: String, kind: Kind, backend: RomeBackend) {
        self.sessionId = sessionId
        self.kind = kind
        self.backend = backend
    }

    /// Answers given to cards: stored ones, then those sent this session.
    var answers: [String: JSONValue] {
        var answers = TranscriptBuilder.answers(in: messages)
        answers.merge(localAnswers) { stored, _ in stored }
        return answers
    }

    var rows: [TranscriptRow] {
        let answers = answers
        return TranscriptBuilder.rows(
            messages: messages,
            pending: pending,
            answers: answers,
            options: .init(showTools: kind == .task, showThreads: kind == .concierge, typing: kind == .concierge && running && visibleTurn)
        )
    }

    /// The first message the guardian wrote, which for a task chat is the brief
    /// from Concierge. Unknown until the oldest page is held.
    var brief: ChatMessage? {
        guard !hasOlder else { return nil }
        return messages.first { $0.isUser && $0.parts.contains { $0.textContent != nil } }
    }

    // MARK: Loading

    func start() {
        guard tokens.isEmpty else { return }
        tokens.append(backend.events.subscribe(LiveTopic.chat(sessionId)) { [weak self] event in
            self?.handle(event)
        })
        tokens.append(backend.events.subscribe(LiveTopic.chatStatus) { [weak self] event in
            self?.handle(event)
        })
        Task { await reload() }
    }

    /// A chat made just now holds nothing yet: it counts as loaded at once,
    /// so its first message shows in the list instead of behind a spinner
    /// while the first fetch runs.
    func beginEmpty() {
        guard !loaded else { return }
        loaded = true
        hasOlder = false
    }

    /// Shows the rows kept from last time, before anything is fetched. The
    /// first fetch merges into them by id, so nothing moves that is still there.
    func showCached() {
        guard !loaded, messages.isEmpty, let kept = cache?.messages(chat: sessionId) else { return }
        merge(kept, persist: false)
        loaded = true
        hasOlder = false
        fromCache = true
    }

    func stop() {
        for token in tokens { backend.events.unsubscribe(token) }
        tokens = []
        for poll in approvalPolls.values { poll.cancel() }
        approvalPolls = [:]
    }

    func reload() async {
        do {
            let page = try await backend.messages(sessionId: sessionId, before: nil, limit: 40)
            // A newest page that shares nothing with what is held leaves a gap
            // behind it: start over from it. Otherwise keep the pages already
            // loaded, so a reload never puts the older-page spinner back on top.
            let known = Set(messages.map(\.id))
            let wasLoaded = loaded
            let gap = !messages.isEmpty && page.nextCursor != nil && !page.messages.contains { known.contains($0.id) }
            if gap {
                messages = []
                seen = [:]
                olderPage = nil
            } else if fromCache {
                pruneCached(against: page)
            }
            merge(page.messages)
            // Replies a refetch brings count like live ones: the list marks
            // the back-to-bottom button for a guardian reading further up.
            if wasLoaded, page.messages.contains(where: { !known.contains($0.id) && !$0.isUser && !$0.isTrace }) {
                arrivals += 1
            }
            if !loaded || gap || fromCache {
                cursor = page.nextCursor
                hasOlder = page.nextCursor != nil
                fromCache = false
            }
            loaded = true
            loadError = nil
            await refreshRunning()
        } catch let error as APIError {
            loadError = error
            loaded = true
        } catch {}
    }

    /// The server wins: a kept row the page should hold but does not was
    /// deleted. Kept rows older than the page stay until the older page,
    /// fetched from the page's cursor, brings them again.
    private func pruneCached(against page: MessagePage) {
        let fresh = Set(page.messages.map(\.id))
        let oldest = page.messages.map(\.date).min()
        messages.removeAll { message in
            guard !fresh.contains(message.id) else { return false }
            guard page.nextCursor != nil, let oldest else { return true }
            return message.date >= oldest
        }
    }

    /// Fetches the newest page without touching paging state.
    func refreshLatest() async {
        if let page = try? await backend.messages(sessionId: sessionId, before: nil, limit: 20) {
            merge(page.messages)
        }
    }

    /// Fetches the page before the oldest message held. It waits in
    /// `olderPage` until the list places it with `placeOlderPage()`.
    func loadOlder() async {
        guard hasOlder, !loadingOlder, olderPage == nil, let cursor else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        let page = try? await backend.messages(sessionId: sessionId, before: cursor, limit: 40)
        // A reload that found a gap started the history over while this ran;
        // a page from the old cursor would leave a hole in it.
        guard self.cursor == cursor else { return }
        olderPage = page
    }

    /// Puts the fetched older page above the rows. The list calls it when the
    /// scroll is at rest: a page placed under a moving finger pushes the rows
    /// in view down.
    func placeOlderPage() async {
        guard let page = olderPage else { return }
        olderPage = nil
        placingOlder = true
        merge(page.messages)
        cursor = page.nextCursor
        hasOlder = page.nextCursor != nil
        // The list keeps the rows in view still while this is set; hold it
        // through the layout that places the page above them.
        try? await Task.sleep(for: .milliseconds(150))
        placingOlder = false
    }

    func markRead() {
        Task { await backend.markRead(sessionId: sessionId) }
    }

    /// Whether the guardian sees this chat now. The main Chat stays mounted,
    /// hidden, under the other pages, so being mounted is not being seen:
    /// its replies count as read only while it shows, and once it shows again.
    var onScreen = false {
        didSet { if onScreen, !oldValue { markRead() } }
    }

    /// New replies came in, or the list appeared: read, if the chat shows.
    func arrived() {
        if onScreen { markRead() }
    }

    /// Keeps the server's order: a turn's rows stay together, turns ordered by
    /// when they started, rows in a turn by time. Times are whole seconds, so
    /// rows and turns that tie within a second keep the order they first
    /// arrived in; the order never changes when the same rows arrive again.
    private func merge(_ incoming: [ChatMessage], persist: Bool = true) {
        var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in incoming {
            byID[message.id] = message
            if seen[message.id] == nil {
                seen[message.id] = seen.count
            }
        }
        let all = Array(byID.values)
        var turnStart: [String: Date] = [:]
        var turnArrival: [String: Int] = [:]
        for message in all {
            let key = message.turnId ?? message.id
            turnStart[key] = min(turnStart[key] ?? message.date, message.date)
            turnArrival[key] = min(turnArrival[key] ?? Int.max, seen[message.id]!)
        }
        messages = all.sorted { a, b in
            let keyA = a.turnId ?? a.id, keyB = b.turnId ?? b.id
            let startA = turnStart[keyA]!, startB = turnStart[keyB]!
            if startA != startB { return startA < startB }
            // Ids are random, so comparing them would decide a tie by chance.
            if keyA != keyB { return turnArrival[keyA]! < turnArrival[keyB]! }
            if a.date != b.date { return a.date < b.date }
            return seen[a.id]! < seen[b.id]!
        }
        let stored = Set(messages.map(\.id))
        pending.removeAll { stored.contains($0.id) }
        if persist { cache?.save(chat: sessionId, messages: messages) }
    }

    // MARK: Live events

    private func handle(_ event: LiveEvent) {
        switch event {
        case .messageInsert(let message) where message.sessionId == sessionId:
            let isNew = !messages.contains { $0.id == message.id }
            merge([message])
            if isNew, !message.isUser, !message.isTrace { arrivals += 1 }
        case .sessionRunning(let id, let isRunning) where id == sessionId:
            if isRunning != running || isRunning {
                Task { await refreshRunning(hint: isRunning) }
            }
            if !isRunning {
                // The turn's trace summary and reply are final now.
                Task { await reload() }
            }
        case .messageThread(let id, let messageId, let root) where id == sessionId:
            if let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].chatThreadId = root
                messages[index].knowsThreads = true
            }
        case .reconnected:
            resync()
        default:
            break
        }
    }

    // MARK: Chat threads

    /// The chat thread shown over the chat, if one is open.
    private(set) var thread: ThreadStore?

    /// Opens the chat thread a stored message is in, over the chat.
    func openThread(at messageId: String) {
        guard kind == .concierge, let anchor = messages.first(where: { $0.id == messageId }) else { return }
        thread?.stop()
        let opened = ThreadStore(anchor: anchor, chat: self, backend: backend)
        thread = opened
        opened.start()
    }

    func closeThread() {
        thread?.stop()
        thread = nil
    }

    /// The messages held for this chat that are in `root`'s thread.
    func messages(inThread root: String) -> [ChatMessage] {
        messages.filter { !$0.isTrace && ($0.chatThreadId == root || $0.id == root) }
    }

    /// A stored message, by id.
    func message(_ id: String) -> ChatMessage? {
        messages.first { $0.id == id }
    }

    /// Reloads after events may have been missed. A burst of requests (one per
    /// topic, a resume and a push tap) shares one reload, plus one more for
    /// requests that came while it ran.
    func resync() {
        guard resyncWork == nil else {
            resyncAgain = true
            return
        }
        resyncWork = Task {
            await Task.yield()
            repeat {
                resyncAgain = false
                await reload()
            } while resyncAgain
            resyncWork = nil
        }
    }

    private func refreshRunning(hint: Bool? = nil) async {
        if hint == false {
            markIdle()
            return
        }
        guard let turns = try? await backend.activeTurns(sessionId: sessionId) else {
            if let hint { running = hint }
            return
        }
        guard !turns.isEmpty else {
            markIdle()
            return
        }
        markRunning()
        visibleTurn = turns.contains { $0.quiet != true }
        activeTurnId = turns.first { $0.status == "running" }?.turnId ?? turns.first?.turnId
    }

    private func markRunning() {
        running = true
        stopped = false
    }

    private func markIdle() {
        if stopping { stopped = true }
        running = false
        visibleTurn = false
        activeTurnId = nil
        stopping = false
    }

    // MARK: Sending

    @discardableResult
    /// Sends the guardian's text with any photos (JPEG). Photos alone are a
    /// message too. `fromComposer`: the composer's content, cleared as it goes.
    func send(_ text: String, images: [ComposerImage] = [], fromComposer: Bool = false, thread: ThreadTarget? = nil) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else { return false }
        let inputId = UUID().uuidString.lowercased()
        pending.append(PendingSend(id: inputId, text: trimmed, images: images, createdAt: .now, state: .sending, thread: thread))
        if kind == .concierge {
            markRunning()
            visibleTurn = true
        }
        deliver(inputId: inputId, text: trimmed, images: images, fromComposer: fromComposer, thread: thread)
        return true
    }

    func retry(_ id: String) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].state = .sending
        deliver(inputId: id, text: pending[index].text, images: pending[index].images, thread: pending[index].thread)
    }

    private func deliver(inputId: String, text: String, images: [ComposerImage], fromComposer: Bool = false, thread: ThreadTarget? = nil) {
        // Kept as the chat's draft until the server takes it.
        if let drafts { drafts.store.sending(chat: drafts.chat, inputId: inputId, text: text, photos: images, fromComposer: fromComposer) }
        Task {
            do {
                let turn = try await backend.send(
                    sessionId: sessionId,
                    text: text,
                    files: OutgoingFile.photos(images),
                    inputId: inputId,
                    priority: kind == .concierge ? .now : .next,
                    thread: thread
                )
                if let index = pending.firstIndex(where: { $0.id == inputId }) {
                    pending[index].state = .sent
                }
                if let drafts { drafts.store.delivered(chat: drafts.chat, inputId: inputId) }
                // The server does not announce the guardian's own input, so fetch it.
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    await self.refreshLatest()
                }
                if kind == .task {
                    markRunning()
                    if let turnId = turn.turnId { activeTurnId = turnId }
                }
            } catch {
                if let index = pending.firstIndex(where: { $0.id == inputId }) {
                    pending[index].state = .failed
                }
                if kind == .concierge { await refreshRunning() }
            }
        }
    }

    func stopTurn() {
        guard let turnId = activeTurnId, !stopping else { return }
        stopping = true
        Task {
            do {
                try await backend.interrupt(turnId: turnId)
            } catch {
                stopping = false
                return
            }
            // The socket usually announces that the turn ended. When that event
            // never comes, the active turns tell, so Stop never leaves the chat
            // looking busy.
            for delay in [0.5, 1.0, 2.0, 4.0] {
                try? await Task.sleep(for: .seconds(delay))
                guard stopping else { return }
                await refreshRunning()
                if !running {
                    await reload()
                    return
                }
            }
            // Still running: let the guardian try again.
            stopping = false
        }
    }

    // MARK: Routines

    func routineStatus(_ part: MessagePart.RoutineDraftPart) -> RoutineStatus? {
        routines.map { RoutineStatus.find(part, in: $0) }
    }

    /// Reads the routines for the cards on screen. Cards that appear together
    /// share one read, and a card seen again a few seconds later reads them
    /// again, so a routine turned on in the dashboard shows as on.
    func loadRoutines() async {
        if let read = routinesRead, Date.now.timeIntervalSince(read.at) < 5 {
            await read.task.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                self.routines = try await self.backend.routines()
            } catch {
                // A failed read keeps what was read before; with nothing, the line stays out.
            }
        }
        routinesRead = (.now, task)
        await task.value
    }

    // MARK: Approvals

    func approvalStatus(_ part: MessagePart.ApprovalPart) -> ApprovalStatus {
        ApprovalStatus.derive(stored: part.storedStatus, record: approvals[part.approvalId])
    }

    /// Fetches an approval's record and keeps polling while it waits or runs.
    func watchApproval(_ id: String) {
        guard approvalPolls[id] == nil else { return }
        approvalPolls[id] = Task { [weak self] in
            var delay = 3.0
            while !Task.isCancelled {
                guard let self else { return }
                if let record = try? await self.backend.approval(id: id) {
                    self.approvals[id] = record
                    let status = ApprovalStatus.derive(stored: nil, record: record)
                    if status == .executed || status == .rejected || status == .failed { break }
                    delay = 3
                } else {
                    delay = min(delay * 2, 60)
                }
                try? await Task.sleep(for: .seconds(delay))
            }
            // A cancelled poll may already have a replacement; leave its entry alone.
            if !Task.isCancelled { self?.approvalPolls[id] = nil }
        }
    }

    func resolve(_ id: String, approve: Bool) {
        guard resolvingApproval[id] == nil else { return }
        resolvingApproval[id] = approve
        approvalErrors[id] = nil
        Task {
            do {
                try await backend.resolveApproval(id: id, approve: approve)
                if let record = try? await backend.approval(id: id) { approvals[id] = record }
                approvalPolls[id]?.cancel()
                approvalPolls[id] = nil
                watchApproval(id)
            } catch {
                approvalErrors[id] = String(localized: "Could not submit")
            }
            resolvingApproval[id] = nil
        }
    }

    // MARK: Questions

    /// `sessionId`: the question's own chat, this one unless it says otherwise.
    func answer(_ part: MessagePart.QuestionPart, answers: [JSONValue], sessionId: String? = nil) {
        // An empty list is an answer too: a card of only optional questions left blank.
        guard !answering.contains(part.toolUseId) else { return }
        let output: JSONValue = .object(["answers": .array(answers)])
        answering.insert(part.toolUseId)
        localAnswers[part.toolUseId] = output
        Task {
            do {
                try await backend.answer(sessionId: sessionId ?? self.sessionId, toolUseId: part.toolUseId, output: output)
                markRunning()
            } catch {
                localAnswers[part.toolUseId] = nil
            }
            answering.remove(part.toolUseId)
        }
    }

    // MARK: Connect cards

    #if DEBUG
    /// Snapshot runs show each card state at once, by service.
    nonisolated(unsafe) static var previewPhases: [String: ConnectPhase] = [:]
    static func previewPhase(_ service: String) -> ConnectPhase? { previewPhases[service] }
    #else
    static func previewPhase(_ service: String) -> ConnectPhase? { nil }
    #endif

    /// A card for a service that already works shows Connected when it opens,
    /// and tells nobody: an old card must not wake Chat again.
    func checkConnected(_ part: MessagePart.ConnectCardPart, rowId: String) async {
        guard connectPhases[rowId] == nil || connectPhases[rowId] == .idle else { return }
        guard let list = try? await backend.connectors(),
              let entry = list.first(where: { $0.service == part.service }), entry.working,
              connectPhases[rowId] == nil || connectPhases[rowId] == .idle
        else { return }
        connectPhases[rowId] = .connected(account: entry.account)
    }

    /// The card's button: connects the service on this phone, then tells Chat.
    func connect(_ part: MessagePart.ConnectCardPart, rowId: String, chatId: String) {
        connectRuns[rowId]?.cancel()
        connectPhases[rowId] = .connecting
        let backend = backend
        let runner = ConnectRunner(
            backend: backend,
            browser: connectBrowser,
            openDashboard: { url in UIApplication.shared.open(url) },
            origin: backend.origin
        )
        connectRuns[rowId] = Task { [weak self] in
            let phase = await runner.run(service: part.service, chatId: chatId)
            guard !Task.isCancelled else { return }
            self?.connectPhases[rowId] = phase
            self?.connectRuns[rowId] = nil
        }
    }

    // MARK: Tools

    func loadToolCalls(_ traceMessageId: String) {
        guard toolCalls[traceMessageId] == nil else { return }
        Task {
            if let calls = try? await backend.toolCalls(traceMessageId: traceMessageId) {
                toolCalls[traceMessageId] = calls
            } else {
                toolCalls[traceMessageId] = []
            }
        }
    }
}
