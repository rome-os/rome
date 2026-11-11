import Foundation

/// A message the guardian sent that the server has not stored yet.
struct PendingSend: Identifiable, Hashable, Sendable {
    /// `sent` means the server accepted it; the stored copy replaces it on the next load.
    enum State: Hashable, Sendable { case sending, sent, failed }

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
    /// show what the task waits on.
    case taskCard(id: String, chatId: String, title: String, latest: Bool = false)
    case approval(id: String, part: MessagePart.ApprovalPart, sessionId: String)
    case question(id: String, part: MessagePart.QuestionPart, sessionId: String, answered: JSONValue?)
    /// `done`: an interactive card the guardian already answered.
    case webOnly(id: String, kind: MessagePart.WebOnlyKind, done: Bool = false)
    case routineDraft(id: String, part: MessagePart.RoutineDraftPart)
    case connect(id: String, part: MessagePart.ConnectCardPart, sessionId: String)
    case error(id: String, text: String)
    case tools(id: String, traceMessageId: String, count: Int)
    /// Under an Agent message that ends a stretch of a chat thread, where the
    /// thread goes on beyond that stretch: how many replies it has.
    /// `guardian`: the message is the guardian's, so the line sits right.
    case threadReplies(id: String, messageId: String, count: Int, guardian: Bool)
    case typing

    var id: String {
        switch self {
        case .separator(let id, _), .userText(let id, _, _, _), .agentText(let id, _, _, _, _),
             .taskCard(let id, _, _, _), .approval(let id, _, _), .question(let id, _, _, _),
             .webOnly(let id, _, _), .routineDraft(let id, _), .connect(let id, _, _), .error(let id, _), .tools(let id, _, _),
             .threadReplies(let id, _, _, _):
            return id
        case .typing:
            return "typing"
        }
    }

    var isGuardian: Bool {
        if case .userText = self { return true }
        if case .threadReplies(_, _, _, let guardian) = self { return guardian }
        return false
    }

    /// The stored message a row was drawn from; nil for a pending send and
    /// rows of no one message.
    var messageId: String? {
        switch self {
        case .userText(let id, _, _, let pending):
            return pending == nil ? Self.message(ofPart: id) : nil
        case .agentText(let id, _, _, _, _):
            return Self.message(ofPart: id)
        case .threadReplies(_, let messageId, _, _):
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
        /// Concierge chats mark a chat thread's first message with its replies.
        var showThreads = false
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
        }

        var entries: [Entry] = []
        // A stored message replaces the pending bubble it came from.
        let storedIDs = Set(messages.map(\.id))
        let replies = options.showThreads ? threadLines(messages) : [:]

        // Messages come in the store's order, which follows the server's turns.
        for message in messages {
            if message.isTrace {
                guard options.showTools, let steps = message.traceSummary?.totalSteps, steps > 0 else { continue }
                entries.append(Entry(
                    id: message.id, date: message.date, guardian: false,
                    rows: [.tools(id: "tools-\(message.id)", traceMessageId: message.id, count: steps)],
                    bubbleIndexes: []
                ))
                continue
            }
            var rows: [TranscriptRow] = []
            var bubbles: [Int] = []
            for (index, part) in message.parts.enumerated() {
                let id = "\(message.id):\(index)"
                switch part {
                case .text(let text, let long, let forwarded):
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    if message.isUser {
                        let (body, uploads) = UploadLines.split(text)
                        rows.append(.userText(id: id, text: body, images: uploads.map(UserImage.stored), pending: nil))
                    } else {
                        bubbles.append(rows.count)
                        rows.append(.agentText(id: id, text: text, long: long, forwardedFrom: forwarded, position: .single))
                    }
                case .taskChat(let chatId, let title):
                    rows.append(.taskCard(id: id, chatId: chatId, title: title))
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
                case .error(let text):
                    rows.append(.error(id: id, text: text.isEmpty ? String(localized: "This turn did not finish") : text))
                case .interactionResult, .other:
                    continue
                }
            }
            if !rows.isEmpty, let count = replies[message.id] {
                rows.append(.threadReplies(id: "replies-\(message.id)", messageId: message.id, count: count, guardian: message.isUser))
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
            } else if entry.guardian != previous?.guardian || gap >= groupGap {
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
        // Only the newest card for each task chat expands.
        var marked = Set<String>()
        for index in output.indices.reversed() {
            if case .taskCard(let id, let chatId, let title, _) = output[index], marked.insert(chatId).inserted {
                output[index] = .taskCard(id: id, chatId: chatId, title: title, latest: true)
            }
        }
        if options.typing { output.append(.typing) }
        return output
    }

    /// Where the "N replies" line goes, by message id, and its count
    /// (rome-os/rome#1976). A thread gets at most two: one under its root,
    /// and one under its newest message when something outside the thread
    /// lies between the two. With its root not loaded, only the newest
    /// gets one. Both count every loaded message of the thread but the root.
    static func threadLines(_ messages: [ChatMessage]) -> [String: Int] {
        let shown = messages.filter { !$0.isTrace && $0.parts.contains(where: \.isVisible) }
        let position = Dictionary(shown.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        var replies: [String: [Int]] = [:]
        for (index, message) in shown.enumerated() {
            guard let root = message.chatThreadId, root != message.id else { continue }
            replies[root, default: []].append(index)
        }
        var lines: [String: Int] = [:]
        for (root, indexes) in replies {
            guard let newest = indexes.last else { continue }
            let count = indexes.count
            guard let rootIndex = position[root] else {
                lines[shown[newest].id] = count
                continue
            }
            lines[root] = count
            // Between the two, whichever comes first: a reply can sort
            // before its root when they were written in the same second.
            let first = min(rootIndex, newest), last = max(rootIndex, newest)
            guard last > first + 1 else { continue }
            let interrupted = shown[(first + 1)..<last].contains { $0.chatThreadId != root && $0.id != root }
            if interrupted { lines[shown[newest].id] = count }
        }
        return lines
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
