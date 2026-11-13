import Foundation

/// A message the guardian sent that the server has not stored yet.
struct PendingSend: Identifiable, Hashable, Sendable {
    /// `sent` means the server accepted it; the stored copy replaces it on the next load.
    enum State: Hashable, Sendable {
        case sending, sent
        case failed(SendFailure)
        /// Stored, and the instance records it as never handed to an agent.
        case notDelivered
        /// Stored, and the instance cannot tell whether an agent took it.
        case unconfirmed

        /// The message is on the instance: its row is a stored message's.
        var isStored: Bool { self == .notDelivered || self == .unconfirmed }
    }

    let id: String
    let text: String
    /// Photos sent with it.
    var images: [ComposerImage] = []
    let createdAt: Date
    var state: State
    /// Sent from a chat thread: a retry goes to the same thread.
    var thread: ThreadTarget? = nil
}

/// A photo in the guardian's bubble: the one being sent, or a stored upload.
enum UserImage: Hashable, Sendable {
    case local(ComposerImage)
    case stored(UploadLines.Upload)
}

/// Where a bubble sits in its run of same-sender bubbles. It decides the
/// small corner: the first bubble's bottom-left, the last bubble's top-left.
enum BubblePosition: Hashable, Sendable {
    case single, first, middle, last
}

/// One row of a transcript, ready to draw.
enum TranscriptRow: Identifiable, Hashable {
    case separator(id: String, date: Date)
    case userText(id: String, text: String, images: [UserImage] = [], pending: PendingSend.State?)
    case agentText(id: String, text: String, long: Bool, forwardedFrom: MessagePart.ForwardedFrom?, position: BubblePosition)
    /// `latest`: the newest card for that task chat, the only one that may
    /// show what the task waits on. `embedsWait`: a card from before
    /// `show`, which carries the task's question or approval inside.
    case taskCard(id: String, chatId: String, title: String, latest: Bool = false, embedsWait: Bool = true)
    case approval(id: String, part: MessagePart.ApprovalPart, sessionId: String)
    case question(id: String, part: MessagePart.QuestionPart, sessionId: String, answered: JSONValue?)
    /// `done`: an interactive card the guardian already answered.
    case webOnly(id: String, kind: MessagePart.WebOnlyKind, done: Bool = false)
    case routineDraft(id: String, part: MessagePart.RoutineDraftPart)
    case connect(id: String, part: MessagePart.ConnectCardPart, sessionId: String)
    case widgetUI(id: String, part: WidgetUIPart)
    case error(id: String, error: TurnError)
    /// A quiet line between messages, such as the chat moving to another model.
    case notice(id: String, text: String)
    case tools(id: String, traceMessageId: String, count: Int)
    /// A task's question or approval shown on its own (`show: "ask"`).
    /// `latest`: the newest card for that task chat, the only one that may
    /// take an answer; `shownAt`: when it was said, so a folded one tells the
    /// wait that was open then.
    case taskAsk(id: String, chatId: String, title: String, latest: Bool = false, shownAt: Date)
    /// Under a Concierge message in a task's chat thread: `↳ <task title>`,
    /// which opens the thread view (docs/domains/chats.md#chat-thread).
    case threadLabel(id: String, messageId: String, title: String)
    /// Under a Concierge reply to nobody's message: where its turn came from
    /// ("Routine · Daily summary"). Faint, not tappable.
    case sourceLabel(id: String, text: String)
    /// A faint centered line where the chat's agent session was renewed,
    /// with why; `sessionId` is the new session, whose handoff a tap opens.
    case sessionRenewal(id: String, reason: String, sessionId: String?)
    case typing

    var id: String {
        switch self {
        case .separator(let id, _), .userText(let id, _, _, _), .agentText(let id, _, _, _, _),
             .taskCard(let id, _, _, _, _), .taskAsk(let id, _, _, _, _), .approval(let id, _, _), .question(let id, _, _, _),
             .webOnly(let id, _, _), .routineDraft(let id, _), .connect(let id, _, _), .widgetUI(let id, _), .error(let id, _), .notice(let id, _), .tools(let id, _, _),
             .threadLabel(let id, _, _), .sourceLabel(let id, _), .sessionRenewal(let id, _, _):
            return id
        case .typing:
            return "typing"
        }
    }

    var isGuardian: Bool {
        if case .userText = self { return true }
        return false
    }

