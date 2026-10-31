import Foundation

/// A message the guardian sent that the server has not stored yet.
struct PendingSend: Identifiable, Hashable, Sendable {
    /// `sent` means the server accepted it; the stored copy replaces it on the next load.
    enum State: Hashable, Sendable { case sending, sent, failed }

    let id: String
    let text: String
    let createdAt: Date
    var state: State
}

/// Where a bubble sits in its run of same-sender bubbles. It decides the
/// small corner: the first bubble's bottom-left, the last bubble's top-left.
enum BubblePosition: Hashable, Sendable {
    case single, first, middle, last
}

/// One row of a transcript, ready to draw.
enum TranscriptRow: Identifiable, Hashable {
    case separator(id: String, date: Date)
    case userText(id: String, text: String, pending: PendingSend.State?)
    case agentText(id: String, text: String, long: Bool, forwardedFrom: MessagePart.ForwardedFrom?, position: BubblePosition)
    case taskCard(id: String, chatId: String, title: String)
    case approval(id: String, part: MessagePart.ApprovalPart, sessionId: String)
    case question(id: String, part: MessagePart.QuestionPart, sessionId: String, answered: JSONValue?)
    case webOnly(id: String)
    case error(id: String, text: String)
    case tools(id: String, traceMessageId: String, count: Int)
    case typing

    var id: String {
        switch self {
        case .separator(let id, _), .userText(let id, _, _), .agentText(let id, _, _, _, _),
             .taskCard(let id, _, _), .approval(let id, _, _), .question(let id, _, _, _),
             .webOnly(let id), .error(let id, _), .tools(let id, _, _):
            return id
        case .typing:
            return "typing"
        }
    }

    var isGuardian: Bool {
        if case .userText = self { return true }
        return false
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

        for message in messages.sorted(by: { $0.date < $1.date }) {
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
                        rows.append(.userText(id: id, text: text, pending: nil))
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
                case .webOnly:
                    rows.append(.webOnly(id: id))
                case .error(let text):
                    rows.append(.error(id: id, text: text.isEmpty ? String(localized: "This turn did not finish") : text))
                case .interactionResult, .other:
                    continue
                }
            }
            if !rows.isEmpty {
                entries.append(Entry(id: message.id, date: message.date, guardian: message.isUser, rows: rows, bubbleIndexes: bubbles))
            }
        }
        for send in pending.sorted(by: { $0.createdAt < $1.createdAt }) where !storedIDs.contains(send.id) {
            entries.append(Entry(
                id: send.id, date: send.createdAt, guardian: true,
                rows: [.userText(id: send.id, text: send.text, pending: send.state)],
                bubbleIndexes: []
            ))
        }
        entries.sort { $0.date < $1.date }

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
        if options.typing { output.append(.typing) }
        return output
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
    static func weekday(_ date: Date, calendar: Calendar = .current) -> String {
        date.formatted(style(calendar).weekday(.abbreviated))
    }

    /// "Oct 27" or "Oct 27, 2025"; "10月27日" or "2025年10月27日" in Chinese.
    static func day(_ date: Date, withYear: Bool = false, calendar: Calendar = .current) -> String {
        let format = style(calendar).month(.abbreviated).day()
        return date.formatted(withYear ? format.year() : format)
    }

    private static func style(_ calendar: Calendar) -> Date.FormatStyle {
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
