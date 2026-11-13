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
    /// A load the guardian started (Retry, or coming back to the chat) is on its way.
    private(set) var retrying = false
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
    /// The turns the instance listed as running or queued at the last look.
    private(set) var activeTurns: [ActiveTurn] = []
    /// How often a chat showing its dots asks the instance whether its turn
    /// is over, in case the live event that says so never comes. The web's
    /// `TURN_POLL_FALLBACK_MS`.
    @ObservationIgnored var runningPollInterval: Duration = .seconds(30)
    @ObservationIgnored private var runningPoll: Task<Void, Never>?
    /// `stop()` ran and `start()` has not since: no poll starts.
    @ObservationIgnored private var closed = false
    private(set) var activeTurnId: String?
    private(set) var stopping = false
    /// The guardian stopped the last turn. Cleared when a new turn starts.
    private(set) var stopped = false
    /// Bumps when a new message arrives, so the view can scroll or count it.
    private(set) var arrivals = 0
    /// A short line about an action that failed (Stop, an answer), shown for a few seconds.
    private(set) var notice: String?
    @ObservationIgnored private var noticeWork: Task<Void, Never>?

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

    /// Thread placements (`message_chat_thread`) of messages not held yet, by message id.
    private var parkedPlacements: [String: (root: String?, title: String?)] = [:]
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
    /// How many messages a page holds, the newest page included.
    static let pageSize = 40
    private var resyncWork: Task<Void, Never>?
    private var resyncAgain = false

    /// Share mode and the chat's share links.
    let share: ChatShareFlow

    init(sessionId: String, kind: Kind, backend: RomeBackend) {
        self.sessionId = sessionId
        self.kind = kind
        self.backend = backend
        share = ChatShareFlow(backend: backend)
        share.chat = self
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
            messages: visibleMessages,
            pending: pending,
            answers: answers,
            options: .init(showTools: kind == .task, showThreads: kind == .concierge, showNotices: kind == .concierge, typing: showsTyping)
        )
    }

    /// Whether the Chat shows its typing dots, by the web's rule: a turn that
    /// took the guardian's message shows none (its status mark says it is on
    /// it), and any other visible turn shows them only until it has said
    /// something.
    var showsTyping: Bool {
        guard kind == .concierge, running, visibleTurn else { return false }
        // A send the instance has not stored yet is the input of the turn.
        if pending.contains(where: { if case .failed = $0.state { return false } else { return true } }) { return false }
        let visible = activeTurns.filter { $0.quiet != true }
        guard let turn = visible.first(where: { $0.status == "running" }) ?? visible.first else { return false }
        let ids = Set([turn.turnId, turn.agentTurnId].compactMap { $0 })
        if messages.contains(where: { $0.isUser && $0.turnId.map(ids.contains) == true }) { return false }
        return !messages.contains { message in
            guard let id = message.turnId, ids.contains(id) else { return false }
            return TranscriptBuilder.isReply(message, parts: message.parts)
        }
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
        closed = false
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
        closed = true
        runningPoll?.cancel()
        runningPoll = nil
        resyncWork?.cancel()
        resyncWork = nil
    }

    func reload() async {
        do {
            let page = try await backend.messages(sessionId: sessionId, before: nil, limit: Self.pageSize)
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
            if reopening != nil { await resolveReopening() }
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
    @discardableResult
    func refreshLatest() async -> Bool {
        guard let page = try? await backend.messages(sessionId: sessionId, before: nil, limit: 20) else { return false }
        merge(page.messages)
        loadError = nil
        return true
    }

    /// Fetches the page before the oldest message held. It waits in
    /// `olderPage` until the list places it with `placeOlderPage()`.
    func loadOlder() async {
        guard hasOlder, !loadingOlder, olderPage == nil, let cursor else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        let page = try? await backend.messages(sessionId: sessionId, before: cursor, limit: Self.pageSize)
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
        for var message in incoming {
            if message.knowsThreads {
                instanceKnowsThreads = true
            } else if let held = byID[message.id], held.knowsThreads {
                // A live insert leaves the thread out: keep the one already known.
                message.chatThreadId = held.chatThreadId
                message.chatThreadTitle = held.chatThreadTitle
                message.knowsThreads = true
            }
            // A copy that leaves the title out keeps the one already known, and a
            // message of a thread takes its title from the thread.
            if message.chatThreadTitle == nil, let root = message.chatThreadId {
                if let held = byID[message.id], held.chatThreadId == root, let title = held.chatThreadTitle {
                    message.chatThreadTitle = title
                } else {
                    message.chatThreadTitle = byID.values.first { $0.chatThreadId == root && $0.chatThreadTitle != nil }?.chatThreadTitle
                }
            }
            // A placement that came before its message lands with it.
            if let placed = parkedPlacements.removeValue(forKey: message.id) {
                message.chatThreadId = placed.root
                message.chatThreadTitle = placed.title
                message.knowsThreads = true
            }
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
        case .messageInsert(var message) where message.sessionId == sessionId:
            let held = messages.first { $0.id == message.id }
            let isNew = held == nil
            // A live insert leaves the mark out: keep the one already known.
            if message.statusReaction == nil { message.statusReaction = held?.statusReaction }
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
        case .statusReaction(let id, let messageId, let reaction) where id == sessionId:
            if let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].statusReaction = reaction
            }
        case .messageThread(let id, let messageId, let root, let title) where id == sessionId:
            if let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].chatThreadId = root
                messages[index].chatThreadTitle = title
                messages[index].knowsThreads = true
            } else {
                parkedPlacements[messageId] = (root, title)
            }
        case .cardSettled(let id, let card) where id == sessionId:
            settle(card)
        case .threadRetired(let id, let root) where id == sessionId:
            // Its task left the chat: the thread's messages lose their label.
            for index in messages.indices where messages[index].chatThreadId == root {
                messages[index].chatThreadId = nil
                messages[index].chatThreadTitle = nil
            }
        case .reconnected:
            resync()
        default:
            break
        }
    }

    /// Puts a settled card in place of the card of every part that shows it.
    func settle(_ card: JSONValue) {
        for index in messages.indices {
            if let content = TaskAskCard.settling(content: messages[index].content, with: card) {
                messages[index].content = content
            }
        }
        thread?.settle(card)
    }

    /// Shows an answer or a decision the instance took before it announces
    /// it: the cards that show `id` take `outcome`.
    private func settle(kind: String, id: String, outcome: JSONValue) {
        for index in messages.indices {
            if let content = TaskAskCard.settling(content: messages[index].content, kind: kind, id: id, outcome: outcome) {
                messages[index].content = content
            }
        }
    }

    // MARK: Chat threads

    /// The chat thread shown over the chat, if one is open.
    private(set) var thread: ThreadStore?
    /// The instance has chat threads: a read showed `chatThreadId`, on any
    /// message. Live inserts leave the field out, so one message cannot tell.
    private(set) var instanceKnowsThreads = false
    /// A thread a restored draft was written in, being looked up because its
    /// message is not in the pages held.
    private(set) var reopening: ThreadTarget?

    /// The message the guardian replies to, quoted in the reply bar above
    /// the composer. Reply opens only the bar; inside an open thread view
    /// the view stays open (docs/domains/chats.md#chat-thread).
    private(set) var quote: ThreadTarget?
    /// A message shown tinted: the one a thread view opened from, or the
    /// original a quote led to.
    private(set) var tinted: String?
    /// Goes up when the transcript should bring `jumpTarget` into view.
    private(set) var jumps = 0
    private(set) var jumpTarget: String?
    @ObservationIgnored private var untint: Task<Void, Never>?

    /// Where the composer sends, and what its draft keeps: the reply, or a
    /// thread still being looked up.
    var composerThread: ThreadTarget? { quote ?? reopening }

    /// The reply bar shows for a reply to a message, not for a thread opened from its label.
    var showsQuoteBar: Bool { quote != nil && quote?.bare != true }

    /// The quoted message, when it is held.
    var quotedMessage: ChatMessage? {
        quote.flatMap { message($0.messageId) ?? thread?.messages.first { [id = $0.messageId] in $0.id == id } }
    }

    /// The title of the task whose chat thread `message` is in, or nil when
    /// it is in no task's thread.
    func taskThreadTitle(of message: ChatMessage) -> String? {
        guard let root = message.chatThreadId else { return nil }
        if let title = message.chatThreadTitle { return title }
        return messages.first { $0.chatThreadId == root && $0.chatThreadTitle != nil }?.chatThreadTitle
    }

    /// Reply on a message: the reply bar quotes it. An open thread view
    /// stays open, and the send goes into its thread.
    func reply(to messageId: String) {
        guard kind == .concierge, message(messageId) != nil || thread != nil else { return }
        quote = ThreadTarget(messageId: messageId, instanceKnowsThreads: true, quote: true, thread: thread?.anchor.id)
        replies += 1
    }

    /// Goes up on each Reply: the composer takes the keyboard.
    private(set) var replies = 0

    /// The reply bar's ✕: the reply goes, and an open thread view with it.
    func cancelQuote() {
        closeThread()
    }

    /// Opens the thread view of the task thread `messageId` is in, from its
    /// label: the message is tinted, and a send replies to it.
    func openThread(at messageId: String) {
        guard kind == .concierge, let anchor = messages.first(where: { $0.id == messageId }) else { return }
        open(anchor: anchor, older: [], replyTo: messageId, bare: true)
    }

    /// The quote in a reply was tapped. A reply in a task's thread opens
    /// that thread's view, replying to the original; any other goes to the
    /// original in the chat and tints it. Nil when the quote leads nowhere.
    func quoteAction(reply replyId: String, original: String) -> (() -> Void)? {
        guard kind == .concierge else { return nil }
        if let host = message(replyId), taskThreadTitle(of: host) != nil {
            return { [weak self] in self?.open(anchor: host, older: [], replyTo: original, tint: original) }
        }
        guard message(original) != nil else { return nil }
        return { [weak self] in self?.jump(to: original) }
    }

    /// Brings the message with a task's card into view and tints it. One not
    /// held yet comes in one read that reaches down to it; one not found
    /// says so briefly.
    func revealCard(_ messageId: String) async {
        if message(messageId) == nil,
           let page = try? await backend.messages(sessionId: sessionId, through: messageId, limit: Self.pageSize) {
            // From the newest down past the card, so no gap opens above what is held.
            merge(page.messages)
            if message(messageId) != nil {
                cursor = page.nextCursor
                hasOlder = page.nextCursor != nil
            }
        }
        guard message(messageId) != nil else {
            say(String(localized: "Could not find the card"))
            return
        }
        jump(to: messageId)
    }

    /// Brings a held message into view and tints it for a moment.
    func jump(to messageId: String) {
        jumpTarget = messageId
        jumps += 1
        tint(messageId, for: .seconds(2))
    }

    private func tint(_ messageId: String?, for duration: Duration? = nil) {
        untint?.cancel()
        tinted = messageId
        guard let duration, messageId != nil else { return }
        untint = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled else { return }
            self?.tinted = nil
        }
    }

    private func open(anchor: ChatMessage, older: [ChatMessage], replyTo: String? = nil, tint target: String? = nil, bare: Bool = false) {
        thread?.stop()
        reopening = nil
        let opened = ThreadStore(anchor: anchor, chat: self, backend: backend, older: older)
        thread = opened
        quote = ThreadTarget(messageId: replyTo ?? anchor.id, instanceKnowsThreads: true, quote: true, thread: anchor.id, bare: bare ? true : nil)
        tint(target ?? anchor.id)
        opened.start()
    }

    /// Takes the open thread off the screen and nothing else: a reply or a
    /// thread being looked up stays, for share mode to hand back.
    func hideThread() {
        thread?.stop()
        thread = nil
        untint?.cancel()
        tinted = nil
    }

    /// Closes the open thread view and the reply bar: both end with a send.
    /// The tint stays a moment, so the guardian sees where they were.
    func closeThread() {
        thread?.stop()
        thread = nil
        reopening = nil
        quote = nil
        if tinted != nil { tint(tinted, for: .seconds(1.5)) }
    }

    /// A restored draft was written as a reply: the reply bar comes back,
    /// and so does the thread view it was written in. A thread view whose
    /// message is older than the pages held is looked up; only one the
    /// server no longer has leaves the text to the chat.
    func reopenThread(_ target: ThreadTarget) {
        guard kind == .concierge, thread == nil else { return }
        // A draft from before quotes was written in a thread view. With no task's
        // thread under its message there is none to open: it is a plain reply.
        if target.quote == nil, let held = message(target.messageId), taskThreadTitle(of: held) == nil {
            quote = ThreadTarget(messageId: target.messageId, instanceKnowsThreads: true, quote: true)
            return
        }
        guard let root = target.threadMessage else {
            quote = target
            return
        }
        if let anchor = message(root) {
            open(anchor: anchor, older: [], replyTo: target.messageId, bare: target.bare == true)
            return
        }
        reopening = target
        Task { await resolveReopening() }
    }

    /// Looks up the thread a draft waits on. Unreachable now, it keeps
    /// waiting, and the next reload asks again.
    func resolveReopening() async {
        guard let target = reopening, thread == nil else { return }
        do {
            let root = target.threadMessage ?? target.messageId
            let found = try await backend.thread(sessionId: sessionId, messageId: root)
            guard reopening == target, thread == nil else { return }
            guard let anchor = found.first(where: { $0.id == root }) ?? found.last else {
                reopening = nil
                return
            }
            open(anchor: anchor, older: found, replyTo: target.messageId, bare: target.bare == true)
        } catch APIError.notFound {
            if reopening == target { reopening = nil }
        } catch {}
    }

    /// The messages held for this chat that are in `root`'s thread.
    func messages(inThread root: String) -> [ChatMessage] {
        messages.filter { !$0.isTrace && ($0.chatThreadId == root || $0.id == root) }
    }


    /// The stored messages drawn: a message sent again gives way to its new
    /// copy, both while the copy is on its way and once it is stored.
    var visibleMessages: [ChatMessage] {
        let hidden = TranscriptBuilder.resent(in: messages).union(replaced.values)
        return hidden.isEmpty ? messages : messages.filter { !hidden.contains($0.id) }
    }

    /// A stored message, by id.
    func message(_ id: String) -> ChatMessage? {
        messages.first { $0.id == id }
    }

    /// Card states a re-read was asked for already (`TaskAskView`).
    @ObservationIgnored private var recoveredCards: Set<String> = []

    /// A card stopped waiting with no outcome held: `chat_card_settled` may
    /// have been missed, so the page is read again, once per card state, however
    /// often the card scrolls back into view.
    func recoverCard(_ key: String) {
        guard recoveredCards.insert(key).inserted else { return }
        resync()
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

    /// `onFailure`: what to believe when the server cannot be asked.
    private func refreshRunning(hint: Bool? = nil, onFailure: Bool? = nil) async {
        if hint == false {
            markIdle()
            return
        }
        guard let turns = try? await backend.activeTurns(sessionId: sessionId) else {
            if let hint { running = hint }
            else if onFailure == false { markIdle() }
            return
        }
        guard !turns.isEmpty else {
            markIdle()
            return
        }
        markRunning()
        activeTurns = turns
        visibleTurn = turns.contains { $0.quiet != true }
        activeTurnId = turns.first { $0.status == "running" }?.turnId ?? turns.first?.turnId
    }

    private func markRunning() {
        running = true
        stopped = false
        startRunningPoll()
    }

    /// Tries the failed load again, visibly: the banner goes, "Retrying…"
    /// shows, and the banner returns only if this attempt fails too.
    func retryLoad() {
        loadError = nil
        retrying = true
        Task {
            resync()
            await resyncWork?.value
            retrying = false
        }
    }

    /// The chat is in front again, or entered: a load that failed before is
    /// tried at once and visibly; otherwise only the running turn is looked at.
    func chatShown() {
        if loadFailed { retryLoad() } else { recheckRunning() }
    }

    /// The chat came back to the screen: asks once whether its turn still runs.
    func recheckRunning() {
        guard kind == .concierge, running else { return }
        Task { await refreshRunning() }
    }

    /// While the dots show, asks the instance now and then whether the turn
    /// still runs, so a live event that never arrives cannot leave them on.
    /// The poll ends with the running state.
    private func startRunningPoll() {
        guard kind == .concierge, !closed, runningPoll == nil else { return }
        runningPoll = Task { [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.runningPollInterval else { return }
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self, self.running else { return }
                if self.showsTyping { await self.refreshRunning() }
            }
        }
    }

    private func markIdle() {
        if stopping { stopped = true }
        running = false
        visibleTurn = false
        activeTurns = []
        runningPoll?.cancel()
        runningPoll = nil
        activeTurnId = nil
        stopping = false
    }

    // MARK: Sending

    @discardableResult
    /// Sends the guardian's text with any photos (JPEG). Photos alone are a
    /// message too. `fromComposer`: the composer's content, cleared as it goes.
    func send(_ text: String, images: [ComposerImage] = [], fromComposer: Bool = false, thread: ThreadTarget? = nil) -> Bool {
        send(text, images: images, files: [], fromComposer: fromComposer, thread: thread) != nil
    }

    /// The send's `inputId`, or nil when there is nothing to send. `files`:
    /// anything other than photos, which only a resend carries.
    private func send(_ text: String, images: [ComposerImage], files: [OutgoingFile], fromComposer: Bool = false, thread: ThreadTarget?) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty || !files.isEmpty else { return nil }
        let inputId = UUID().uuidString.lowercased()
        pending.append(PendingSend(id: inputId, text: trimmed, images: images, files: files, createdAt: .now, state: .sending, thread: thread))
        if kind == .concierge {
            markRunning()
        }
        deliver(inputId: inputId, text: trimmed, images: images, files: files, fromComposer: fromComposer, thread: thread)
        return inputId
    }

    /// Removes a send that failed for good, and the draft kept for it. A
    /// stored message it was sent in place of shows again.
    func removePending(_ id: String) {
        pending.removeAll { $0.id == id }
        replaced[id] = nil
        if let drafts { drafts.store.delivered(chat: drafts.chat, inputId: id) }
    }

    /// Stored messages a send the app still holds took the place of (a retry
    /// of a message the instance did not take), by that send's id. Once the
    /// new copy is stored, `TranscriptBuilder.resent` hides the old one, so
    /// it stays hidden after a relaunch.
    private(set) var replaced: [String: String] = [:]
    /// Stored messages whose files are being read back for a resend.
    private var resending: Set<String> = []

    /// Whether the row is a send the app still holds, which only it can drop.
    func isPending(_ rowId: String) -> Bool { pending.contains { $0.id == rowId } }

    /// Tries a message again. One the app still holds is sent again. One the
    /// instance stored as not delivered or unconfirmed goes as a new message,
    /// to the same thread and reply, with its files, and takes its place.
    func retry(_ id: String) {
        if let index = pending.firstIndex(where: { $0.id == id }) {
            pending[index].state = .sending
            deliver(inputId: id, text: pending[index].text, images: pending[index].images, files: pending[index].files, thread: pending[index].thread)
            return
        }
        // The instance keeps what it stored under its own `inputId` and drops a
        // second send of it as a duplicate, so this goes as a new message.
        guard let messageId = id.split(separator: ":").first.map(String.init), !resending.contains(messageId),
              let stored = message(messageId) ?? thread?.messages.first(where: { $0.id == messageId }),
              let raw = stored.parts.compactMap(\.textContent).first
        else { return }
        let (text, uploads) = UploadLines.split(raw)
        guard !text.isEmpty || !uploads.isEmpty else { return }
        let target = Self.resendTarget(of: stored)
        guard !uploads.isEmpty else {
            if let inputId = send(text, images: [], files: [], thread: target) { replaced[inputId] = messageId }
            return
        }
        // The instance takes files only as bytes, so its stored copies are
        // read back and sent again as attachments, not as their link lines.
        resending.insert(messageId)
        Task {
            defer { resending.remove(messageId) }
            guard let (images, files) = await readBack(uploads) else {
                say(String(localized: "Couldn't send. Try again"))
                return
            }
            if let inputId = send(text, images: images, files: files, thread: target) { replaced[inputId] = messageId }
        }
    }

    /// Where a stored message went: its task thread, and the message it replied to.
    static func resendTarget(of message: ChatMessage) -> ThreadTarget? {
        let replyTo = message.parts.lazy.compactMap(\.replyQuote).first?.messageId
        guard replyTo != nil || message.chatThreadId != nil else { return nil }
        return ThreadTarget(
            messageId: replyTo ?? message.chatThreadId ?? message.id,
            instanceKnowsThreads: true,
            quote: true,
            thread: message.chatThreadId,
            bare: replyTo == nil ? true : nil
        )
    }

    /// A stored message's files: pictures as photos, anything else as the
    /// file it was. Nil when one cannot be read.
    private func readBack(_ uploads: [UploadLines.Upload]) async -> ([ComposerImage], [OutgoingFile])? {
        var images: [ComposerImage] = []
        var files: [OutgoingFile] = []
        let backend = backend
        for upload in uploads {
            guard let data = try? await ImageFetch.data(
                upload.source,
                assetLoader: { path, width in try await backend.asset(path: path, width: width) },
                apiLoader: { path, query in try await backend.apiFile(path: path, query: query) }
            ) else { return nil }
            if upload.isImage {
                let photo = await Task.detached { ImageCompressor.jpeg(from: data).map { ComposerImage(jpeg: $0) } }.value
                guard let photo else { return nil }
                images.append(photo)
            } else {
                files.append(OutgoingFile(name: upload.name, mimeType: OutgoingFile.mimeType(of: upload.name), dataBase64: data.base64EncodedString()))
            }
        }
        return (images, files)
    }

    private func deliver(inputId: String, text: String, images: [ComposerImage], files: [OutgoingFile] = [], fromComposer: Bool = false, thread: ThreadTarget? = nil) {
        // Kept as the chat's draft until the server takes it.
        // Kept with the thread it was for, so a lost send comes back there.
        if let drafts { drafts.store.sending(chat: drafts.chat, inputId: inputId, text: text, photos: images, fromComposer: fromComposer, thread: thread) }
        Task {
            do {
                let turn = try await backend.send(
                    sessionId: sessionId,
                    text: text,
                    files: OutgoingFile.photos(images) + files,
                    inputId: inputId,
                    priority: kind == .concierge ? .now : .next,
                    thread: thread
                )
                if let index = pending.firstIndex(where: { $0.id == inputId }) {
                    pending[index].state = .sent
                }
                if let drafts { drafts.store.delivered(chat: drafts.chat, inputId: inputId) }
                // The server does not announce the guardian's own input, so fetch it,
                // and once more if that fetch fails.
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    if await !self.refreshLatest() {
                        try? await Task.sleep(for: .seconds(3))
                        await self.refreshLatest()
                    }
                    // A turn that ended or never started (a model that could not
                    // be reached) must not leave the typing dots on.
                    if self.kind == .concierge { await self.refreshRunning() }
                }
                if kind == .concierge, turn.turnId == nil { await refreshRunning() }
                if kind == .task {
                    markRunning()
                    if let turnId = turn.turnId { activeTurnId = turnId }
                }
            } catch {
                if let index = pending.firstIndex(where: { $0.id == inputId }) {
                    pending[index].state = .failed(SendFailure(error))
                }
                // Offline, the server cannot say; the message did not go, so nothing runs for it.
                if kind == .concierge { await refreshRunning(onFailure: false) }
            }
        }
    }

    /// Shows `text` for a few seconds.
    /// A Stop on a task card did not go through.
    func stopTaskFailed() { say(String(localized: "Couldn't stop. Try again")) }

    private func say(_ text: String) {
        notice = text
        noticeWork?.cancel()
        noticeWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    /// Rome's mark on a stored guardian message.
    func statusMark(ofRow row: TranscriptRow) -> StatusMark? {
        guard kind == .concierge, case .userText(_, _, _, nil) = row, let id = row.messageId else { return nil }
        return message(id)?.statusReaction.flatMap(StatusMark.init(rawValue:))
    }

    /// The chat's newest page could not be read, and nothing offline explains it.
    var loadFailed: Bool {
        if retrying { return false }
        switch loadError {
        case nil, .offline?, .unauthorized?, .conciergeOff?: return false
        default: return true
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
                say(String(localized: "Couldn't stop. Try again"))
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

    /// `watch`: an approval of the chat's own keeps its record polled; a task
    /// card's outcome comes from its `card` instead.
    func resolve(_ id: String, approve: Bool, watch: Bool = true) {
        guard resolvingApproval[id] == nil else { return }
        resolvingApproval[id] = approve
        approvalErrors[id] = nil
        Task {
            do {
                try await backend.resolveApproval(id: id, approve: approve)
                settle(kind: "approval", id: id, outcome: .object(["kind": .string(approve ? "approved" : "rejected")]))
                if watch {
                    if let record = try? await backend.approval(id: id) { approvals[id] = record }
                    approvalPolls[id]?.cancel()
                    approvalPolls[id] = nil
                    watchApproval(id)
                }
            } catch {
                approvalErrors[id] = String(localized: "Couldn't send your decision")
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
        // The form stays on screen, with the choices, until the server has the
        // answer: a failure leaves it as it was, to send again.
        Task {
            do {
                try await backend.answer(sessionId: sessionId ?? self.sessionId, toolUseId: part.toolUseId, output: output)
                localAnswers[part.toolUseId] = output
                settle(kind: "question", id: part.toolUseId, outcome: .object(["kind": .string("answered"), "answer": .object(["text": .string(""), "output": output])]))
                // An answer to a task's card wakes the task, not this chat.
                if sessionId == nil || sessionId == self.sessionId { markRunning() }
            } catch {
                say(String(localized: "Couldn't send your answer. Your choices are kept"))
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

    /// A widget's call on its own app, with this chat's backend.
    func appCall(appId: String, method: String, path: String, body: JSONValue?) async throws -> ConnectReply {
        try await backend.appCall(appId: appId, method: method, path: path, body: body)
    }

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
