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
    /// Chat asks the guardian to connect a service.
    case connectCard(ConnectCardPart)
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
            /// Options chosen before the guardian touches anything; still editable.
            var defaults: [String] = []
            /// A text question's prefilled answer; still editable.
            var defaultText: String? = nil
            /// A muted line under an option's label, by label. Answers send labels only.
            var optionDescriptions: [String: String] = [:]
            /// May be left blank without blocking Submit.
            var optional = false
        }
    }

    /// `connect_card`: a service to connect, and how a client starts it.
    struct ConnectCardPart: Hashable, Sendable {
        let service: String
        let label: String
        /// `brand:<kind>` or `glyph:<id>`; nil on a card written before it existed.
        let icon: String?
        let connect: ConnectEntry
    }

    /// How a client starts connecting a service (`ConciergeConnectEntry`).
    enum ConnectEntry: Hashable, Sendable {
        /// Rome Cloud's sign-in for the service, at `url`.
        case romeOAuth(url: String?, available: Bool, unavailableReason: String?)
        /// One call on this Rome that answers a link, after a Composio sign-in when `needsLogin`.
        case composio(method: String, path: String, body: JSONValue, needsLogin: Bool, login: (method: String, path: String)?)
        /// The dashboard's Connections page is the only way in.
        case dashboard

        static func == (lhs: ConnectEntry, rhs: ConnectEntry) -> Bool { lhs.hashKey == rhs.hashKey }
        func hash(into hasher: inout Hasher) { hasher.combine(hashKey) }

        private var hashKey: String {
            switch self {
            case .romeOAuth(let url, let available, let reason): return "oauth|\(url ?? "")|\(available)|\(reason ?? "")"
            case .composio(let method, let path, let body, let needsLogin, let login):
                return "composio|\(method)|\(path)|\(body)|\(needsLogin)|\(login?.method ?? "")|\(login?.path ?? "")"
            case .dashboard: return "dashboard"
            }
        }

        /// Reads an entry; an unknown kind is the dashboard's, the way in that always works.
        init(json value: JSONValue?) {
            switch value?["kind"]?.string {
            case "rome_oauth":
                self = .romeOAuth(
                    url: value?["url"]?.string,
                    available: value?["available"]?.bool ?? false,
                    unavailableReason: value?["unavailableReason"]?.string
                )
            case "composio":
                let login = value?["login"]
                self = .composio(
                    method: value?["method"]?.string ?? "POST",
                    path: value?["path"]?.string ?? "",
                    body: value?["body"] ?? .object([:]),
                    needsLogin: value?["needsLogin"]?.bool ?? false,
                    login: login?["path"]?.string.map { (method: login?["method"]?.string ?? "POST", path: $0) }
                )
            default:
                self = .dashboard
            }
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
        case "connect_card":
            guard let service = value["service"]?.string, !service.isEmpty else { return nil }
            return .connectCard(ConnectCardPart(
                service: service,
                label: value["label"]?.string ?? service,
                icon: value["icon"]?.string,
                connect: ConnectEntry(json: value["connect"])
            ))
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
                fields.append(.init(label: String(localized: "Channel"), value: channel))
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
            let options = (item["options"]?.array ?? []).compactMap(\.string)
            // Every field from #1793 is optional, and only what names a real option counts.
            var defaults: [String] = []
            for value in item["defaults"]?.array?.compactMap(\.string) ?? [] where options.contains(value) && !defaults.contains(value) {
                defaults.append(value)
            }
            if type != "multi" { defaults = Array(defaults.prefix(1)) }
            var descriptions: [String: String] = [:]
            if case .object(let map) = item["optionDescriptions"] {
                for (label, text) in map where options.contains(label) {
                    if let text = text.string, !text.isEmpty { descriptions[label] = text }
                }
            }
            return .init(
                id: id,
                text: text,
                multi: type == "multi",
                freeTextOnly: type == "text",
                options: options,
                defaults: type == "text" ? [] : defaults,
                defaultText: type == "text" ? item["defaultText"]?.string : nil,
                optionDescriptions: type == "text" ? [:] : descriptions,
                optional: item["optional"]?.bool ?? false
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
    guard let name, !name.isEmpty else { return String(localized: "Run action") }
    let local = name.split(separator: ":").last.map(String.init) ?? name
    return local.replacingOccurrences(of: "_", with: " ")
}

/// A question card's answers, as the web's QuestionCard builds them. A multi
/// answer joins its chosen options, then any typed extra, with `", "`, and
/// keeps the parts as `values` when a label holds that separator, so nothing
/// is lost splitting it back. Answers carry labels, never descriptions.
enum QuestionAnswers {
    static let separator = ", "

    typealias Question = MessagePart.QuestionPart.Question

    /// The card before the guardian touches it: defaults chosen, default text typed.
    static func initial(_ questions: [Question]) -> (choices: [String: [String]], typed: [String: String]) {
        var choices: [String: [String]] = [:]
        var typed: [String: String] = [:]
        for question in questions {
            if !question.defaults.isEmpty { choices[question.id] = question.multi ? question.defaults : [question.defaults[0]] }
            if let text = question.defaultText { typed[question.id] = text }
        }
        return (choices, typed)
    }

    /// A required question needs an option chosen or something typed; a default counts.
    static func isAnswered(_ question: Question, choices: [String: [String]], typed: [String: String]) -> Bool {
        let text = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !(choices[question.id] ?? []).isEmpty || !text.isEmpty
    }

    static func complete(_ questions: [Question], choices: [String: [String]], typed: [String: String]) -> Bool {
        questions.allSatisfy { $0.optional || isAnswered($0, choices: choices, typed: typed) }
    }

    /// The `answers` the card sends; blank ones (optional questions) are left out.
    static func answers(_ questions: [Question], choices: [String: [String]], typed: [String: String]) -> [JSONValue] {
        questions.compactMap { question in
            let text = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if question.multi {
                let picked = question.options.filter { (choices[question.id] ?? []).contains($0) }
                let parts = picked + (text.isEmpty ? [] : [text])
                guard !parts.isEmpty else { return nil }
                var answer: [String: JSONValue] = [
                    "questionId": .string(question.id),
                    "value": .string(parts.joined(separator: separator)),
                ]
                if parts.contains(where: { $0.contains(separator) }) { answer["values"] = .array(parts.map(JSONValue.string)) }
                return .object(answer)
            }
            // A single choice or a text answer: what was typed wins over a choice.
            let value = text.isEmpty ? (choices[question.id]?.first ?? "") : text
            guard !value.isEmpty else { return nil }
            return .object(["questionId": .string(question.id), "value": .string(value)])
        }
    }

    /// A stored answer read back: the options it chose and any typed extra.
    static func picked(_ answer: JSONValue?, question: Question) -> (options: Set<String>, extra: [String]) {
        guard let answer else { return ([], []) }
        let parts: [String]
        if let values = answer["values"]?.array?.compactMap(\.string) {
            parts = values
        } else {
            let value = answer["value"]?.string ?? ""
            parts = question.multi
                ? value.components(separatedBy: separator).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                : (value.isEmpty ? [] : [value])
        }
        return (Set(parts.filter(question.options.contains)), parts.filter { !question.options.contains($0) })
    }
}