    /// The stored message a row was drawn from; nil for a pending send and
    /// rows of no one message.
    var messageId: String? {
        switch self {
        case .userText(let id, _, _, let pending):
            return pending == nil || pending?.isStored == true ? Self.message(ofPart: id) : nil
        case .agentText(let id, _, _, _, _):
            return Self.message(ofPart: id)
        case .threadLabel(_, let messageId, _):
            return messageId
        default:
            return nil
        }
    }

    /// A part row's id is `<message id>:<part index>`.
    static func message(ofPart id: String) -> String? {
        guard let colon = id.lastIndex(of: ":") else { return nil }
        return String(id[..<colon])
    }
}

/// Turns stored messages into rows. Messages from one sender less than five
/// minutes apart form a group; a gap of fifteen minutes or a new day gets a
/// time separator, which also ends the group.
enum TranscriptBuilder {
    static let groupGap: TimeInterval = 5 * 60
    static let separatorGap: TimeInterval = 15 * 60

    struct Options {
        /// Task chats show their tool summaries; Concierge has none.
        var showTools = false
        /// A Concierge chat's timeline labels each Concierge message in a
        /// task's chat thread with the task; the thread view does not.
        var showThreads = false
        /// Concierge chats show a line for automated input and for a renewed
        /// session, where the turn they belong to starts.
        var showNotices = false
        var typing = false
    }

