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
    /// Tool calls fetched for an expanded tool summary, by trace message id.
    private(set) var toolCalls: [String: [ToolCall]] = [:]

    private var cursor: String?
    /// The order each message id was first received in.
    private var seen: [String: Int] = [:]
    private var tokens: [UUID] = []
    private var approvalPolls: [String: Task<Void, Never>] = [:]

    init(sessionId: String, kind: Kind, backend: RomeBackend) {
        self.sessionId = sessionId
        self.kind = kind
        self.backend = backend
    }

    var rows: [TranscriptRow] {
        var answers = TranscriptBuilder.answers(in: messages)
        answers.merge(localAnswers) { stored, _ in stored }
        return TranscriptBuilder.rows(
            messages: messages,
            pending: pending,
            answers: answers,
            options: .init(showTools: kind == .task, typing: kind == .concierge && running && visibleTurn)
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
            let gap = !messages.isEmpty && page.nextCursor != nil && !page.messages.contains { known.contains($0.id) }
            if gap {
                messages = []
                seen = [:]
                olderPage = nil
            }
            merge(page.messages)
            if !loaded || gap {
                cursor = page.nextCursor
                hasOlder = page.nextCursor != nil
            }
            loaded = true
            loadError = nil
            await refreshRunning()
        } catch let error as APIError {
            loadError = error
            loaded = true
        } catch {}
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
        olderPage = try? await backend.messages(sessionId: sessionId, before: cursor, limit: 40)
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

    /// Keeps the server's order: a turn's rows stay together, turns ordered by
    /// when they started, rows in a turn by time. Times are whole seconds, so
    /// rows written in the same second keep the order the server sent them in;
    /// the order never changes when the same rows arrive again.
    private func merge(_ incoming: [ChatMessage]) {
        var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in incoming {
            byID[message.id] = message
            if seen[message.id] == nil {
                seen[message.id] = seen.count
            }
        }
        let all = Array(byID.values)
        var turnStart: [String: Date] = [:]
        for message in all {
            let key = message.turnId ?? message.id
            turnStart[key] = min(turnStart[key] ?? message.date, message.date)
        }
        messages = all.sorted { a, b in
            let keyA = a.turnId ?? a.id, keyB = b.turnId ?? b.id
            let startA = turnStart[keyA]!, startB = turnStart[keyB]!
            if startA != startB { return startA < startB }
            if keyA != keyB { return keyA < keyB }
            if a.date != b.date { return a.date < b.date }
            return seen[a.id]! < seen[b.id]!
        }
        let stored = Set(messages.map(\.id))
        pending.removeAll { stored.contains($0.id) }
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
        case .reconnected:
            Task { await reload() }
        default:
            break
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
    func send(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let inputId = UUID().uuidString.lowercased()
        pending.append(PendingSend(id: inputId, text: trimmed, createdAt: .now, state: .sending))
        if kind == .concierge {
            markRunning()
            visibleTurn = true
        }
        deliver(inputId: inputId, text: trimmed)
        return true
    }

    func retry(_ id: String) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].state = .sending
        deliver(inputId: id, text: pending[index].text)
    }

    private func deliver(inputId: String, text: String) {
        Task {
            do {
                let turn = try await backend.send(
                    sessionId: sessionId,
                    text: text,
                    inputId: inputId,
                    priority: kind == .concierge ? .now : .next
                )
                if let index = pending.firstIndex(where: { $0.id == inputId }) {
                    pending[index].state = .sent
                }
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

    func answer(_ part: MessagePart.QuestionPart, values: [String: String]) {
        guard !answering.contains(part.toolUseId) else { return }
        let answers: [JSONValue] = part.questions.compactMap { question in
            guard let value = values[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return .object(["questionId": .string(question.id), "value": .string(value)])
        }
        guard !answers.isEmpty else { return }
        let output: JSONValue = .object(["answers": .array(answers)])
        answering.insert(part.toolUseId)
        localAnswers[part.toolUseId] = output
        Task {
            do {
                try await backend.answer(sessionId: sessionId, toolUseId: part.toolUseId, output: output)
                markRunning()
            } catch {
                localAnswers[part.toolUseId] = nil
            }
            answering.remove(part.toolUseId)
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
