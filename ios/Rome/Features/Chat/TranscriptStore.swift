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
    private(set) var hasOlder = false
    /// The chat is running a turn.
    private(set) var running = false
    /// The running turn is one the guardian should see as typing (not a quiet background turn).
    private(set) var visibleTurn = false
    private(set) var activeTurnId: String?
    private(set) var stopping = false
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

    /// The first message the guardian wrote, which for a task chat is the brief from Concierge.
    var brief: ChatMessage? {
        messages.first { $0.isUser && $0.parts.contains { $0.textContent != nil } }
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
            merge(page.messages)
            cursor = page.nextCursor
            hasOlder = page.nextCursor != nil
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

    func loadOlder() async {
        guard hasOlder, !loadingOlder, let cursor else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await backend.messages(sessionId: sessionId, before: cursor, limit: 40)
            merge(page.messages)
            self.cursor = page.nextCursor
            hasOlder = page.nextCursor != nil
        } catch {}
    }

    func markRead() {
        Task { await backend.markRead(sessionId: sessionId) }
    }

    private func merge(_ incoming: [ChatMessage]) {
        var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in incoming { byID[message.id] = message }
        messages = byID.values.sorted { $0.date < $1.date }
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
            running = false
            visibleTurn = false
            activeTurnId = nil
            stopping = false
            return
        }
        guard let turns = try? await backend.activeTurns(sessionId: sessionId) else {
            if let hint { running = hint }
            return
        }
        running = !turns.isEmpty
        visibleTurn = turns.contains { $0.quiet != true }
        activeTurnId = turns.first { $0.status == "running" }?.turnId ?? turns.first?.turnId
        if !running { stopping = false }
    }

    // MARK: Sending

    @discardableResult
    func send(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let inputId = UUID().uuidString.lowercased()
        pending.append(PendingSend(id: inputId, text: trimmed, createdAt: .now, state: .sending))
        if kind == .concierge {
            running = true
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
                    running = true
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
            }
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
            self?.approvalPolls[id] = nil
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
                approvalErrors[id] = "没有提交成功。"
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
                running = true
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