    static func rows(
        messages: [ChatMessage],
        pending: [PendingSend],
        answers: [String: JSONValue],
        options: Options,
        calendar: Calendar = .current
    ) -> [TranscriptRow] {
        struct Entry {
            let id: String
            let date: Date
            let guardian: Bool
            let rows: [TranscriptRow]
            /// Rows that are text bubbles take part in the corner shapes.
            let bubbleIndexes: [Int]
            /// A faint line of its own, which ends a run of bubbles.
            var notice = false
        }

        var entries: [Entry] = []
        // A stored message replaces the pending bubble it came from.
        let storedIDs = Set(messages.map(\.id))
        let labels = options.showThreads ? threadLabels(messages) : [:]
        // Each message's parts, read once.
        let parsed = messages.map(\.parts)
        // The turns whose reply is an error part.
        var storedErrors = Set<String>()
        // The turns that answer a message the guardian wrote.
        var guardianTurns = Set<String>()
        for (message, parts) in zip(messages, parsed) {
            guard let turn = message.turnId else { continue }
            if message.isUser { guardianTurns.insert(turn) }
            if !message.isTrace, parts.contains(where: { if case .error = $0 { true } else { false } }) { storedErrors.insert(turn) }
        }
        // Whether an agent message of a later turn says something a guardian
        // reads: the Chat recovered from the failure (a switch of model, a retry).
        // What the failed turn said before it failed does not count.
        var recovered = [Bool](repeating: false, count: messages.count)
        var seenTurns: [String?] = []
        for index in messages.indices.reversed() {
            let turn = messages[index].turnId
            recovered[index] = seenTurns.contains { $0 != turn }
            if Self.isReply(messages[index], parts: parsed[index]), seenTurns.count < 2, !seenTurns.contains(where: { $0 == turn }) {
                seenTurns.append(turn)
            }
        }

        // A turn's lines stand before its first message; a turn that shows
        // nothing else, as an automated input the Concierge answers with
        // silence, gets them where its trace sits.
        var summaries: [String: TraceSummary] = [:]
        if options.showNotices {
            for message in messages where message.isTrace {
                if let turn = message.turnId, let summary = message.traceSummary { summaries[turn] = summary }
            }
        }
        var noticed = Set<String>()
        func notices(for message: ChatMessage) {
            guard options.showNotices, let turn = message.turnId, let summary = summaries[turn], noticed.insert(turn).inserted else { return }
            for row in Self.noticeRows(turn: turn, summary: summary) {
                entries.append(Entry(id: row.id, date: message.date, guardian: false, rows: [row], bubbleIndexes: [], notice: true))
            }
        }

        // The turns the Concierge began on its own, with where each came from:
        // by the turn's trace, or, from before, by an automated message that began it.
        var unprompted: [String: TraceSummary.InputSource] = [:]
        if options.showNotices {
            for message in messages {
                guard let turn = message.turnId else { continue }
                if message.isTrace, let source = message.traceSummary?.automatedInput { unprompted[turn] = source }
            }
            for message in messages where Self.isAutomated(message) {
                guard let turn = message.turnId, unprompted[turn] == nil, let sender = message.sender else { continue }
                unprompted[turn] = TraceSummary.InputSource(type: sender.sourceType ?? "automation", name: sender.name)
            }
        }

        // Messages come in the store's order, which follows the server's turns.
        for (position, message) in messages.enumerated() {
            notices(for: message)
            // A Concierge chat holds no automated messages: one from before that
            // rule, said on the owner's behalf or not, draws nothing. What the
            // Concierge answers it with shows as it always did.
            if options.showNotices, Self.isAutomated(message) { continue }
            if message.isTrace {
                var rows: [TranscriptRow] = []
                if options.showTools, let steps = message.traceSummary?.totalSteps, steps > 0 {
                    rows.append(.tools(id: "tools-\(message.id)", traceMessageId: message.id, count: steps))
                }
                // A turn that failed mid-run leaves only its trace: the line says why.
                // A turn that failed before it ran stored its error as a reply, which says it.
                // In the Chat, only a turn that answers the guardian's own message gets
                // one: a failed routine, digest or recovery turn is not theirs to read.
                let theirs = options.showTools || (message.turnId.map(guardianTurns.contains) ?? false)
                if theirs, !recovered[position], let error = failure(of: message, storedErrors: storedErrors) {
                    rows.append(.error(id: "failed-\(message.id)", error: error))
                }
                if !rows.isEmpty {
                    entries.append(Entry(id: message.id, date: message.date, guardian: false, rows: rows, bubbleIndexes: []))
                }
                continue
            }
            var rows: [TranscriptRow] = []
            var bubbles: [Int] = []
            for (index, part) in parsed[position].enumerated() {
                let id = "\(message.id):\(index)"
                switch part {
                case .text(let text, let long, let forwarded):
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    if message.isUser {
                        let (body, uploads) = UploadLines.split(text)
                        rows.append(.userText(id: id, text: body, images: uploads.map(UserImage.stored), pending: PendingSend.State.stored(inputState: message.inputState)))
                    } else {
                        bubbles.append(rows.count)
                        rows.append(.agentText(id: id, text: text, long: long, forwardedFrom: forwarded, position: .single))
                    }
                case .taskChat(let chatId, let title, .ask):
                    rows.append(.taskAsk(id: id, chatId: chatId, title: title, shownAt: message.date))
                case .taskChat(let chatId, let title, let show):
                    rows.append(.taskCard(id: id, chatId: chatId, title: title, embedsWait: show == nil))
                case .approval(let approval):
                    rows.append(.approval(id: id, part: approval, sessionId: message.sessionId))
                case .question(let question):
                    rows.append(.question(id: id, part: question, sessionId: message.sessionId, answered: answers[question.toolUseId]))
                case .webOnly(let kind, let toolUseId):
                    rows.append(.webOnly(id: id, kind: kind, done: toolUseId.map { answers[$0] != nil } ?? false))
                case .routineDraft(let draft):
                    rows.append(.routineDraft(id: id, part: draft))
                case .connectCard(let card):
                    rows.append(.connect(id: id, part: card, sessionId: message.sessionId))
                case .widgetUI(let card):
                    rows.append(.widgetUI(id: id, part: card))
                case .error(let error):
                    rows.append(.error(id: id, error: error))
                case .notice(let text):
                    rows.append(.notice(id: id, text: text))
                case .interactionResult, .replyTo, .other:
                    continue
                }
            }
            if !rows.isEmpty, let title = labels[message.id] {
                rows.append(.threadLabel(id: "label-\(message.id)", messageId: message.id, title: title))
            } else if !rows.isEmpty, !message.isUser, let turn = message.turnId, let source = unprompted[turn] {
                // One label a message; a task's thread shows only its own.
                rows.append(.sourceLabel(id: "source-\(message.id)", text: SourceCopy.label(source)))
            }
            if !rows.isEmpty {
                entries.append(Entry(id: message.id, date: message.date, guardian: message.isUser, rows: rows, bubbleIndexes: bubbles))
            }
        }
        // What the guardian just sent is newer than anything stored.
        for send in pending.sorted(by: { $0.createdAt < $1.createdAt }) where !storedIDs.contains(send.id) {
            entries.append(Entry(
                id: send.id, date: send.createdAt, guardian: true,
                rows: [.userText(id: send.id, text: send.text, images: send.images.map(UserImage.local), pending: send.state)],
                bubbleIndexes: []
            ))
        }

        // Walk the entries: separators, then corner shapes for each agent run.
        var output: [TranscriptRow] = []
        var previous: Entry?
        var agentRun: [Int] = []

        func closeRun() {
            guard !agentRun.isEmpty else { return }
            for (offset, index) in agentRun.enumerated() {
                guard case .agentText(let id, let text, let long, let forwarded, _) = output[index] else { continue }
                let position: BubblePosition
                if agentRun.count == 1 {
                    position = .single
                } else if offset == 0 {
                    position = .first
                } else if offset == agentRun.count - 1 {
                    position = .last
                } else {
                    position = .middle
                }
                output[index] = .agentText(id: id, text: text, long: long, forwardedFrom: forwarded, position: position)
            }
            agentRun = []
        }

        for entry in entries {
            let gap = previous.map { entry.date.timeIntervalSince($0.date) } ?? .infinity
            let newDay = previous.map { !calendar.isDate($0.date, inSameDayAs: entry.date) } ?? true
            if previous == nil || gap >= separatorGap || newDay {
                closeRun()
                output.append(.separator(id: "sep-\(entry.id)", date: entry.date))
            } else if entry.guardian != previous?.guardian || gap >= groupGap || entry.notice || previous?.notice == true {
                closeRun()
            }
            for (index, row) in entry.rows.enumerated() {
                // Cards sit inside an agent run without breaking its corner chain:
                // the run's first and last bubbles keep their small corners.
                if entry.bubbleIndexes.contains(index) {
                    agentRun.append(output.count)
                }
                output.append(row)
            }
            previous = entry
        }
        closeRun()
        // Only the newest card for each task chat expands, a task card or
        // its question shown alone.
        var marked = Set<String>()
        for index in output.indices.reversed() {
            switch output[index] {
            case .taskCard(let id, let chatId, let title, _, let embeds) where marked.insert(chatId).inserted:
                output[index] = .taskCard(id: id, chatId: chatId, title: title, latest: true, embedsWait: embeds)
            case .taskAsk(let id, let chatId, let title, _, let shownAt) where marked.insert(chatId).inserted:
                output[index] = .taskAsk(id: id, chatId: chatId, title: title, latest: true, shownAt: shownAt)
            default:
                break
            }
        }
        if options.typing { output.append(.typing) }
        return output
    }

