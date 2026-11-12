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
    /// kind (an app's own) shows none: the task chat's Open link reaches it.
    nonisolated static func card(messages: [ChatMessage], approvals: [PendingApproval], chatId: String) -> Card? {
        var open: [(key: String, messageId: String, part: JSONValue, date: Date)] = []
        for message in messages where message.role == "assistant" || message.role == "user" {
            guard let data = message.content.data(using: .utf8),
                  case .array(let parts)? = try? JSONDecoder().decode(JSONValue.self, from: data)
            else { continue }
            for (index, part) in parts.enumerated() {
                guard let type = part["type"]?.string, type == "pending_interaction" || type == "interaction_result",
                      let toolUseId = part["toolUseId"]?.string
                else { continue }
                open.removeAll { $0.part["toolUseId"]?.string == toolUseId }
                if type == "pending_interaction" { open.append(("\(message.id):\(index)", message.id, part, message.date)) }
            }
        }
        let latest = open.last
        let approval = approvals.filter { $0.chatId == chatId }.max { $0.createdAt < $1.createdAt }
        if let approval, latest.map({ approval.createdAt > $0.date }) ?? true {
            return .approval(approval)
        }
        guard let latest, latest.part["render"]?["componentId"]?.string == "question-card",
              case .question(var question) = MessagePart.parse(Self.json([latest.part])).first
        else { return nil }
        question.ui?.widgetId = latest.messageId
        return .question(question, key: latest.key)
    }

    private nonisolated static func json(_ parts: [JSONValue]) -> String {
        (try? String(data: JSONEncoder().encode(JSONValue.array(parts)), encoding: .utf8)) ?? "[]"
    }

    /// Sends the answer to the task chat. One the server already has
    /// refreshes the card; a network failure lets the guardian try again.
    func answer(_ part: MessagePart.QuestionPart, key: String, name: String, context: JSONValue) async {
        guard answering == nil, sent[key] == nil else { return }
        answering = key
        sent[key] = WidgetPaths.answerOutput(name, context)
        error = nil
        do {
            try await backend.answerWidget(widgetId: part.ui?.widgetId ?? "", name: name, context: context)
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
