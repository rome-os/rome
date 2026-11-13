import Foundation

/// The question or approval a `task_chat` part shows, and how it ended, as the
/// instance fills it in each time it hands the message out (`card` on the
/// wire). The app draws a card from this alone: it never reads the task chat.
struct TaskAskCard: Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        case question(Question)
        case approval(Approval)
        /// A card the instance could not find, as when its task chat is gone.
        case unavailable
    }

    struct Question: Hashable, Sendable {
        /// The tool use id the answer is sent to.
        let id: String
        /// The message that holds it: the id core knows the question card by.
        var messageId: String? = nil
        let render: JSONValue?
        let since: Double
        /// Nobody answered it in time: its task ended for no response, and it takes an answer still.
        let expired: Bool
        let outcome: QuestionOutcome?
    }

    enum QuestionOutcome: Hashable, Sendable {
        /// `output` is what the card sent (`answers`, or `dismissed`).
        case answered(output: JSONValue)
        case dismissed

        /// The output as the folded line reads it.
        var output: JSONValue {
            switch self {
            case .answered(let output): return output
            case .dismissed: return .object(["dismissed": .bool(true)])
            }
        }
    }

    struct Approval: Hashable, Sendable {
        let id: String
        let title: String
        let actionName: String?
        let preview: JSONValue?
        let since: Double
        let outcome: ApprovalOutcome?
    }

    enum ApprovalOutcome: Hashable, Sendable {
        case approved
        case rejected
        case turnedDown(NoResponse)

        enum NoResponse: String, Hashable, Sendable { case noResponse = "no_response", taskStopped = "task_stopped" }
    }

    let kind: Kind

    init(kind: Kind) { self.kind = kind }

    /// Reads a `card`; nil for a kind this build does not know.
    init?(json: JSONValue?) {
        guard let json, let kind = json["kind"]?.string else { return nil }
        switch kind {
        case "question":
            guard let id = json["id"]?.string else { return nil }
            var outcome: QuestionOutcome?
            switch json["outcome"]?["kind"]?.string {
            case "answered": outcome = .answered(output: json["outcome"]?["answer"]?["output"] ?? .object([:]))
            case "dismissed": outcome = .dismissed
            default: break
            }
            self.kind = .question(Question(
                id: id,
                messageId: json["messageId"]?.string,
                render: json["render"],
                since: json["since"]?.number ?? 0,
                expired: json["expired"]?.bool ?? false,
                outcome: outcome
            ))
        case "approval":
            guard let id = json["id"]?.string else { return nil }
            var outcome: ApprovalOutcome?
            switch json["outcome"]?["kind"]?.string {
            case "approved": outcome = .approved
            case "rejected": outcome = .rejected
            case "turned_down": outcome = .turnedDown(json["outcome"]?["reason"]?.string.flatMap(ApprovalOutcome.NoResponse.init) ?? .noResponse)
            default: break
            }
            self.kind = .approval(Approval(
                id: id,
                title: json["title"]?.string ?? "",
                actionName: json["actionName"]?.string,
                preview: json["preview"],
                since: json["since"]?.number ?? 0,
                outcome: outcome
            ))
        case "unavailable":
            self.kind = .unavailable
        default:
            return nil
        }
    }

    /// The id the card's question or approval has.
    var id: String? {
        switch kind {
        case .question(let question): return question.id
        case .approval(let approval): return approval.id
        case .unavailable: return nil
        }
    }

    /// Whether it ended: answered, dismissed, decided or turned down.
    var settled: Bool {
        switch kind {
        case .question(let question): return question.outcome != nil
        case .approval(let approval): return approval.outcome != nil
        case .unavailable: return false
        }
    }

    /// Whether it is an open, expired question (it takes an answer, yet waits on no one).
    var expired: Bool {
        if case .question(let question) = kind { return question.outcome == nil && question.expired }
        return false
    }

    /// The question's form, when its render is the built-in question card;
    /// nil for an app's own card, which is answered in its task chat.
    var questionPart: MessagePart.QuestionPart? {
        guard case .question(let question) = kind, question.render?["componentId"]?.string == "question-card" else { return nil }
        let part: JSONValue = .object(["type": .string("pending_interaction"), "toolUseId": .string(question.id), "appId": .string("core"), "render": question.render ?? .null])
        guard let data = try? JSONEncoder().encode(JSONValue.array([part])),
              let content = String(data: data, encoding: .utf8),
              case .question(var form)? = MessagePart.parse(content).first
        else { return nil }
        if let messageId = question.messageId { form.ui?.widgetId = messageId }
        return form
    }

    /// The approval as the approval card draws it.
    var approvalPart: MessagePart.ApprovalPart? {
        guard case .approval(let approval) = kind else { return nil }
        var json: [String: JSONValue] = [:]
        if let name = approval.actionName { json["actionName"] = .string(name) }
        if let preview = approval.preview { json["preview"] = preview }
        let part = MessagePart.approval(.object(json), id: approval.id)
        // Without a preview of its own the card is titled by what it asks.
        if part.title == nil, !approval.title.isEmpty {
            return .init(approvalId: part.approvalId, actionName: part.actionName, title: approval.title, summary: part.summary, fields: part.fields, storedStatus: nil)
        }
        return part
    }

    /// The words an ended approval folds to.
    static func outcomeLine(_ outcome: ApprovalOutcome) -> String {
        switch outcome {
        case .approved: return String(localized: "Approved")
        case .rejected: return String(localized: "Rejected")
        case .turnedDown(.noResponse): return String(localized: "Turned down: no answer within a day")
        case .turnedDown(.taskStopped): return String(localized: "Turned down: task stopped")
        }
    }

    /// `content` (a message's stored parts) with `card` put in place of the
    /// card of every `task_chat` part that shows the same question or
    /// approval; nil when no part does. The live event `chat_card_settled`.
    static func settling(content: String, with card: JSONValue) -> String? {
        guard let kind = card["kind"]?.string, let id = card["id"]?.string else { return nil }
        return patching(content: content, kind: kind, id: id) { $0 = card }
    }

    /// `content` with `outcome` set on the card of every part that shows the
    /// question or approval `id`, for an answer or a decision the instance
    /// has taken and not yet announced.
    static func settling(content: String, kind: String, id: String, outcome: JSONValue) -> String? {
        patching(content: content, kind: kind, id: id) { card in
            guard case .object(var map) = card else { return }
            map["outcome"] = outcome
            card = .object(map)
        }
    }

    private static func patching(content: String, kind: String, id: String, _ change: (inout JSONValue) -> Void) -> String? {
        guard content.contains("\"task_chat\""),
              let data = content.data(using: .utf8),
              case .array(var parts)? = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return nil }
        var changed = false
        for index in parts.indices {
            guard case .object(var part) = parts[index], part["type"]?.string == "task_chat",
                  var card = part["card"], card["kind"]?.string == kind, card["id"]?.string == id
            else { continue }
            change(&card)
            part["card"] = card
            parts[index] = .object(part)
            changed = true
        }
        guard changed, let out = try? JSONEncoder().encode(JSONValue.array(parts)) else { return nil }
        return String(data: out, encoding: .utf8)
    }
}
