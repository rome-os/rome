import Foundation

/// One part of a stored message, sorted into what the app draws. Unknown part
/// types fall into `.other`, so a newer server never breaks the transcript.
enum MessagePart: Hashable, Sendable {
    /// Markdown text. `long` messages read as a document; `forwardedFrom` marks a
    /// report forwarded word for word from a task chat.
    case text(String, long: Bool, forwardedFrom: ForwardedFrom?)
    /// A card for a task chat the Concierge started.
    case taskChat(chatId: String, title: String)
    /// An action paused for the guardian's approval.
    case approval(ApprovalPart)
    /// The agent asked the guardian a question (`ask_question`).
    case question(QuestionPart)
    /// Another kind of interactive card (an app component). Shown as a Web placeholder.
    case webOnly(kind: String)
    /// The guardian's answer to an interactive card.
    case interactionResult(toolUseId: String, output: JSONValue)
    /// A turn that failed before it ran.
    case error(String)
    /// Parts the app does not draw on its own (tool calls, thinking, usage).
    case other(type: String)

    struct ForwardedFrom: Hashable, Sendable {
        let chatId: String
        let title: String
    }

    struct ApprovalPart: Hashable, Sendable {
        let approvalId: String
        let actionName: String?
        let title: String?
        let summary: String?
        let fields: [Field]
        let storedStatus: String?

        struct Field: Hashable, Sendable {
            let label: String
            let value: String
        }
    }

    struct QuestionPart: Hashable, Sendable {
        let toolUseId: String
        let questions: [Question]

        struct Question: Hashable, Sendable {
            let id: String
            let text: String
            let multi: Bool
            let freeTextOnly: Bool
            let options: [String]
        }
    }

    /// Parses a message's stored content.
    static func parse(_ content: String) -> [MessagePart] {
        guard let data = content.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .array(let items) = value
        else {
            let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [.text(content, long: false, forwardedFrom: nil)]
        }
        return items.compactMap(part)
    }

    private static func part(_ value: JSONValue) -> MessagePart? {
        guard let type = value["type"]?.string else { return nil }
        switch type {
        case "text":
            let text = value["content"]?.string ?? value["text"]?.string ?? ""
            var forwarded: ForwardedFrom?
            if let chatId = value["forwardedFrom"]?["chatId"]?.string,
               let title = value["forwardedFrom"]?["title"]?.string {
                forwarded = ForwardedFrom(chatId: chatId, title: title)
            }
            return .text(text, long: value["format"]?.string == "long", forwardedFrom: forwarded)
        case "task_chat":
            guard let chatId = value["chatId"]?.string else { return nil }
            return .taskChat(chatId: chatId, title: value["title"]?.string ?? "")
        case "approval_card":
            guard let approvalId = value["approvalId"]?.string else { return nil }
            return .approval(approval(value, id: approvalId))
        case "pending_interaction":
            let render = value["render"]
            if render?["componentId"]?.string == "question-card",
               let toolUseId = value["toolUseId"]?.string {
                return .question(question(render?["props"], toolUseId: toolUseId))
            }
            return .webOnly(kind: render?["componentId"]?.string ?? type)
        case "interaction_result":
            guard let toolUseId = value["toolUseId"]?.string else { return nil }
            return .interactionResult(toolUseId: toolUseId, output: value["output"] ?? .null)
        case "handoff", "routine_draft_card", "submission_card":
            return .webOnly(kind: type)
        case "error":
            return .error(value["error"]?.string ?? "")
        default:
            return .other(type: type)
        }
    }

    private static func approval(_ value: JSONValue, id: String) -> ApprovalPart {
        let preview = value["preview"]
        var fields: [ApprovalPart.Field] = []
        var title: String?
        var summary: String?
        switch preview?["kind"]?.string {
        case "generic":
            title = preview?["title"]?.string
            summary = preview?["summary"]?.string
            fields = (preview?["fields"]?.array ?? []).compactMap { field in
                guard let label = field["label"]?.string, let value = field["value"]?.string else { return nil }
                return ApprovalPart.Field(label: label, value: value)
            }
        case "sensitive_message":
            summary = preview?["text"]?.string
            if let channel = preview?["channel"]?.string {
                fields.append(.init(label: "渠道", value: channel))
            }
        default:
            break
        }
        return ApprovalPart(
            approvalId: id,
            actionName: value["actionName"]?.string,
            title: title,
            summary: summary,
            fields: fields,
            storedStatus: value["status"]?.string
        )
    }

    private static func question(_ props: JSONValue?, toolUseId: String) -> QuestionPart {
        let questions: [QuestionPart.Question] = (props?["questions"]?.array ?? []).compactMap { item in
            guard let id = item["id"]?.string, let text = item["question"]?.string else { return nil }
            let type = item["type"]?.string
            return .init(
                id: id,
                text: text,
                multi: type == "multi",
                freeTextOnly: type == "text",
                options: (item["options"]?.array ?? []).compactMap(\.string)
            )
        }
        return QuestionPart(toolUseId: toolUseId, questions: questions)
    }
}

extension MessagePart {
    /// Whether the part shows something in a transcript.
    var isVisible: Bool {
        switch self {
        case .text(let text, _, _): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .other, .interactionResult: return false
        default: return true
        }
    }

    /// The text of a text part.
    var textContent: String? {
        if case .text(let text, _, _) = self { return text }
        return nil
    }
}

/// A human name for an action id such as `system:send_email` → "send email".
func displayActionName(_ name: String?) -> String {
    guard let name, !name.isEmpty else { return "执行操作" }
    let local = name.split(separator: ":").last.map(String.init) ?? name
    return local.replacingOccurrences(of: "_", with: " ")
}