    /// An agent message with something to read: text or a card. An error, a
    /// model switch and what no transcript shows do not count.
    static func isReply(_ message: ChatMessage, parts: [MessagePart]) -> Bool {
        guard !message.isUser, !message.isTrace else { return false }
        return parts.contains { part in
            switch part {
            case .error, .notice, .replyTo, .other, .interactionResult: return false
            default: return part.isVisible
            }
        }
    }

    /// What a failed turn's trace says went wrong; nil for a turn that did not fail,
    /// or one whose error is already a stored reply.
    static func failure(of trace: ChatMessage, storedErrors: Set<String>) -> TurnError? {
        guard trace.traceSummary?.turnStatus == "error" else { return nil }
        if let turn = trace.turnId, storedErrors.contains(turn) { return nil }
        let text = trace.traceSummary?.terminalError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // With a code, provider and reason the line takes the guided copy of a
        // stored error; an instance before them, or a code not known here, gives
        // "Didn't finish: <text>".
        let summary = trace.traceSummary
        return TurnError(text: text, code: summary?.terminalErrorCode, provider: summary?.terminalErrorProvider, reason: summary?.terminalErrorReason, didntFinish: true)
    }

    /// The label under each Concierge message in a task's chat thread, by
    /// message id: the task's title. A thread is a task's when a message of
    /// it carries the title; the server sends none for a thread no task has.
    /// The guardian's messages get none, and neither does a message showing
    /// a task card, which names its task itself. A task's question or
    /// approval shown alone does get one (docs/domains/chats.md#chat-thread).
    static func threadLabels(_ messages: [ChatMessage]) -> [String: String] {
        var titles: [String: String] = [:]
        for message in messages {
            if let root = message.chatThreadId, let title = message.chatThreadTitle, !title.isEmpty {
                titles[root] = title
            }
        }
        var labels: [String: String] = [:]
        for message in messages where !message.isUser && !message.isTrace {
            guard let root = message.chatThreadId, let title = titles[root] else { continue }
            let showsTaskCard = message.parts.contains {
                if case .taskChat(_, _, let show) = $0 { return show != .ask }
                return false
            }
            if !showsTaskCard { labels[message.id] = title }
        }
        return labels
    }

