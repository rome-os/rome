import Foundation
import Observation

/// What a waiting task asks the guardian, shown inside its task card in the
/// main Chat, as the dashboard shows it (rome-os/rome#1949). The task chat
/// owns the card: answers and approvals go to it, and the main Chat's own
/// stream is never involved.
@MainActor
@Observable
final class TaskWaitStore {
    /// The card a waiting task shows inline.
    enum Card: Equatable {
        /// Its latest open question, by the message part's key.
        case question(MessagePart.QuestionPart, key: String)
        case approval(PendingApproval)
        /// An app's own card, answered only in the task chat.
        case elsewhere
    }

    let chatId: String
    private(set) var card: Card?
    private(set) var loaded = false
    /// The answer being sent, by the card's key.
    private(set) var answering: String?
    /// Answers sent this session, before the task's next page shows them.
    private(set) var sent: [String: JSONValue] = [:]
    private(set) var error: String?
    private(set) var approvalRecord: ApprovalRecord?
    private(set) var resolving: Bool?

    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private var loads = 0

    init(chatId: String, backend: RomeBackend) {
        self.chatId = chatId
        self.backend = backend
    }

    /// Reads the task's last two turns and the pending approvals, once per
    /// call: there is no polling, the task's live state asks again. A read
    /// that fails keeps the card already shown, so its controls stay for a
    /// retry; only a read that answers can clear it.
    func load() async {
        loads += 1
        let mine = loads
        async let page = try? backend.messages(sessionId: chatId, before: nil, limit: 2)
        async let approvals = try? backend.pendingApprovals()
        let messages = await page?.messages
        let pending = await approvals
        guard mine == loads else { return }
        guard case .set(let next) = Self.update(card, messages: messages, approvals: pending, chatId: chatId) else {
            loaded = true
            return
        }
        card = next
        if case .approval(let approval) = card {
            approvalRecord = try? await backend.approval(id: approval.id)
        } else {
            approvalRecord = nil
        }
        loaded = true
    }

    /// What a load does to the card. A failed read (nil) keeps it.
    enum Update: Equatable {
        case keep
        case set(Card?)
    }

    /// The task's page decides; the approvals read is optional (a visitor's
    /// is refused), so without it a shown approval stays and questions
    /// still update.
    nonisolated static func update(_ current: Card?, messages: [ChatMessage]?, approvals: [PendingApproval]?, chatId: String) -> Update {
        guard let messages else { return .keep }
        if approvals == nil, case .approval = current { return .keep }
        return .set(card(messages: messages, approvals: approvals ?? [], chatId: chatId))
    }

    /// The task's open card: its latest open question, or a pending approval
    /// asked after it. A result closes only the cards before it, since a
    /// later turn can reuse a tool-call id. A latest open card of another
    /// kind (an app's own) is answered in the task chat.
    nonisolated static func card(messages: [ChatMessage], approvals: [PendingApproval], chatId: String) -> Card? {
        var open: [(key: String, part: JSONValue, date: Date)] = []
        for message in messages where message.role == "assistant" || message.role == "user" {
            guard let data = message.content.data(using: .utf8),
                  case .array(let parts)? = try? JSONDecoder().decode(JSONValue.self, from: data)
            else { continue }
            for (index, part) in parts.enumerated() {
                guard let type = part["type"]?.string, type == "pending_interaction" || type == "interaction_result",
                      let toolUseId = part["toolUseId"]?.string
                else { continue }
                open.removeAll { $0.part["toolUseId"]?.string == toolUseId }
                if type == "pending_interaction" { open.append(("\(message.id):\(index)", part, message.date)) }
            }
        }
        let latest = open.last
        let approval = approvals.filter { $0.chatId == chatId }.max { $0.createdAt < $1.createdAt }
        if let approval, latest.map({ approval.createdAt > $0.date }) ?? true {
            return .approval(approval)
        }
        guard let latest else { return nil }
        guard latest.part["render"]?["componentId"]?.string == "question-card",
              case .question(let question) = MessagePart.parse(Self.json([latest.part])).first
        else { return .elsewhere }
        return .question(question, key: latest.key)
    }

    private nonisolated static func json(_ parts: [JSONValue]) -> String {
        (try? String(data: JSONEncoder().encode(JSONValue.array(parts)), encoding: .utf8)) ?? "[]"
    }

    // MARK: Settled

    /// What the task asked by a card's time, and how it ended, by that time.
    private(set) var settled: [Date: SettledAsk] = [:]
    /// Times whose read finished, with or without a card found.
    private(set) var settledRead: Set<Date> = []

    /// Reads the task chat back to `until` and a page before, so the
    /// question or approval open then, and every answer since, are held;
    /// then an approval's record, which alone knows how it ended.
    func loadSettled(until: Date) async {
        var held: [ChatMessage] = []
        var before: String?
        var crossed = false
        for _ in 0..<Self.pagesBack {
            guard let page = try? await backend.messages(sessionId: chatId, before: before, limit: 2) else { break }
            held.insert(contentsOf: page.messages, at: 0)
            // One page past the card's time holds the question it showed.
            guard !crossed, let cursor = page.nextCursor, let oldest = page.messages.first else { break }
            crossed = oldest.date <= until
            before = cursor
        }
        defer { settledRead.insert(until) }
        guard var ask = Self.asked(messages: held, until: until) else { return }
        if case .approval(let part, _) = ask.kind {
            ask.kind = .approval(part, record: try? await backend.approval(id: part.approvalId))
        }
        settled[until] = ask
    }

