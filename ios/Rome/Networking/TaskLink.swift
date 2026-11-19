import Foundation

/// The link to a task chat in the Concierge's text, a plain Markdown link:
/// `[name](#rome-task=CHAT_ID)` (docs/domains/chats.md#task-link).
enum TaskLink {
    /// The start of the href of a link to a task chat, followed by its id.
    static let prefix = "#rome-task="

    /// The task chat a link names, or nil for any other href and for an id
    /// that does not decode, which then reads as the plain link it is.
    static func chatId(ofHref href: String?) -> String? {
        guard let href, href.hasPrefix(prefix) else { return nil }
        // An id never holds a `%`: Foundation reads a stray one in a Markdown link
        // as `%25`, so one left after decoding is an escape that did not decode.
        guard let id = String(href.dropFirst(prefix.count)).removingPercentEncoding, !id.isEmpty, !id.contains("%") else { return nil }
        return id
    }

    static func chatId(of url: URL) -> String? { chatId(ofHref: url.absoluteString) }

    /// The task chats a Markdown text links to.
    static func ids(in text: String) -> Set<String> {
        guard text.contains(prefix) else { return [] }
        var found: Set<String> = []
        var rest = Substring(text)
        while let at = rest.range(of: prefix) {
            let tail = rest[at.lowerBound...]
            let end = tail.firstIndex(where: { $0 == ")" || $0 == " " || $0 == "\n" }) ?? tail.endIndex
            if let id = chatId(ofHref: String(tail[..<end])) { found.insert(id) }
            rest = tail[end...]
        }
        return found
    }

    /// The URL a chip carries, which `chatId(of:)` reads back.
    static func url(chatId: String) -> URL? {
        let plain = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return URL(string: prefix + (chatId.addingPercentEncoding(withAllowedCharacters: plain) ?? chatId))
    }
}

/// One task chat as a task link draws it: its current name and its status.
/// `GET /chats/:chatId/task-links?ids=`. Read leniently: a status this build
/// does not know reads as active.
struct TaskLinkInfo: Decodable, Hashable, Sendable {
    var id: String
    var name: String
    /// `needs_you`, `active`, `later` or `ended`.
    var status: String
    /// Why an ended task ended: `done`, `failed`, `stopped` or `no_response`.
    var endReason: String?

    /// The SF Symbol that stands for the status, the set the web's chip uses.
    /// An active task draws the running ring (`TaskMarkRing`) instead.
    var symbol: String {
        switch status {
        case "needs_you": return "exclamationmark.circle"
        case "later": return "clock"
        case "ended":
            switch endReason {
            case "failed": return "xmark.circle"
            case "stopped": return "stop.circle"
            case "no_response": return "circle"
            default: return "checkmark.circle"
            }
        default: return "arrow.triangle.2.circlepath"
        }
    }

    /// The colour family of the status's mark.
    var tone: TaskMarkTone { TaskMarkTone(status: status, endReason: endReason) }
}

/// The colour of a task's status mark, shared by the task link chip and the
/// Tasks tab's rows: running blue for an active task, warning for one that
/// needs the guardian, green for done, red for failed, and the quiet grey for
/// later, stopped and no response (docs/domains/chats.md#task-link).
enum TaskMarkTone: Equatable, Sendable {
    case running, needsYou, done, failed, quiet

    /// Read leniently, as `TaskLinkInfo.symbol` is: a status this build does
    /// not know is active, and an ended task with no reason is done.
    init(status: String, endReason: String?) {
        switch status {
        case "needs_you": self = .needsYou
        case "later": self = .quiet
        case "ended":
            switch endReason {
            case "failed": self = .failed
            case "stopped", "no_response": self = .quiet
            default: self = .done
            }
        default: self = .running
        }
    }
}

struct TaskLinksResponse: Decodable, Sendable {
    var tasks: [TaskLinkInfo]

    private enum CodingKeys: String, CodingKey { case tasks }

    init(tasks: [TaskLinkInfo]) { self.tasks = tasks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tasks = (try? c.decode([TaskLinkInfo].self, forKey: .tasks)) ?? []
    }
}