    /// The lines a turn's trace summary asks for: the session it renewed.
    static func noticeRows(turn: String, summary: TraceSummary) -> [TranscriptRow] {
        var rows: [TranscriptRow] = []
        if let renewal = summary.sessionRenewal, let reason = renewal.reason, !reason.isEmpty {
            rows.append(.sessionRenewal(id: "renewal-\(turn)", reason: reason, sessionId: renewal.sessionId))
        }
        return rows
    }

    /// A message a routine, an app or an agent sent in, in the guardian's
    /// name or its own.
    static func isAutomated(_ message: ChatMessage) -> Bool {
        message.isUser && message.sender?.kind == "automated"
    }

    /// Answers the guardian already gave, read from their `interaction_result` parts.
    static func answers(in messages: [ChatMessage]) -> [String: JSONValue] {
        var answers: [String: JSONValue] = [:]
        for message in messages where message.isUser {
            for part in message.parts {
                if case .interactionResult(let toolUseId, let output) = part {
                    answers[toolUseId] = output
                }
            }
        }
        return answers
    }
}

enum RelativeTime {
    /// 24-hour "HH:mm" in every locale, as the boards show times.
    static func clock(_ date: Date) -> String {
        clockFormatter.string(from: date)
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    /// The app's own language with the guardian's region, so a weekday or a
    /// month never comes out in a different language from the words around it.
    static var locale: Locale {
        let language = Bundle.main.preferredLocalizations.first ?? "en"
        return Locale(identifier: Locale.current.region.map { "\(language)_\($0.identifier)" } ?? language)
    }

    /// "Today 09:12", "Yesterday 18:20", "Mon 08:00", "Oct 27 14:05";
    /// "今天 09:12", "周一 08:00", "10月27日 14:05" in Chinese.
    static func separator(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let time = clock(date)
        if calendar.isDateInToday(date) { return String(localized: "Today \(time)") }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday \(time)") }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day,
           days < 7 {
            return "\(weekday(date, calendar: calendar)) \(time)"
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return "\(day(date, withYear: !sameYear, calendar: calendar)) \(time)"
    }

    /// "Mon"; "周一" in Chinese.
    static func weekday(_ date: Date, calendar: Calendar = .current, locale: Locale = locale) -> String {
        date.formatted(style(calendar, locale).weekday(.abbreviated))
    }

    /// "Oct 27" or "Oct 27, 2025"; "10月27日" or "2025年10月27日" in Chinese.
    static func day(_ date: Date, withYear: Bool = false, calendar: Calendar = .current, locale: Locale = locale) -> String {
        let format = style(calendar, locale).month(.abbreviated).day()
        return date.formatted(withYear ? format.year() : format)
    }

    private static func style(_ calendar: Calendar, _ locale: Locale) -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    }

    /// "10 minutes ago", "2 hours ago", "Yesterday 18:20", "Mon".
    static func ago(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return String(localized: "Just now") }
        if seconds < 3600 { return String(localized: "\(Int(seconds / 60)) minutes ago") }
        if calendar.isDateInToday(date) { return String(localized: "\(Int(seconds / 3600)) hours ago") }
        if calendar.isDateInYesterday(date) {
            return String(localized: "Yesterday \(clock(date))")
        }
        if seconds < 7 * 86_400 { return weekday(date, calendar: calendar) }
        return day(date, calendar: calendar)
    }

    /// "In 30 minutes", "Tomorrow 09:00": when a watched or planned task is due.
    static func until(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds <= 0 { return String(localized: "Due now") }
        if seconds < 3600 { return String(localized: "In \(max(1, Int(seconds / 60))) minutes") }
        let time = clock(date)
        if calendar.isDateInToday(date) { return String(localized: "Today \(time)") }
        if calendar.isDateInTomorrow(date) { return String(localized: "Tomorrow \(time)") }
        return "\(day(date, calendar: calendar)) \(time)"
    }
}