    /// Pages of a task chat read at most, going back to a card's time.
    nonisolated static let pagesBack = 5

    /// The newest question or approval the task asked by `until`, with the
    /// answer given to it since. Results close only cards before them, as
    /// a later turn can reuse a tool-call id.
    nonisolated static func asked(messages: [ChatMessage], until: Date) -> SettledAsk? {
        var asked: (kind: SettledAsk.Kind, date: Date)?
        var answers: [String: (output: JSONValue, date: Date)] = [:]
        for message in messages where message.role == "assistant" || message.role == "user" {
            for part in message.parts {
                switch part {
                case .interactionResult(let toolUseId, let output):
                    answers[toolUseId] = (output, message.date)
                case .question(let question) where message.date <= until:
                    if asked.map({ message.date >= $0.date }) ?? true {
                        asked = (.question(question, answer: nil), message.date)
                    }
                case .approval(let approval) where message.date <= until:
                    if asked.map({ message.date >= $0.date }) ?? true {
                        asked = (.approval(approval, record: nil), message.date)
                    }
                default:
                    break
                }
            }
        }
        guard let asked else { return nil }
        if case .question(let question, _) = asked.kind,
           let answer = answers[question.toolUseId], answer.date >= asked.date {
            return SettledAsk(kind: .question(question, answer: answer.output))
        }
        return SettledAsk(kind: asked.kind)
    }

    /// Sends the answer to the task chat. One the server already has
    /// refreshes the card; a network failure lets the guardian try again.
    func answer(_ part: MessagePart.QuestionPart, key: String, answers: [JSONValue]) async {
        guard answering == nil, sent[key] == nil else { return }
        let output: JSONValue = .object(["answers": .array(answers)])
        answering = key
        sent[key] = output
        error = nil
        do {
            try await backend.answer(sessionId: chatId, toolUseId: part.toolUseId, output: output)
        } catch APIError.server(let status, _) where status == 400 {
            sent[key] = nil
            error = String(localized: "This card was already answered. The task has been refreshed.")
        } catch {
            sent[key] = nil
            self.error = String(localized: "Could not send. Please try again.")
        }
        answering = nil
        await load()
    }

    func resolve(approve: Bool) async {
        guard case .approval(let approval) = card, resolving == nil else { return }
        resolving = approve
        error = nil
        do {
            try await backend.resolveApproval(id: approval.id, approve: approve)
        } catch {
            self.error = String(localized: "Could not submit")
        }
        resolving = nil
        await load()
    }
}

/// A task's question or approval that no longer waits, as its folded card
/// shows it: what it asked, then how it ended.
struct SettledAsk: Equatable {
    enum Kind: Equatable {
        /// `answer`: nil while it is open, which a newer copy below shows.
        case question(MessagePart.QuestionPart, answer: JSONValue?)
        /// `record`: nil until read, or when it cannot be.
        case approval(MessagePart.ApprovalPart, record: ApprovalRecord?)
    }

    var kind: Kind

    var title: String {
        switch kind {
        case .question(let part, _): return SettledOutcome.title(part)
        case .approval(let part, _): return SettledOutcome.title(part)
        }
    }

    /// "Answered: Tea", "Approved", or "Waiting: answer the card below"
    /// while it is still open.
    var outcome: String {
        switch kind {
        case .question(_, let answer?):
            return SettledOutcome.answer(answer)
        case .approval(_, let record?) where ApprovalStatus.derive(stored: nil, record: record) != .pending:
            return SettledOutcome.approval(ApprovalStatus.derive(stored: nil, record: record), resolvedBy: record.resolvedBy)
        default:
            return String(localized: "Waiting: answer the card below")
        }
    }
}

/// The words of a folded question or approval card (docs/domains/chats.md).
enum SettledOutcome {
    /// An answer this long or shorter is repeated on the fold.
    static let shortAnswer = 24

    /// What a question card asked, its questions on one line.
    static func title(_ part: MessagePart.QuestionPart) -> String {
        part.questions.map(\.text).joined(separator: " · ")
    }

    static func title(_ part: MessagePart.ApprovalPart) -> String {
        part.title.flatMap { $0.isEmpty ? nil : $0 } ?? displayActionName(part.actionName)
    }

    /// "Answered: Tea" for a short answer, "Answered" for a long one, or
    /// "Dismissed".
    static func answer(_ output: JSONValue) -> String {
        if output["dismissed"]?.bool == true { return String(localized: "Dismissed") }
        let values = (output["answers"]?.array ?? [])
            .compactMap { $0["value"]?.string }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let text = values.joined(separator: ", ")
        guard !text.isEmpty, text.count <= shortAnswer else { return String(localized: "Answered") }
        return String(localized: "Answered: \(text)")
    }

    /// Whether an approval with this status folds: decided, and not failed,
    /// which keeps its own card.
    static func folds(_ status: ApprovalStatus) -> Bool {
        status != .pending && status != .failed
    }

    /// How a decided approval ended: approved, rejected by the guardian, or
    /// turned down by Rome as its task's wait ran out or its task stopped.
    static func approval(_ status: ApprovalStatus, resolvedBy: String?) -> String {
        if resolvedBy == "rome:task-ended" { return String(localized: "Turned down: no answer within a day") }
        if resolvedBy == "rome:task-stopped" { return String(localized: "Turned down: task stopped") }
        switch status {
        case .rejected: return String(localized: "Rejected")
        case .failed: return String(localized: "Approved, but did not finish")
        default: return String(localized: "Approved")
        }
    }
}
