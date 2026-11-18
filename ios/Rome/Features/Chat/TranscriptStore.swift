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

    // The properties with a `didSet` are what `rows` is built from: each
    // change builds the rows again, once, so a read is a plain property read.
    private(set) var messages: [ChatMessage] = [] { didSet { rebuildRows() } }
    private(set) var pending: [PendingSend] = [] { didSet { rebuildRows() } }
    private(set) var loaded = false
    /// A read of the chat worked at least once (or it was made just now), so
    /// an empty transcript is a chat with nothing in it, not one that failed
    /// to load: only then do its empty-chat prompts show.
    private(set) var readOnce = false
    private(set) var loadError: APIError?
    /// A load the guardian started (Retry, or coming back to the chat) is on
    /// its way: the bar's Retry shows a spinner.
    private(set) var retrying = false
    /// Goes up each time a retry ends in failure: the bar shakes once.
    private(set) var retryFailures = 0
    /// The least time a retry's spinner shows, so an attempt that fails at
    /// once is still seen.
    @ObservationIgnored var retryHold: Duration = .seconds(1)
    private(set) var loadingOlder = false
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
    /// Bumps for a new message that is on the main line: a reply a stack
    /// stands for is not new there, so it is no "new message" to scroll to.
    private(set) var mainArrivals = 0
    /// What was unread when the chat opened, as far as the loaded pages
    /// show it. It stays while the chat is open, once read too. Nil when
    /// nothing was unread, and until the read mark is known.
    private(set) var unread: UnreadSummary? {
        didSet { if unread?.firstId != oldValue?.firstId { rebuildRows() } }
    }
    /// The first message that was unread when the chat opened: the rows put
    /// "New messages" above it. Nil also while the unread run may reach into
    /// an older page not loaded yet.
    var unreadFrom: String? { unread?.firstId }
    /// Whether the "N new messages" pill shows; one per open.
    let unreadPill = UnreadPill()
    /// A short line about an action that failed (Stop, an answer), shown for a few seconds.
    private(set) var notice: String?
    @ObservationIgnored private var noticeWork: Task<Void, Never>?

    /// Approval records fetched from the server, by approval id.
    private(set) var approvals: [String: ApprovalRecord] = [:]
    private(set) var resolvingApproval: [String: Bool] = [:]
    private(set) var approvalErrors: [String: String] = [:]
    /// Answers sent this session, before the server echoes them.
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
    /// What the rows do when acted on; the same object for the store's life.
    let actions = ChatActions()
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

    // An open of a Concierge chat (`beginOpen`) until it closes (`endOpen`).
    /// Reads the chat's read mark before the open marks it read.
    @ObservationIgnored private var openRead: Task<Void, Never>?
    /// The read mark at open, in whole seconds; nil until read, or when none.
    @ObservationIgnored private var openMark: Int?
    /// The rows hold what the chat held at open: the first fetch since is in.
    @ObservationIgnored private var openFetched = false
    /// Messages that arrived live during the open: never unread.
    @ObservationIgnored private var openLive: Set<String> = []
    /// The agent messages that were unread at open, fixed once both of the
    /// above are known; older pages add theirs.
    @ObservationIgnored private var openUnread: Set<String>?
    /// The longest a read waits for the read mark.
    @ObservationIgnored var readMarkWait: Duration = .seconds(2)
    /// `start()` ran and no fetch has worked since.
    @ObservationIgnored private var needsFetch = true
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
        actions.store = self
    }

    /// Answers given to cards, as stored.
    var answers: [String: JSONValue] {
        TranscriptBuilder.answers(in: messages)
    }

    /// What the transcript draws, built again whenever one of its inputs
    /// changes (`rebuildRows`), never on a read.
    private(set) var rows: [TranscriptRow] = []
    /// Whether there are no rows: what a screen reads that only needs to
    /// know that, so a new row does not draw it again.
    private(set) var rowsEmpty = true
    /// What each text row draws from its message, built with the rows.
    private(set) var rowInfo: [String: RowInfo] = [:]

    func info(for row: TranscriptRow) -> RowInfo { rowInfo[row.id] ?? RowInfo() }

    /// A merge changes the messages and the sends together: one rebuild after both.
    @ObservationIgnored private var rowsHeld = false

    private func rebuildRows() {
        guard !rowsHeld else { return }
        PerfProbe.count("rowBuild")
        let answers = answers
        let shown = visibleMessages
        // The threads this chat's main line shows as stacks. A share picks
        // whole turns, so it shows every message and no stacks.
        var held = kind == .concierge
            ? ThreadStacks.build(shown, arrival: seen, summaries: conciergePaged ? summaries : nil, hints: hints, hidesOrphans: conciergePaged)
            : .none
        if share.isSelecting { held.stacks = [:]; held.stacked = [] }
        if held != threads { threads = held }
        let built = TranscriptBuilder.rows(
            messages: shown,
            pending: pending,
            answers: answers,
            options: .init(showTools: kind == .task, showNotices: kind == .concierge, typing: showsTyping, unreadFrom: unreadFrom, stacked: held.stacked)
        )
        // An equal list is not stored: no reader is told of a change that is none.
        if built != rows { rows = built }
        if built.isEmpty != rowsEmpty { rowsEmpty = built.isEmpty }
        let infos = RowInfo.build(rows: built, messages: messages, pending: pending, kind: kind, threads: held)
        if infos != rowInfo { rowInfo = infos }
        var hosts: [String: String] = [:]
        if !held.stacks.isEmpty {
            for (row, info) in infos { if let stack = info.stack { hosts[stack.root] = row } }
        }
        if hosts != stackHosts { stackHosts = hosts }
        thread?.rebuildRows(chatMessages: messages)
    }

    /// Share mode started or ended: the rows are built again, with or without stacks.
    /// A share is of whole turns, which the pages by main-line messages do not bring
    /// whole: the loaded range is read again by turns first, and read by main-line
    /// messages again when share mode ends.
    func shareModeChanged() {
        rebuildRows()
        if share.isSelecting {
            if conciergePaged { Task { await hydrateForShare() } }
        } else if readByTurns {
            readByTurns = false
            resync()
        }
    }

    // MARK: Pages by main-line messages

    /// The instance answered by main-line messages (`type=concierge`): the replies
    /// of a thread are not loaded with it, and each stack reads its numbers
    /// from `summaries`. Otherwise (an instance before it, or a chat that is no
    /// Concierge chat) they are counted from the replies that are loaded.
    private(set) var conciergePaged = false
    /// What the instance says of each thread with replies, by root: the stacks' and the pills'
    /// numbers. Fed by pages, by a live reply (counted once), by a thread read whole,
    /// and zeroed as a thread is marked read. Used while `conciergePaged`.
    private(set) var summaries: [String: ThreadSummary] = [:] { didSet { rebuildRows() } }
    /// The name of each thread that waits with a root not loaded, by root, from the newest page.
    private(set) var hints: [String: String] = [:] { didSet { rebuildRows() } }
    /// The threads read whole, by root: every reply is loaded, and live replies keep it so.
    @ObservationIgnored private var wholeThreads: Set<String> = []
    /// The replies counted in a summary as they came or were read, so one that comes
    /// twice (the sender's own, and the instance's) counts once.
    @ObservationIgnored private var countedReplies: Set<String> = []
    /// `cursor` was given by a page by main-line messages; a turn cursor cannot be mixed with it.
    @ObservationIgnored private var cursorConcierge = false
    /// The loaded range was read by turns for a share.
    @ObservationIgnored private var readByTurns = false
    /// Thread reads under way, by the key asked for, so a second press waits for the first.
    @ObservationIgnored private var threadReads: [String: Task<MessagePage?, Never>] = [:]
    /// A thread is being read to come into focus.
    @ObservationIgnored private var openingThread = false

    /// The key of the oldest main-line message held: what a read of the loaded range reaches down to.
    private var oldestMainLineKey: String? {
        messages.lazy.filter { !$0.isTrace && ($0.chatThreadId == nil || $0.chatThreadId == $0.id) }
            .min { $0.date < $1.date }?.id
    }

    /// A page of this chat. A Concierge chat is read by its main-line messages, as
    /// the cursor that made an older page was; an instance before that answers by turns.
    private func readPage(before: String?, limit: Int, through: String? = nil) async throws -> MessagePage {
        guard kind == .concierge, before == nil || cursorConcierge else {
            if let through { return try await backend.messages(sessionId: sessionId, through: through, limit: limit) }
            return try await backend.messages(sessionId: sessionId, before: before, limit: limit)
        }
        return try await backend.conciergeMessages(sessionId: sessionId, before: before, limit: limit, through: through)
    }

    /// What a page says of the threads: its summaries, and the names of those that wait
    /// outside it. `replace` is for a page that starts the history over or reads the
    /// whole loaded range again, which also says what was read whole may be out of date.
    private func noteThreads(_ page: MessagePage, replace: Bool) {
        guard let answer = page.concierge else { return }
        var next = replace ? [:] : summaries
        for (root, summary) in answer.summaries {
            next[root] = summary
            countedReplies.insert(summary.latest.id)
        }
        if next != summaries { summaries = next }
        let named = replace ? answer.titles : hints.merging(answer.titles) { _, new in new }
        if named != hints { hints = named }
        if replace {
            wholeThreads = []
            countedReplies = Set(answer.summaries.values.map(\.latest.id))
        }
    }

    /// The loaded range replaced by a page that read all of it again: a loaded message the
    /// page does not hold is gone from the instance, unless it is newer than anything the
    /// page holds or belongs to the thread open now. Rows on their way are not messages.
    private func replaceLoaded(with page: MessagePage) {
        let fetched = Set(page.messages.map(\.id))
        let newest = page.messages.map(\.date).max() ?? .distantFuture
        let keep = Set(thread.map { messages(inThread: $0.root).map(\.id) } ?? [])
        let gone = messages.filter { !fetched.contains($0.id) && !keep.contains($0.id) && $0.date <= newest }
        if !gone.isEmpty {
            let goneIDs = Set(gone.map(\.id))
            messages.removeAll { goneIDs.contains($0.id) }
        }
        merge(page.messages)
    }

    /// Reads the loaded range again for a share, by turns, and replaces it. A read that fails says so,
    /// and share mode ends.
    private func hydrateForShare() async {
        guard let from = oldestMainLineKey else { return }
        do {
            let page = try await backend.messages(sessionId: sessionId, through: from, limit: Self.pageSize)
            guard share.isSelecting else { return }
            replaceLoaded(with: page)
            cursor = page.nextCursor
            hasOlder = page.nextCursor != nil
            cursorConcierge = false
            readByTurns = true
        } catch {
            guard share.isSelecting else { return }
            say(String(localized: "Couldn't load the chat to share"))
            share.cancel()
        }
    }

    /// Pages in the history down to message `key` (a reply too) in one read, so that
    /// its root is loaded and the history has no gap. False when it could not be reached.
    private func loadThrough(_ key: String) async -> Bool {
        guard kind == .concierge, cursorConcierge, hasOlder, !loadingOlder, let cursor else { return false }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = try? await backend.conciergeMessages(sessionId: sessionId, before: cursor, limit: Self.pageSize, through: key) else { return false }
        guard self.cursor == cursor else { return false }
        merge(page.messages)
        noteThreads(page, replace: false)
        self.cursor = page.nextCursor
        hasOlder = page.nextCursor != nil
        return true
    }

    /// What a link to a thread in a message's text reads and does here
    /// (`ThreadLinkContext`): one for the main line, which opens the thread,
    /// and one for a thread view, where a link opens nothing.
    @ObservationIgnored private(set) lazy var threadLinks = ThreadLinkContext(store: self, opens: true)
    @ObservationIgnored private(set) lazy var threadLinksInThread = ThreadLinkContext(store: self, opens: false)

    /// The chat threads of the main line: their stacks, names and the replies
    /// the stacks stand for (docs/domains/chats.md#chat-thread).
    private(set) var threads: ThreadStacks = .none
    /// The row each stack hangs under, by its thread's root.
    private(set) var stackHosts: [String: String] = [:]

    /// The dots are the only part of the rows that how the turn writes
    /// decides: the rows change only when they come or go.
    private func typingInputChanged() {
        if showsTyping != (rows.last == .typing) { rebuildRows() }
    }

    /// How the running turn shows the typing dots, as the server last said
    /// (`message_writing`); nil when no turn runs.
    private(set) var writing: (turnId: String, mode: WritingMode, writing: Bool)? { didSet { typingInputChanged() } }
    /// New messages of a `simulated` turn waiting behind the dots, oldest
    /// first, each with how long it waits.
    private(set) var held: [(id: String, wait: Duration)] = [] { didSet { rebuildRows() } }
    @ObservationIgnored private var holdWork: Task<Void, Never>?

    /// Whether the Chat shows its typing dots: the Concierge is writing a
    /// message (docs/domains/chats.md#reaction). The server alone says
    /// so: while an `exact` turn writes, or while a `simulated` turn's new
    /// message waits behind them. 👀 on the guardian's message says it started.
    var showsTyping: Bool {
        guard kind == .concierge else { return false }
        if !held.isEmpty { return true }
        guard let writing else { return false }
        return writing.mode == .exact && writing.writing
    }

    /// How long a `simulated` turn's message waits: 5 ms a character, 0.5 to 1 s.
    nonisolated static func simulatedWait(_ message: ChatMessage) -> Duration {
        let length = message.parts.compactMap(\.textContent).reduce(0) { $0 + $1.count }
        return .milliseconds(min(1000, max(500, length * 5)))
    }

    /// A new message of the `simulated` turn, arriving live after every
    /// message held, waits behind the dots, after any already waiting. A
    /// quiet turn's first message never waits: it shows no dots until it
    /// has said something.
    private func hold(_ message: ChatMessage, after newest: Date?) {
        guard kind == .concierge, loaded, let writing, writing.mode == .simulated,
              !message.isUser, !message.isTrace, message.turnId == writing.turnId else { return }
        if let newest, message.date < newest { return }
        guard TranscriptBuilder.isReply(message, parts: message.parts) else { return }
        let quiet = activeTurns.contains { ($0.turnId == writing.turnId || $0.agentTurnId == writing.turnId) && $0.quiet == true }
        if quiet, !messages.contains(where: { $0.turnId == writing.turnId && !$0.isUser && !$0.isTrace }) { return }
        held.append((message.id, Self.simulatedWait(message)))
        releaseHeld()
    }

    private func releaseHeld() {
        guard holdWork == nil, let head = held.first else { return }
        holdWork = Task { [weak self] in
            try? await Task.sleep(for: head.wait)
            guard let self else { return }
            self.holdWork = nil
            if self.held.first?.id == head.id { self.held.removeFirst() }
            self.releaseHeld()
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
        needsFetch = true
        tokens.append(backend.events.subscribe(LiveTopic.chat(sessionId)) { [weak self] event in
            self?.handle(event)
        })
        tokens.append(backend.events.subscribe(LiveTopic.chatStatus) { [weak self] event in
            self?.handle(event)
        })
        // Entering a chat whose load failed tries again where it shows: the
        // bar's spinner runs at once, never a Retry left from before.
        if loadFailed { retryLoad() } else { Task { await reload() } }
    }

    /// A chat made just now holds nothing yet: it counts as loaded at once,
    /// so its first message shows in the list instead of behind a spinner
    /// while the first fetch runs.
    func beginEmpty() {
        guard !loaded else { return }
        loaded = true
        readOnce = true
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
        // Off the screen nothing waits, so a return replays no dots. The
        // turn's writing state stays: the server says it once, and a return
        // mid-turn shows the dots it still means; the turn's end clears it.
        holdWork?.cancel()
        holdWork = nil
        held = []
        endOpen()
    }

    /// Stops the store for good: its workspace closes, its chat goes, or
    /// the workspace lets go of it (`mayBeDropped`). A screen that comes
    /// back starts a store with `start()` after a `stop()`.
    func close() {
        stop()
    }

    /// Nothing would be lost if the workspace let go of this store: no
    /// screen runs it, no send of the guardian's is held or on its way, and
    /// no share is open. Reopened, the chat loads again (a topic chat from
    /// the copy kept on disk first).
    var mayBeDropped: Bool {
        tokens.isEmpty && !onScreen && pending.isEmpty && resending.isEmpty
            && !share.isSelecting && !share.coversChat && !share.creating
    }

    /// Reads the newest page. With `resync` (after a gap in the live connection) a chat paged by
    /// main-line messages reads the whole loaded range again in one request, down to its
    /// oldest main-line message, and replaces it: a reply that came while away reaches a
    /// thread loaded long ago, and a deletion goes. Every summary is read again, what was
    /// read whole is forgotten, and the thread open is read whole again.
    func reload(resync: Bool = false) async {
        await readResends()
        do {
            let through = resync && conciergePaged ? oldestMainLineKey : nil
            let page = try await readPage(before: nil, limit: Self.pageSize, through: through)
            let paged = kind == .concierge && page.concierge != nil
            if kind == .concierge, paged != conciergePaged { conciergePaged = paged }
            // A page that reads the loaded range again replaces it, whatever it holds.
            let replace = through != nil && paged
            // A newest page that shares nothing with what is held leaves a gap
            // behind it: start over from it. Otherwise keep the pages already
            // loaded, so a reload never puts the older-page spinner back on top.
            let known = Set(messages.map(\.id))
            let wasLoaded = loaded
            let newest = page.concierge?.body ?? page.messages
            let gap = !replace && !messages.isEmpty && page.nextCursor != nil && !newest.contains { known.contains($0.id) }
            if gap {
                messages = []
                seen = [:]
            } else if fromCache {
                pruneCached(against: page)
            }
            if replace { replaceLoaded(with: page) } else { merge(page.messages) }
            noteThreads(page, replace: gap || replace)
            // Replies a refetch brings count like live ones: the list marks
            // the back-to-bottom button for a guardian reading further up.
            if wasLoaded, page.messages.contains(where: { !known.contains($0.id) && !$0.isUser && !$0.isTrace && !threads.stacked.contains($0.id) }) {
                arrivals += 1
                mainArrivals += 1
            }
            if !loaded || gap || replace || fromCache {
                cursor = page.nextCursor
                hasOlder = page.nextCursor != nil
                cursorConcierge = paged
                fromCache = false
            }
            loaded = true
            readOnce = true
            loadError = nil
            needsFetch = false
            if openRead != nil, !openFetched {
                openFetched = true
                settleUnread()
            }
            // The thread open stays whole.
            if (gap || replace), let open = thread?.root, paged { Task { _ = await ensureThreadWhole(open, force: true) } }
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
        let oldest = page.concierge?.oldestAt ?? page.messages.map(\.date).min()
        messages.removeAll { message in
            guard !fresh.contains(message.id) else { return false }
            guard page.nextCursor != nil, let oldest else { return true }
            return message.date >= oldest
        }
    }

    /// Fetches the newest page without touching paging state.
    @discardableResult
    func refreshLatest() async -> Bool {
        guard let page = try? await readPage(before: nil, limit: 20) else { return false }
        merge(page.messages)
        noteThreads(page, replace: false)
        loadError = nil
        readOnce = true
        return true
    }

    /// Fetches the page before the oldest message held and puts it above the
    /// rows at once: the list keeps the rows in view where they are.
    func loadOlder() async {
        guard hasOlder, !loadingOlder, let cursor else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = try? await readPage(before: cursor, limit: Self.pageSize) else { return }
        // A reload that found a gap started the history over while this ran;
        // a page from the old cursor would leave a hole in it.
        guard self.cursor == cursor else { return }
        PerfProbe.count("olderPlaced")
        merge(page.messages)
        noteThreads(page, replace: false)
        self.cursor = page.nextCursor
        hasOlder = page.nextCursor != nil
        // An older page was never live: its unread messages count.
        if var unread = openUnread, let openMark {
            unread.formUnion(UnreadAtOpen.unread(page.messages.filter { !openLive.contains($0.id) }, mark: openMark))
            openUnread = unread
            summarizeUnread()
        }
    }

    func markRead() {
        // A read before the open's read mark is known would erase it.
        let waiting = openRead
        Task {
            if let waiting {
                await waiting.value
                // The chat closed, or opened again, while it waited: a read
                // now would clear messages the guardian never saw.
                guard openRead == waiting else { return }
            }
            await backend.markRead(sessionId: sessionId)
        }
    }

    /// Whether the guardian sees this chat now. The main Chat stays mounted,
    /// hidden, under the other pages, so being mounted is not being seen:
    /// its replies count as read only while it shows, and once it shows again.
    var onScreen = false {
        didSet {
            if onScreen, !oldValue {
                beginOpen()
                markRead()
            }
        }
    }

    /// The chat opened: the main Chat came on screen after being left, or a
    /// topic chat's screen appeared. Reads the chat's read mark before the
    /// open marks it read, so the rows can show where the unread messages
    /// start. `markRead` waits for it, at most `readMarkWait`. Once an open:
    /// a second call does nothing until `endOpen()`.
    func beginOpen() {
        guard kind == .concierge, openRead == nil else { return }
        // A store that runs and fetched since it started is current; else
        // what it holds waits for the next fetch.
        openFetched = loaded && !needsFetch && !tokens.isEmpty
        let backend = backend
        let sessionId = sessionId
        let wait = readMarkWait
        openRead = Task { [weak self] in
            let read = Task { await backend.readMark(sessionId: sessionId) }
            let timer = Task {
                try? await Task.sleep(for: wait)
                read.cancel()
            }
            let mark = await read.value
            timer.cancel()
            guard let self, !Task.isCancelled else { return }
            self.openMark = RomeDate.parse(mark).map { UnreadAtOpen.second($0) }
            self.settleUnread()
        }
    }

    /// The app went to the background: coming back in front opens the chat
    /// again (`chatShown`), and that open waits for the catch-up read that
    /// brings what arrived meanwhile.
    func leftForBackground() {
        guard kind == .concierge else { return }
        endOpen()
        needsFetch = true
    }

    /// The chat closed: the line goes, and the next open looks again.
    func endOpen() {
        openRead?.cancel()
        openRead = nil
        openMark = nil
        openFetched = false
        openLive = []
        openUnread = nil
        unread = nil
        unreadPill.reset()
    }

    /// Fixes what was unread at open, once the read mark and the rows held
    /// at open are both known.
    private func settleUnread() {
        guard openUnread == nil, openFetched, let openMark else { return }
        openUnread = UnreadAtOpen.unread(messages.filter { !openLive.contains($0.id) }, mark: openMark)
        summarizeUnread()
    }

    private func summarizeUnread() {
        // The replies a stack stands for are not on the main line, so they are no
        // place for the line to go.
        unread = openUnread.flatMap { UnreadAtOpen.summary(in: messages, unread: $0, hasOlder: hasOlder, excluding: threads.stacked) }
        // No line drawn yet, the run going on into an older page: the pill
        // shows as for a line above the screen.
        if let unread, unread.firstId == nil { unreadPill.dividerAbove(true) }
    }

    /// The pill was tapped: older pages come in until the line is drawn,
    /// then the transcript brings it to the top. A run that cannot be
    /// found says so briefly.
    func revealUnread() async {
        guard unread != nil else { return }
        var stalled = 0
        // The chat closing ends the search: `endOpen()` drops `unread`.
        while unread != nil, unreadFrom == nil, hasOlder, stalled < 2 {
            let before = messages.count
            await loadOlder()
            if messages.count == before {
                stalled += 1
                try? await Task.sleep(for: .milliseconds(150))
            } else {
                stalled = 0
            }
        }
        guard unread != nil else { return }
        guard unreadFrom != nil else {
            say(String(localized: "Can't find where the new messages start"))
            return
        }
        jumpTarget = TranscriptRow.unreadDivider.id
        jumps += 1
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
        rowsHeld = true
        defer {
            rowsHeld = false
            rebuildRows()
            // What arrives in the thread that is open is seen as it comes.
            readOpenThread()
        }
        // A copy of a message already held, with the same turn and time,
        // keeps its place: every key the order goes by is unchanged, so it
        // replaces the held one where it stands, with no sort. Streaming and
        // live edits of a message take this path.
        if !incoming.isEmpty, let placed = placedInPlace(incoming) {
            if placed != messages { messages = placed }
            if persist { cache?.save(chat: sessionId, messages: messages) }
            return
        }
        var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in incoming {
            byID[message.id] = completed(message, held: byID[message.id]) { root in
                byID.values.first { $0.chatThreadId == root && $0.chatThreadTitle != nil }?.chatThreadTitle
            }
            if seen[message.id] == nil {
                seen[message.id] = seen.count
            }
        }
        messages = Self.ordered(Array(byID.values), seen: seen)
        let stored = Set(messages.map(\.id))
        if pending.contains(where: { stored.contains($0.id) }) { pending.removeAll { stored.contains($0.id) } }
        if persist { cache?.save(chat: sessionId, messages: messages) }
    }

    /// `incoming` put in place of the messages it updates, or nil when one
    /// of them is new or moved to another turn or time and the order must be
    /// worked out again.
    private func placedInPlace(_ incoming: [ChatMessage]) -> [ChatMessage]? {
        var placed = messages
        for message in incoming {
            guard let index = placed.firstIndex(where: { $0.id == message.id }),
                  placed[index].turnId == message.turnId, placed[index].createdAt == message.createdAt
            else { return nil }
            placed[index] = completed(message, held: placed[index]) { root in
                placed.first { $0.chatThreadId == root && $0.chatThreadTitle != nil }?.chatThreadTitle
            }
        }
        return placed
    }

    /// An incoming copy with what the chat already knows about it: its
    /// thread and the thread's title.
    private func completed(_ incoming: ChatMessage, held: ChatMessage?, threadTitle: (String) -> String?) -> ChatMessage {
        var message = incoming
        if message.knowsThreads {
            instanceKnowsThreads = true
        } else if let held, held.knowsThreads {
            // A live insert leaves the thread out: keep the one already known.
            message.chatThreadId = held.chatThreadId
            message.chatThreadTitle = held.chatThreadTitle
            message.knowsThreads = true
        }
        // A message the owner has seen stays seen, and a copy that leaves the
        // mark out (a live insert) keeps the one already known.
        if held?.read == true { message.read = true } else if message.read == nil { message.read = held?.read }
        // A copy that leaves the title out keeps the one already known, and a
        // message of a thread takes its title from the thread.
        if message.chatThreadTitle == nil, let root = message.chatThreadId {
            if let held, held.chatThreadId == root, let title = held.chatThreadTitle {
                message.chatThreadTitle = title
            } else {
                message.chatThreadTitle = threadTitle(root)
            }
        }
        return message
    }

    /// The server's order: turns by when they started, then by when they
    /// first arrived; in a turn, rows by time, then by arrival. Each
    /// message's keys are worked out once, not on every comparison.
    static func ordered(_ all: [ChatMessage], seen: [String: Int]) -> [ChatMessage] {
        struct Keys {
            let turn: String
            let date: Date
            let arrival: Int
        }
        let keys = all.map { Keys(turn: $0.turnId ?? $0.id, date: $0.date, arrival: seen[$0.id] ?? Int.max) }
        var turnStart: [String: Date] = [:]
        var turnArrival: [String: Int] = [:]
        for key in keys {
            turnStart[key.turn] = min(turnStart[key.turn] ?? key.date, key.date)
            turnArrival[key.turn] = min(turnArrival[key.turn] ?? Int.max, key.arrival)
        }
        struct Sorted {
            let index: Int
            let start: Date
            let turnArrival: Int
            let turn: String
            let date: Date
            let arrival: Int
        }
        let sorted = keys.enumerated().map { index, key in
            Sorted(index: index, start: turnStart[key.turn]!, turnArrival: turnArrival[key.turn]!, turn: key.turn, date: key.date, arrival: key.arrival)
        }.sorted { a, b in
            if a.start != b.start { return a.start < b.start }
            // Ids are random, so comparing them would decide a tie by chance.
            if a.turn != b.turn { return a.turnArrival < b.turnArrival }
            if a.date != b.date { return a.date < b.date }
            return a.arrival < b.arrival
        }
        return sorted.map { all[$0.index] }
    }

    // MARK: Live events

    private func handle(_ event: LiveEvent) {
        switch event {
        case .messageInsert(var message) where message.sessionId == sessionId:
            let held = messages.first { $0.id == message.id }
            let isNew = held == nil
            // A live insert leaves the mark out: keep the one already known.
            if message.reaction == nil { message.reaction = held?.reaction }
            if message.status == nil { message.status = held?.status }
            let newest = messages.map(\.date).max()
            // Only a message that arrives live may wait behind the dots: never
            // history, a catch-up read on return, or an older page.
            if isNew { hold(message, after: newest) }
            if isNew, openRead != nil { openLive.insert(message.id) }
            merge([message])
            noteReply(self.message(message.id) ?? message)
            if isNew, !message.isUser, !message.isTrace {
                arrivals += 1
                if !threads.stacked.contains(message.id) { mainArrivals += 1 }
            }
        case .messageWriting(let id, let turnId, let mode, let isWriting) where id == sessionId:
            writing = (turnId, mode, isWriting)
        case .sessionRunning(let id, let isRunning) where id == sessionId:
            if isRunning != running || isRunning {
                Task { await refreshRunning(hint: isRunning) }
            }
            if !isRunning {
                // The turn's trace summary and reply are final now.
                Task { await reload() }
            }
        case .reaction(let id, let messageId, let reaction) where id == sessionId:
            if let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].reaction = reaction
            }
        case .status(let id, let messageId, let status) where id == sessionId:
            if let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].status = status
            }
        case .cardSettled(let id, let card) where id == sessionId:
            settle(card)
        case .reconnected:
            resync()
        default:
            break
        }
    }

    /// Puts a settled card in place of the card of every part that shows it.
    func settle(_ card: JSONValue) {
        editMessages { messages in
            for index in messages.indices {
                if let content = TaskAskCard.settling(content: messages[index].content, with: card) {
                    messages[index].content = content
                }
            }
        }
        thread?.settle(card)
    }

    /// Changes several messages at once, so the rows are built once for all.
    private func editMessages(_ edit: (inout [ChatMessage]) -> Void) {
        var edited = messages
        edit(&edited)
        if edited != messages { messages = edited }
    }

    /// Shows an answer or a decision the instance took before it announces
    /// it: the cards that show `id` take `outcome`.
    private func settle(kind: String, id: String, outcome: JSONValue) {
        editMessages { messages in
            for index in messages.indices {
                if let content = TaskAskCard.settling(content: messages[index].content, kind: kind, id: id, outcome: outcome) {
                    messages[index].content = content
                }
            }
        }
    }

    // MARK: Chat threads

    /// The chat thread shown over the chat, if one is open.
    private(set) var thread: ThreadStore?
    /// The instance has chat threads: a read showed `chatThreadId`, on any
    /// message.
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

    /// The reply bar shows for a reply to a message, and for Reply inside a
    /// thread view; not for a thread view opened from its label.
    var showsQuoteBar: Bool { quote != nil && (quote?.bare != true || repliesToThread) }

    /// Reply was pressed inside a thread view: the bar names the task, and
    /// the send goes to the thread, quoting no message.
    private(set) var repliesToThread = false

    /// The thread the reply bar names for a reply inside a thread view.
    var threadReplyTitle: String? {
        guard repliesToThread, let thread else { return nil }
        return thread.title ?? threadTitle(of: thread.anchor)
    }

    /// The quoted message, when it is held.
    var quotedMessage: ChatMessage? {
        if repliesToThread { return nil }
        return quote.flatMap { message($0.messageId) ?? thread?.messages.first { [id = $0.messageId] in $0.id == id } }
    }

    /// The name of the chat thread `message` is in, or nil when it is in none
    /// or the thread has no name.
    func threadTitle(of message: ChatMessage) -> String? {
        Self.threadTitle(of: message, in: messages)
    }

    static func threadTitle(of message: ChatMessage, in messages: [ChatMessage]) -> String? {
        if let title = message.chatThreadTitle { return title }
        return TranscriptBuilder.threadTitles(messages)[message.threadRoot]
    }

    /// Whether `message` is in a chat thread of more than one message: its
    /// root is another message, or a held message replies in a thread it roots.
    func isInThread(_ message: ChatMessage) -> Bool {
        if let root = message.chatThreadId, root != message.id { return true }
        return messages.contains { $0.chatThreadId == message.id && $0.id != message.id }
    }

    /// Reply on a message: the reply bar quotes it. An open thread view
    /// stays open, and the send goes into its thread.
    func reply(to messageId: String) {
        guard kind == .concierge, message(messageId) != nil || thread != nil else { return }
        if let thread {
            // Inside a thread view a reply goes to the thread, not to a message.
            quote = ThreadTarget(messageId: thread.anchor.id, instanceKnowsThreads: true, quote: true, thread: thread.root, bare: true)
            repliesToThread = true
        } else {
            quote = ThreadTarget(messageId: messageId, instanceKnowsThreads: true, quote: true)
        }
        replies += 1
    }

    /// Goes up on each Reply: the composer takes the keyboard.
    private(set) var replies = 0

    /// The reply bar's ✕: the reply goes, and an open thread view with it.
    func cancelQuote() {
        closeThread()
    }

    /// Opens the thread view of the chat thread `messageId` is in: the message
    /// is tinted, and a send goes into the thread.
    func openThread(at messageId: String) {
        guard kind == .concierge, messages.contains(where: { $0.id == messageId }) else { return }
        whenWhole(messageId) { [weak self] in
            guard let self, let anchor = self.message(messageId) else { return }
            self.open(anchor: anchor, older: [], replyTo: messageId, bare: true)
        }
    }

    /// The quote in a reply, the guardian's or the Concierge's, was tapped. A
    /// reply is in a chat thread, so it opens that thread's view, held on the
    /// reply. Nil when the quote leads nowhere.
    func quoteAction(reply replyId: String, original: String) -> (() -> Void)? {
        guard kind == .concierge else { return nil }
        if let host = message(replyId), isInThread(host) {
            // A reply in the thread view goes to the thread, quoting nothing.
            return { [weak self] in
                self?.whenWhole(replyId) {
                    guard let self, let host = self.message(replyId) else { return }
                    self.open(anchor: host, older: [], tint: original, bare: true)
                }
            }
        }
        guard message(original) != nil else { return nil }
        return { [weak self] in self?.jump(to: original) }
    }

    /// Brings the message with a task's card into view and tints it. One not
    /// held yet comes in one read that reaches down to it; one not found
    /// says so briefly.
    func revealCard(_ messageId: String) async {
        // A chat paged by main-line messages reads the message with its thread, down to its root.
        if message(messageId) == nil, conciergePaged {
            _ = await ensureThreadWhole(messageId)
        } else if message(messageId) == nil,
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
        // A reply a stack stands for is not on the main line: its thread opens on it.
        if threads.stacked.contains(messageId) {
            if thread == nil, !share.isSelecting { openThread(at: messageId) }
            return
        }
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
        quote = ThreadTarget(messageId: replyTo ?? anchor.id, instanceKnowsThreads: true, quote: true, thread: opened.root, bare: bare ? true : nil)
        repliesToThread = false
        tint(target ?? anchor.id)
        opened.start()
        readOpenThread()
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
        repliesToThread = false
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
        // A draft from before quotes was written in a thread view. With no
        // thread under its message there is none to open: it is a plain reply.
        if target.quote == nil, let held = message(target.messageId), !isInThread(held) {
            quote = ThreadTarget(messageId: target.messageId, instanceKnowsThreads: true, quote: true)
            return
        }
        guard let root = target.threadMessage else {
            quote = target
            return
        }
        if let anchor = message(root) {
            whenWhole(root) { [weak self] in
                guard let self, self.thread == nil else { return }
                self.open(anchor: anchor, older: [], replyTo: target.messageId, bare: target.bare == true)
            }
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
            if conciergePaged {
                guard await ensureThreadWhole(root) != nil, let anchor = message(root) else {
                    if reopening == target { reopening = nil }
                    return
                }
                guard reopening == target, thread == nil else { return }
                open(anchor: anchor, older: [], replyTo: target.messageId, bare: target.bare == true)
                return
            }
            let found = try await backend.thread(sessionId: sessionId, root: root)
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

    // MARK: Stacks, read marks and pills

    /// The messages of thread `root` the owner has not seen, the root
    /// included. An instance that keeps no read marks has none.
    func unreadMessages(inThread root: String) -> [String] {
        messages.filter { threads.roots[$0.id] == root && $0.read == false }.map(\.id)
    }

    /// The owner has seen these messages: they read as seen at once, and the
    /// instance is told. The instance not taking it, as one before the route
    /// does, changes nothing here: the next open reads them again.
    func markMessagesRead(_ ids: [String]) {
        guard kind == .concierge, !ids.isEmpty else { return }
        let wanted = Set(ids)
        // The summaries of the threads whose replies these are say nothing waits.
        let roots = Set(messages.compactMap { message -> String? in
            guard wanted.contains(message.id), let root = message.chatThreadId, root != message.id else { return nil }
            return root
        })
        editMessages { messages in
            for index in messages.indices where wanted.contains(messages[index].id) && messages[index].read == false {
                messages[index].read = true
            }
        }
        if conciergePaged { zeroUnread(of: roots) }
        cache?.save(chat: sessionId, messages: messages)
        // The messages carry the chat's own id, which the main chat's store, by the fixed one, does not.
        let session = messages.first { wanted.contains($0.id) }?.sessionId ?? sessionId
        let backend = backend
        Task { await backend.markMessagesRead(sessionId: session, ids: ids) }
    }

    /// Everything unread in thread `root` is seen: it was opened, or its pill was pressed.
    /// A thread paged by main-line messages is read whole first, since its summary counts
    /// replies that are not loaded.
    func markThreadRead(_ root: String) {
        markMessagesRead(unreadMessages(inThread: root))
        if conciergePaged, wholeThreads.contains(root) { zeroUnread(of: [root]) }
    }

    private func zeroUnread(of roots: Set<String>) {
        var next = summaries
        for root in roots { if let held = next[root], held.unreadCount > 0 { next[root] = held.seen } }
        if next != summaries { summaries = next }
    }

    /// A reply came live: it counts in its thread's summary once, as the newest. A reply the
    /// summary holds, one read whole, and one that does not count change nothing.
    private func noteReply(_ message: ChatMessage) {
        guard kind == .concierge, conciergePaged, let root = message.chatThreadId, root != message.id,
              ThreadStacks.counts(message), countedReplies.insert(message.id).inserted else { return }
        if summaries[root]?.latest.id == message.id { return }
        summaries[root] = summaries[root].map { $0.withLive(reply: message) } ?? .first(reply: message)
    }

    /// The owner's reply into a thread counts in its summary once the instance has taken
    /// it, so a send that was turned down never changes the stack. Its stored copy,
    /// read later, is the same reply and counts no more.
    private func noteOwnReply(inputId: String, text: String, target: ThreadTarget?) {
        guard kind == .concierge, conciergePaged, let target, let root = threadRoot(of: target),
              countedReplies.insert(inputId).inserted else { return }
        let content = (try? JSONSerialization.data(withJSONObject: [["type": "text", "content": text]])).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let reply = ChatMessage(id: inputId, sessionId: message(root)?.sessionId ?? sessionId, role: "user", content: content, createdAt: RomeDate.string(.now), chatThreadId: root, knowsThreads: true, read: true)
        summaries[root] = summaries[root].map { $0.withLive(reply: reply) } ?? .first(reply: reply)
    }

    /// The thread a send lands in: the one it names, else the one of the message it replies to.
    private func threadRoot(of target: ThreadTarget) -> String? {
        target.thread ?? message(target.messageId)?.threadRoot
    }

    // MARK: Chat threads read whole

    /// Reads the thread of `key`, any message of it, whole and without taking it in. Nil when it
    /// cannot be read or the chat holds no such message.
    private func readThread(_ key: String) async -> MessagePage? {
        if let reading = threadReads[key] { return await reading.value }
        let backend = backend
        let session = messages.first?.sessionId ?? sessionId
        let reading = Task { () -> MessagePage? in
            guard let page = try? await backend.conciergeThread(sessionId: session, key: key),
                  page.concierge?.root != nil, !page.messages.isEmpty else { return nil }
            return page
        }
        threadReads[key] = reading
        let page = await reading.value
        threadReads[key] = nil
        return page
    }

    /// Reads the thread of `key` whole the first time (or again with `force`) and keeps it whole
    /// from then on by live replies. A thread whose root is older than the loaded history is
    /// read down to first, with one read, so the history has no gap. Answers the thread's
    /// root, or nil when the thread cannot be read.
    @discardableResult
    func ensureThreadWhole(_ key: String, force: Bool = false) async -> String? {
        if !force, let root = message(key)?.threadRoot, wholeThreads.contains(root) { return root }
        // A thread known by its root (a pill's) that is older than the loaded history: down to it first.
        if message(key) == nil, summaries[key] != nil { _ = await loadThrough(key) }
        guard let page = await readThread(key), let root = page.concierge?.root else { return nil }
        if message(root) == nil {
            guard await loadThrough(root), message(root) != nil else { return nil }
        }
        takeInThread(root, page)
        return root
    }

    /// A thread read whole: its messages, its summary from the replies it brought, and that it is whole.
    private func takeInThread(_ root: String, _ page: MessagePage) {
        merge(page.messages)
        let replies = page.messages.filter { $0.chatThreadId == root && $0.id != root }
        countedReplies.formUnion(replies.map(\.id))
        if let summary = ThreadSummary.of(replies: replies, arrival: seen) {
            summaries[root] = summary
        } else if let held = summaries[root], countedReplies.contains(held.latest.id) {
            // A reply counted as it came, which the read does not list yet: it stays counted.
        } else {
            summaries[root] = nil
        }
        wholeThreads.insert(root)
    }

    /// Shows thread `key` once it can be shown whole: at once on an instance that pages by turns,
    /// else after it is read. A thread that cannot be read does not open, and the chat says so.
    private func whenWhole(_ key: String, _ present: @escaping () -> Void) {
        guard conciergePaged, kind == .concierge else {
            present()
            return
        }
        if let root = message(key)?.threadRoot, wholeThreads.contains(root) {
            present()
            return
        }
        guard !openingThread else { return }
        openingThread = true
        Task {
            defer { openingThread = false }
            guard await ensureThreadWhole(key) != nil else {
                say(String(localized: "Couldn't open the thread"))
                return
            }
            guard thread == nil else { return }
            present()
        }
    }

    /// Opening a thread reads it, and so does a message that arrives in it while it is open.
    private func readOpenThread() {
        guard let thread else { return }
        markThreadRead(thread.root)
    }

    /// Which watched stacks the list says are at least half on screen. Seeing a
    /// stack reads nothing: it only hides the pill that would say what the
    /// guardian already sees.
    private(set) var seenStacks: Set<String> = []

    func setSeenStacks(_ seen: Set<String>) {
        if seen != seenStacks { seenStacks = seen }
    }

    /// The stacks whose visibility decides a pill, by the row each hangs
    /// under: those with unread replies.
    var stackWatch: [String: String] {
        var watch: [String: String] = [:]
        for stack in threads.stacks.values where stack.hasUnread {
            if let host = stackHosts[stack.root] { watch[host] = stack.root }
        }
        return watch
    }

    /// The threads that wait for the guardian with a pill, oldest waiting first
    /// (`ThreadStacks.waiting`): none while a thread is open.
    var pills: [String] {
        threads.waiting(seen: seenStacks, threadOpen: thread != nil)
    }

    /// A thread's name, as a pill or a link shows it.
    func threadName(_ root: String) -> String? { threads.titles[root] }

    /// The stack shown tinted for a moment: where a pill brought the transcript.
    private(set) var tintedStack: String?
    @ObservationIgnored private var untintStack: Task<Void, Never>?

    /// A pill was pressed: the transcript goes to the thread's stack and tints
    /// it for a moment, the thread's messages are read, and the pill goes. The
    /// thread does not open.
    func showStack(_ root: String) {
        guard conciergePaged, kind == .concierge else {
            landOnStack(root)
            return
        }
        // The pill of a thread whose root is older than the loaded history reads down to
        // the root with one read; the thread is read whole before it is marked read, since
        // the stack knows only the newest reply.
        guard !openingThread else { return }
        openingThread = true
        Task {
            defer { openingThread = false }
            guard await ensureThreadWhole(root) != nil else {
                say(String(localized: "Couldn't open the thread"))
                return
            }
            landOnStack(root)
        }
    }

    private func landOnStack(_ root: String) {
        guard let host = stackHosts[root] else {
            // A root with no stack to draw (a card alone) has nothing to scroll to: its thread opens.
            if message(root) != nil { openThread(at: root) }
            return
        }
        jumpTarget = host
        jumps += 1
        untintStack?.cancel()
        tintedStack = root
        untintStack = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.tintedStack = nil
        }
        markThreadRead(root)
    }

    /// A stack, or a link to a thread, was pressed: opens the thread when the
    /// chat holds it. Nothing opens while one is open already, or while a share is picked.
    func openChatThread(_ root: String) {
        guard kind == .concierge, thread == nil, !share.isSelecting, threads.holds(root) else { return }
        // A thread whose root is not loaded is read down to first.
        if conciergePaged, message(root) == nil {
            whenWhole(root) { [weak self] in self?.openThread(at: root) }
            return
        }
        openThread(at: root)
    }

    /// Whether a link to thread `root` opens it here.
    func opensThread(_ root: String) -> Bool {
        kind == .concierge && thread == nil && !share.isSelecting && threads.holds(root)
    }

    /// A Reply sent from the main line, with no thread open, opens the thread it
    /// joined once the instance takes it, so the guardian sees what they sent and
    /// the answer. A reply from inside a thread is in it already.
    private func openJoinedThread(_ target: ThreadTarget?) {
        guard kind == .concierge, thread == nil, !share.isSelecting, let target, target.isQuote, target.bare != true, target.thread == nil,
              message(target.messageId) != nil else { return }
        whenWhole(target.messageId) { [weak self] in
            guard let self, let anchor = self.message(target.messageId) else { return }
            self.open(anchor: anchor, older: [], bare: true)
        }
    }

    /// The sends still on their way that land in thread `root`: its own, and a
    /// reply to one of its messages.
    func pendingSends(inThread root: String) -> [PendingSend] {
        pending.filter { send in
            guard let target = send.thread else { return false }
            return (target.thread ?? message(target.messageId)?.threadRoot) == root
        }
    }

    /// The composer sent a message. A thread open over the chat stays open, so
    /// the next message goes into it as well; a Reply from the main line ends
    /// here, and opens its thread once the instance takes it.
    func composerSent() {
        if thread != nil {
            repliesToThread = false
        } else {
            closeThread()
        }
    }

    /// The messages held for this chat that are in `root`'s thread.
    func messages(inThread root: String) -> [ChatMessage] {
        messages.filter { !$0.isTrace && ($0.chatThreadId == root || $0.id == root) }
    }


    /// The stored messages drawn: a message sent again gives way to its new
    /// copy, both while the copy is on its way and once it is stored.
    var visibleMessages: [ChatMessage] {
        let hidden = resentOriginals.union(held.map(\.id))
        return hidden.isEmpty ? messages : messages.filter { !hidden.contains($0.id) }
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
                await reload(resync: true)
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

    /// Tries the failed load again, visibly: the bar stays and its Retry
    /// turns into a spinner for at least `retryHold`. The bar then goes, or
    /// shows Retry again and shakes.
    func retryLoad() {
        guard !retrying else { return }
        retrying = true
        Task {
            let started = ContinuousClock.now
            resync()
            await resyncWork?.value
            let left = retryHold - (ContinuousClock.now - started)
            if left > .zero { try? await Task.sleep(for: left) }
            retrying = false
            if loadFailed { retryFailures += 1 }
        }
    }

    /// The chat is in front again, or entered: a load that failed before is
    /// tried at once and visibly; otherwise only the running turn is looked at.
    func chatShown() {
        // Back in front counts as opening it; an open still under way stays.
        beginOpen()
        if loadFailed { retryLoad() } else { recheckRunning() }
    }

    /// The chat came back to the screen: asks once whether its turn still runs.
    func recheckRunning() {
        guard kind == .concierge, running else { return }
        Task { await refreshRunning() }
    }

    /// While a turn runs, asks the instance now and then whether it still
    /// does, so a live event that never arrives cannot leave Stop up. The
    /// dots go by `message_writing` alone. The poll ends with the running state.
    private func startRunningPoll() {
        guard kind == .concierge, !closed, runningPoll == nil else { return }
        runningPoll = Task { [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.runningPollInterval else { return }
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self, self.running else { return }
                await self.refreshRunning()
            }
        }
    }

    private func markIdle() {
        if stopping { stopped = true }
        // The turn is over: no message is being written.
        if writing?.writing == true { writing?.writing = false }
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
        send(text, images: images, files: [], fromComposer: fromComposer, keepsDraft: true, thread: thread) != nil
    }

    /// The send's `inputId`, or nil when there is nothing to send. `files`:
    /// anything other than photos, which only a resend carries. A resend
    /// keeps no draft: its original stays on the instance, and shows again
    /// with its Retry if the copy is lost.
    private func send(_ text: String, images: [ComposerImage], files: [OutgoingFile], fromComposer: Bool = false, keepsDraft: Bool, thread: ThreadTarget?) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty || !files.isEmpty else { return nil }
        let inputId = UUID().uuidString.lowercased()
        pending.append(PendingSend(id: inputId, text: trimmed, images: images, files: files, createdAt: .now, state: .sending, thread: thread, keepsDraft: keepsDraft))
        if kind == .concierge {
            markRunning()
        }
        deliver(inputId: inputId, text: trimmed, images: images, files: files, fromComposer: fromComposer, keepsDraft: keepsDraft, thread: thread)
        return inputId
    }

    /// Removes a send that failed for good, and the draft kept for it. A
    /// stored message it was sent in place of shows again.
    func removePending(_ id: String) {
        pending.removeAll { $0.id == id }
        if resends.values.contains(id) {
            resends = resends.filter { $0.value != id }
            if let drafts { drafts.store.forgetResend(chat: drafts.chat, copy: id) }
        }
        if let drafts { drafts.store.delivered(chat: drafts.chat, inputId: id) }
    }

    /// Resends: a stored message the instance did not take, by its id, and
    /// the `inputId` of the copy sent in its place. Recorded when the copy
    /// goes and kept with the chat's drafts, so a relaunch knows the pair.
    private(set) var resends: [String: String] = [:] { didSet { rebuildRows() } }
    @ObservationIgnored private var resendsRead = false
    /// Stored messages whose files are being read back for a resend.
    private var resending: Set<String> = []

    /// The originals a resend took the place of: hidden only while their
    /// copy is still held or stored, so a copy that failed for good and was
    /// dropped (here, or by a relaunch) brings its original back.
    var resentOriginals: Set<String> { resentOriginals(alsoHeld: []) }

    /// The same, counting copies held elsewhere too: a thread view's own read
    /// can hold a copy the chat's pages do not.
    func resentOriginals(alsoHeld extra: Set<String>) -> Set<String> {
        guard !resends.isEmpty else { return [] }
        let present = Set(pending.map(\.id)).union(messages.map(\.id)).union(extra)
        return Set(resends.filter { present.contains($0.value) }.keys)
    }

    /// The resend copies still on their way for these originals, for a
    /// thread view that shows the originals' place.
    func pendingResends(of originals: Set<String>) -> [PendingSend] {
        let copies = Set(resends.filter { originals.contains($0.key) }.values)
        return pending.filter { copies.contains($0.id) }
    }

    /// Reads the chat's resends once, before the first rows are drawn.
    private func readResends() async {
        guard !resendsRead else { return }
        resendsRead = true
        if let drafts { resends.merge(await drafts.store.resends(chat: drafts.chat)) { mine, _ in mine } }
    }

    private func recordResend(of original: String, as inputId: String) {
        resends[original] = inputId
        if let drafts { drafts.store.recordResend(chat: drafts.chat, original: original, copy: inputId) }
    }

    /// Whether the row is a send the app still holds, which only it can drop.
    func isPending(_ rowId: String) -> Bool { pending.contains { $0.id == rowId } }

    /// Tries a message again. One the app still holds is sent again. One the
    /// instance stored as not delivered or unconfirmed goes as a new message,
    /// to the same thread and reply, with its files, and takes its place.
    func retry(_ id: String) {
        if let index = pending.firstIndex(where: { $0.id == id }) {
            pending[index].state = .sending
            deliver(inputId: id, text: pending[index].text, images: pending[index].images, files: pending[index].files, keepsDraft: pending[index].keepsDraft, thread: pending[index].thread)
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
            if let inputId = send(text, images: [], files: [], keepsDraft: false, thread: target) { recordResend(of: messageId, as: inputId) }
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
            if let inputId = send(text, images: images, files: files, keepsDraft: false, thread: target) { recordResend(of: messageId, as: inputId) }
        }
    }

    /// What a send from the open thread view names to the instance. The view
    /// replies to the thread, and the app picks the message: the thread's
    /// last with text, which a card has none of. The instance stores the reply
    /// to that message as given, so the reply is under the message the
    /// guardian could see. A thread with no such message loaded, or a send
    /// that is not from the view, goes as it is.
    func wireTarget(_ target: ThreadTarget?) -> ThreadTarget? {
        guard let target, target.bare == true, let thread,
              let tail = thread.messages.last(where: Self.hasQuotableText)
        else { return target }
        return ThreadTarget(messageId: tail.id, instanceKnowsThreads: target.instanceKnowsThreads, quote: true, thread: target.thread)
    }

    /// Whether `message` has words to quote: text, not an upload line or a card.
    static func hasQuotableText(_ message: ChatMessage) -> Bool {
        message.parts.contains { part in
            guard let raw = part.textContent else { return false }
            return !(message.isUser ? UploadLines.split(raw).text : raw)
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Where a stored message went: its chat thread, and the message it replied to.
    static func resendTarget(of message: ChatMessage) -> ThreadTarget? {
        guard let replyTo = message.parts.lazy.compactMap(\.replyQuote).first?.messageId else { return nil }
        return ThreadTarget(
            messageId: replyTo,
            instanceKnowsThreads: true,
            quote: true,
            thread: message.chatThreadId == message.id ? nil : message.chatThreadId
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

    private func deliver(inputId: String, text: String, images: [ComposerImage], files: [OutgoingFile] = [], fromComposer: Bool = false, keepsDraft: Bool = true, thread: ThreadTarget? = nil) {
        // Kept as the chat's draft until the server takes it.
        // Kept with the thread it was for, so a lost send comes back there.
        if keepsDraft, let drafts { drafts.store.sending(chat: drafts.chat, inputId: inputId, text: text, photos: images, fromComposer: fromComposer, thread: thread) }
        let target = wireTarget(thread)
        Task {
            do {
                let turn = try await backend.send(
                    sessionId: sessionId,
                    text: text,
                    files: OutgoingFile.photos(images) + files,
                    inputId: inputId,
                    priority: kind == .concierge ? .now : .next,
                    thread: target
                )
                if let index = pending.firstIndex(where: { $0.id == inputId }) {
                    pending[index].state = .sent
                }
                if let drafts { drafts.store.delivered(chat: drafts.chat, inputId: inputId) }
                noteOwnReply(inputId: inputId, text: text, target: thread)
                if keepsDraft { openJoinedThread(thread) }
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
    private func say(_ text: String) {
        notice = text
        noticeWork?.cancel()
        noticeWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    /// What the load-error bar shows: nil for no bar.
    var loadBar: LoadBar? {
        if retrying { return loadFailed || loadError == nil ? .retrying : nil }
        return loadFailed ? .failed : nil
    }

    /// The chat's newest page could not be read, and nothing offline explains it.
    var loadFailed: Bool {
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

    // MARK: Connect cards

    #if DEBUG
    /// Snapshot runs show each card state at once, by service.
    nonisolated(unsafe) static var previewPhases: [String: ConnectPhase] = [:]
    static func previewPhase(_ service: String) -> ConnectPhase? { previewPhases[service] }
    #else
    static func previewPhase(_ service: String) -> ConnectPhase? { nil }
    #endif

    /// An event a widget fired, sent to core by the widget's id; core decides
    /// what it means. What it changed, such as an answer and the turn it
    /// starts, comes back with the next read: the server announces no message
    /// of the guardian's own.
    func answerWidget(widgetId: String, name: String, context: JSONValue) async throws -> WidgetEventReply {
        // Whatever core said, read the chat again: a card answered elsewhere
        // shows its answer, and a turn the event started shows even if it
        // ended before this chat saw it run.
        defer { resync() }
        return try await backend.answerWidget(widgetId: widgetId, name: name, context: context)
    }

    /// A widget's read of its own app, with this chat's backend.
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

/// What was unread when a Concierge chat opened, by the server's rule: an
/// agent message is unread when it was made after the chat's read mark. Both
/// times are whole seconds, so a message in the mark's own second is read.
enum UnreadAtOpen {
    static func second(_ date: Date) -> Int { Int(date.timeIntervalSince1970.rounded(.down)) }

    /// The agent messages of `messages` made after `mark`.
    static func unread(_ messages: [ChatMessage], mark: Int) -> Set<String> {
        Set(messages.filter { $0.role == "assistant" && second($0.date) > mark }.map(\.id))
    }

    /// The unread messages of `messages` the chat draws: how many, and the
    /// first in the chat's order; nil when none is drawn. A page holds whole
    /// turns, so while older pages remain and the oldest loaded turn has an
    /// unread message, the run may start on an older page: no first until it
    /// loads, and the count is a lower bound.
    static func summary(in messages: [ChatMessage], unread: Set<String>, hasOlder: Bool, excluding stacked: Set<String> = []) -> UnreadSummary? {
        // The oldest message the main line shows: a reply a stack stands for, read in from an older thread, is not it.
        guard !unread.isEmpty, let oldest = messages.first(where: { !stacked.contains($0.id) }) else { return nil }
        let drawn = messages.filter { unread.contains($0.id) && !stacked.contains($0.id) && TranscriptBuilder.isReply($0, parts: $0.parts) }
        guard let first = drawn.first else { return nil }
        let oldestTurn = oldest.turnId ?? oldest.id
        let more = hasOlder && messages.contains { unread.contains($0.id) && ($0.turnId ?? $0.id) == oldestTurn }
        return UnreadSummary(firstId: more ? nil : first.id, count: drawn.count, more: more)
    }
}

/// The unread messages of a chat at open, as far as its loaded pages show them.
struct UnreadSummary: Equatable, Sendable {
    /// The first one the chat draws; nil while the run may start on an older page.
    var firstId: String?
    /// How many the chat draws among the loaded messages.
    var count: Int
    /// More wait on an older page: the count reads "N+".
    var more: Bool
}

/// When the "N new messages" pill shows. It appears once the unread line is
/// above the visible transcript (under the header counts), or not loaded
/// yet, and goes for good when tapped or when the line comes into view. A
/// line that stays in view from the open, because the unread messages fit
/// on screen, never shows it.
@MainActor
@Observable
final class UnreadPill {
    enum Phase: Equatable { case waiting, shown, done }

    private(set) var phase: Phase = .waiting
    /// How long a line in view must stay so before the pill gives up on it:
    /// cards and pictures that load late can still push it up out of view.
    @ObservationIgnored var settleDelay: Duration = .milliseconds(600)
    @ObservationIgnored private var settle: Task<Void, Never>?

    /// Where the line is against the visible transcript.
    func dividerAbove(_ above: Bool) {
        guard phase != .done else { return }
        if above {
            settle?.cancel()
            settle = nil
            if phase != .shown { phase = .shown }
            return
        }
        if phase == .shown {
            phase = .done
            return
        }
        guard settle == nil else { return }
        let delay = settleDelay
        settle = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled, self.phase == .waiting else { return }
            self.phase = .done
        }
    }

    func tapped() {
        settle?.cancel()
        settle = nil
        phase = .done
    }

    /// A new open of the chat.
    func reset() {
        settle?.cancel()
        settle = nil
        if phase != .waiting { phase = .waiting }
    }
}
