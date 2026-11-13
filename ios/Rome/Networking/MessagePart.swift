import Foundation

/// One part of a stored message, sorted into what the app draws. A part type
/// this build does not know becomes a `.webOnly` row, so a newer server's card
/// never vanishes from the transcript.
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
    /// An app's card described as data (a `widget` part with `ui`), drawn here.
    case widgetUI(WidgetUIPart)
    /// A routine Chat proposed (`propose_routine`), shown read-only.
    case routineDraft(RoutineDraftPart)
    /// A part the web dashboard draws and this app does not: a row that opens
    /// the chat there. `toolUseId` names an interactive card, whose answer
    /// marks it done.
    case webOnly(WebOnlyKind, toolUseId: String? = nil)
    /// The guardian's answer to an interactive card.
    case interactionResult(toolUseId: String, output: JSONValue)
    /// A turn that failed before it ran.
    case error(String)
    /// Parts the web dashboard does not show in a transcript either (tool
    /// calls, thinking, usage, a reply's quote).
    case other(type: String)

    /// What a `.webOnly` row names, after the web component's own title.
    enum WebOnlyKind: Hashable, Sendable {
        /// The built-in card that connects Claude or ChatGPT.
        case aiTools
        /// The connector app's card that connects a service.
        case connectService
        /// The connector app's sign-in card.
        case connectorSignIn
        /// Another app's card, by app id.
        case app(String)
        /// A turn's recap (`turn_recap`).
        case turnSummary
        /// Chat moved to another model (`quota_switch`).
        case modelSwitch(model: String)
        /// A part type this build does not know.
        case unknown

        /// The row's text. `appName` names an app card's app when it is known.
        func title(appName: String? = nil) -> String {
            switch self {
            case .aiTools: return String(localized: "Connect Claude or ChatGPT")
            case .connectService: return String(localized: "A card to connect a service")
            case .connectorSignIn: return String(localized: "A sign-in card")
            case .app:
                if let appName, !appName.isEmpty { return String(localized: "A card from \(appName)") }
                return String(localized: "An app card")
            case .turnSummary: return String(localized: "A turn summary")
            case .modelSwitch(let model): return String(localized: "Switched to \(model)")
            case .unknown: return String(localized: "A card")
            }
        }
    }

    /// Part types the web dashboard hides from a transcript, or draws only as
    /// part of another one (a reply's quote in its bubble). The rest of the
    /// trace kinds are listed too, so a stored one never shows as a card.
    /// `handoff` and `submission_card` are legacy kinds the web drops.
    static let hiddenTypes: Set<String> = [
        "tool_use", "tool_result", "thinking", "result", "usage", "session_init",
        "turn_start", "turn_end", "structured_output", "system_input", "plan_update",
        "subagent_start", "subagent_result", "reply_to", "handoff", "submission_card",
    ]

    /// `routine_draft_card`: a routine Chat proposed, and the key it is created with.
    struct RoutineDraftPart: Hashable, Sendable {
        enum Trigger: Hashable, Sendable { case schedule, event, manual }

        let toolUseId: String
        let name: String
        /// One-line headline, such as "When you get an email from Dana, Rome will text you."
        let sentence: String
        /// When it runs, in words: "Every Friday at 9:00 AM" or "Gmail · new email".
        let watchLabel: String
        let filterSummary: String?
        /// What it does: the action's own preview title when it has one, else Chat's summary.
        let thenSummary: String
        let trigger: Trigger
        /// The key the routine is created with; nil on a card written before keys.
        let routineKey: String?
    }

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
        /// The card core described from the questions, which both apps draw.
        var ui: WidgetUIPart? = nil

        /// A question as the agent asked it; a card stored before cards were
        /// described shows these as a line.
        struct Question: Hashable, Sendable {
            let id: String
            let text: String
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
                var part = question(render?["props"], toolUseId: toolUseId)
                part.ui = WidgetUIPart(interaction: value)
                return .question(part)
            }
            // A card described as data, which the agent waits on, whether an
            // app's or core's own.
            if render?["ui"] != nil, let card = WidgetUIPart(interaction: value) {
                return .widgetUI(card)
            }
            return .webOnly(webOnlyKind(componentId: render?["componentId"]?.string, appId: value["appId"]?.string), toolUseId: value["toolUseId"]?.string)
        case "widget":
            // A widget that names a web component is drawn only on the web.
            if let card = WidgetUIPart(json: value) { return .widgetUI(card) }
            return .webOnly(value["appId"]?.string.map(WebOnlyKind.app) ?? .unknown)
        case "interaction_result":
            guard let toolUseId = value["toolUseId"]?.string else { return nil }
            return .interactionResult(toolUseId: toolUseId, output: value["output"] ?? .null)
        case "routine_draft_card":
            guard let draft = value["draft"], let name = draft["name"]?.string else { return .webOnly(.unknown) }
            return .routineDraft(routineDraft(draft, name: name, toolUseId: value["toolUseId"]?.string ?? "", key: value["routineKey"]?.string))
        case "turn_recap":
            return .webOnly(.turnSummary)
        case "quota_switch":
            guard let model = value["model"]?.string, !model.isEmpty else { return .webOnly(.unknown) }
            return .webOnly(.modelSwitch(model: model))
        case "error":
            return .error(value["error"]?.string ?? "")
        default:
            return hiddenTypes.contains(type) ? .other(type: type) : .webOnly(.unknown)
        }
    }

    private static func webOnlyKind(componentId: String?, appId: String?) -> WebOnlyKind {
        switch componentId {
        case "ai-tools-card": return .aiTools
        case "connect-card" where appId == "connector": return .connectService
        case "login-card" where appId == "connector": return .connectorSignIn
        default: return appId.map(WebOnlyKind.app) ?? .unknown
        }
    }

    private static func routineDraft(_ draft: JSONValue, name: String, toolUseId: String, key: String?) -> RoutineDraftPart {
        let trigger: RoutineDraftPart.Trigger
        switch draft["trigger"]?["type"]?.string {
        case "schedule": trigger = .schedule
        case "manual": trigger = .manual
        default: trigger = .event
        }
        // The action's own preview says what really fires; Chat's prose is the fallback.
        let preview = draft["preview"]
        var then = draft["thenSummary"]?.string ?? ""
        switch preview?["kind"]?.string {
        case "generic":
            if let title = preview?["title"]?.string, !title.isEmpty { then = title }
        case "sensitive_message":
            then = String(localized: "Send a message")
        default:
            break
        }
        let filter = draft["filterSummary"]?.string
        return RoutineDraftPart(
            toolUseId: toolUseId,
            name: name,
            sentence: draft["sentence"]?.string ?? "",
            watchLabel: draft["watchLabel"]?.string ?? "",
            filterSummary: filter?.isEmpty == false ? filter : nil,
            thenSummary: then,
            trigger: trigger,
            routineKey: key
        )
    }

    /// An approval as a card shows it, from a stored `approval_card` part or
    /// an approval row's payload (`actionName`, `preview`, `status`).
    static func approval(_ value: JSONValue, id: String) -> ApprovalPart {
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
            return .init(id: id, text: text)
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
