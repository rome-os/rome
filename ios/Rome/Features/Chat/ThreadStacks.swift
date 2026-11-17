import Foundation

/// A chat thread that has replies, as the main transcript shows it under its
/// root (docs/domains/chats.md#chat-thread): how many replies it has, how
/// many of them the owner has not seen, and its newest message on one line.
/// The root is not a reply.
struct ThreadStack: Hashable, Sendable {
    let root: String
    /// The replies the owner reads: a bubble or a card, and no automation's.
    var total: Int
    /// Replies not said by the owner that the owner has not seen.
    var unread: Int
    /// Where the newest unread reply stands among the chat's messages, to
    /// order the threads that wait: the oldest waiting first.
    var unreadAt: Int
    /// The newest reply, by time, then by arrival.
    var lastId: String
    /// The newest reply's first line.
    var preview: String

    /// What the stack counts on its right: the unread replies, else all of them.
    var count: Int { unread > 0 ? unread : total }
    /// A thread with two or more replies has a thin second layer under its stack.
    var layered: Bool { total > 1 }
    var hasUnread: Bool { unread > 0 }
}

/// What a loaded Concierge transcript shows of its chat threads: the stack of
/// each thread with replies, and the replies the main line leaves out for it.
/// It is worked out from the messages, with the same rules as the dashboard's
/// `chat-threads.tsx`.
struct ThreadStacks: Equatable, Sendable {
    /// The root of the thread each message of more than one is in, by message id.
    var roots: [String: String] = [:]
    /// Each thread's name, by its root, when it has one.
    var titles: [String: String] = [:]
    /// Every thread with replies and a root that can hold its stack, by root.
    var stacks: [String: ThreadStack] = [:]
    /// The replies the main line leaves out for their thread's stack.
    var stacked: Set<String> = []

    static let none = ThreadStacks()

    /// Whether the chat holds the thread whose root is `root`: its root is
    /// loaded and has a reply. A link to any other opens nothing.
    func holds(_ root: String) -> Bool { roots[root] == root }

    /// The roots of the threads that wait for the reader with a pill, oldest
    /// waiting first: those with unread replies whose stack the reader does
    /// not see now. A thread open over the chat shows none, and the pill of a
    /// thread whose stack scrolls out of view comes back with it still unread.
    func waiting(seen: Set<String>, threadOpen: Bool) -> [String] {
        guard !threadOpen else { return [] }
        return stacks.values
            .filter { $0.hasUnread && !seen.contains($0.root) }
            .sorted { $0.unreadAt != $1.unreadAt ? $0.unreadAt < $1.unreadAt : $0.root < $1.root }
            .map(\.root)
    }

    /// How many letters of a thread's name a pill shows.
    static let pillNameMax = 12

    /// A thread's name as a pill shows it: cut short with an ellipsis.
    static func pillName(_ name: String) -> String {
        guard name.count > pillNameMax else { return name }
        return String(name.prefix(pillNameMax)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// How long a stack's one line of preview runs before it is cut.
    static let previewMax = 160

    /// The stacks of `messages`, in the order the store holds them. `arrival`
    /// is the order each message first arrived in, which settles messages made in
    /// the same second; a message with none goes by its place in the list.
    static func build(_ messages: [ChatMessage], arrival: [String: Int] = [:]) -> ThreadStacks {
        let roots = TranscriptBuilder.threadRoots(messages)
        guard !roots.isEmpty else { return .none }
        let titles = TranscriptBuilder.threadTitles(messages, roots: roots)
        // A thread's replies stand in its stack only when its root is loaded
        // and draws something to hang the stack under: a reply whose root has
        // not paged in yet stays a message of the transcript, so it is never
        // out of sight with nothing to hold it.
        var holders = Set<String>()
        for message in messages where roots[message.id] == message.id && holdsStack(message) {
            holders.insert(message.id)
        }
        struct Tally {
            var total = 0
            var unread = 0
            var unreadAt = -1
            var last: (index: Int, date: Date, arrival: Int)?
            var replies: [String] = []
        }
        var tallies: [String: Tally] = [:]
        for (index, message) in messages.enumerated() {
            guard !message.isTrace, let root = roots[message.id], root != message.id, holders.contains(root) else { continue }
            var tally = tallies[root] ?? Tally()
            tally.replies.append(message.id)
            if reads(message) {
                tally.total += 1
                if message.role != "user", message.read == false {
                    tally.unread += 1
                    tally.unreadAt = index
                }
                let mine = (index: index, date: message.date, arrival: arrival[message.id] ?? index)
                if let last = tally.last, (last.date, last.arrival) >= (mine.date, mine.arrival) {
                    // Older, or the same moment and earlier in arrival.
                } else {
                    tally.last = mine
                }
            }
            tallies[root] = tally
        }
        var stacks: [String: ThreadStack] = [:]
        var stacked = Set<String>()
        for (root, tally) in tallies {
            // A thread none of whose replies is read by the owner draws no
            // stack, so it hides nothing.
            guard tally.total > 0, let last = tally.last else { continue }
            let newest = messages[last.index]
            stacks[root] = ThreadStack(root: root, total: tally.total, unread: tally.unread, unreadAt: tally.unreadAt, lastId: newest.id, preview: preview(of: newest))
            stacked.formUnion(tally.replies)
        }
        return ThreadStacks(roots: roots, titles: titles, stacks: stacks, stacked: stacked)
    }

    /// A message the transcript draws something for that a thread's stack
    /// counts: a bubble or a card of the owner or of the agent, and no
    /// automation's, which a Concierge chat does not draw.
    static func reads(_ message: ChatMessage) -> Bool {
        guard !message.isTrace, !TranscriptBuilder.isAutomated(message) else { return false }
        if message.isUser {
            return message.parts.contains { $0.textContent.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false }
        }
        guard message.role == "assistant" else { return false }
        return TranscriptBuilder.isReply(message, parts: message.parts)
    }

    /// A root that has a bubble or a task card to hang its stack under.
    static func holdsStack(_ message: ChatMessage) -> Bool {
        guard !message.isTrace, !TranscriptBuilder.isAutomated(message) else { return false }
        return message.parts.contains { part in
            switch part {
            case .text(let text, _, _): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            // A task's question or approval shown alone is a card with no
            // bubble of its own to hang a stack from.
            case .taskChat(_, _, let show, _): return show != .ask
            default: return false
            }
        }
    }

    /// The one line a thread's newest message shows: its first line of text,
    /// or its card's words.
    static func preview(of message: ChatMessage) -> String {
        let line: String
        if message.isUser {
            line = message.parts.lazy.compactMap { part in
                part.textContent.map { MessagePart.ReplyQuote.firstLine(of: UploadLines.split($0).text) }
            }.first { !$0.isEmpty } ?? ""
        } else {
            line = message.parts.lazy.compactMap { part -> String? in
                switch part {
                case .text(let text, _, _):
                    let first = MessagePart.ReplyQuote.firstLine(of: text)
                    return first.isEmpty ? nil : first
                case .taskChat(_, let title, let show, let card):
                    return cardLine(title: title, show: show, card: card)
                default:
                    return nil
                }
            }.first ?? ""
        }
        return line.count > previewMax ? String(line.prefix(previewMax)) : line
    }

    /// The words a card shows in a quote: a question card's question, an
    /// approval card's title, else its task's title.
    private static func cardLine(title: String, show: MessagePart.TaskChatShow?, card: TaskAskCard?) -> String {
        if show == .ask, let card {
            switch card.kind {
            case .approval(let approval) where !approval.title.trimmingCharacters(in: .whitespaces).isEmpty:
                return approval.title
            case .question:
                if let part = card.questionPart {
                    let asked = SettledOutcome.title(part)
                    if !asked.trimmingCharacters(in: .whitespaces).isEmpty { return asked }
                }
            default:
                break
            }
        }
        return title
    }
}

/// The link to a chat thread in the Concierge's text, a plain Markdown link:
/// `[thread name](#rome-thread=MESSAGE_ID)` (docs/domains/chats.md#chat-thread).
enum ThreadLink {
    /// The start of the href of a link to a thread, followed by the thread's root.
    static let prefix = "#rome-thread="

    /// The root a link names, or nil for any other href and for a root that
    /// does not decode, which then reads as the plain link it is.
    static func root(ofHref href: String?) -> String? {
        guard let href, href.hasPrefix(prefix) else { return nil }
        // An id never holds a `%`: Foundation reads a stray one in a Markdown link
        // as `%25`, so one left after decoding is an escape that did not decode.
        guard let root = decoded(String(href.dropFirst(prefix.count))), !root.isEmpty, !root.contains("%") else { return nil }
        return root
    }

    /// `text` with its percent escapes read as UTF-8, or nil when an escape is
    /// cut short or the bytes are no text.
    private static func decoded(_ text: String) -> String? {
        var bytes: [UInt8] = []
        var rest = text.utf8.makeIterator()
        while let byte = rest.next() {
            guard byte == UInt8(ascii: "%") else {
                bytes.append(byte)
                continue
            }
            guard let high = rest.next().flatMap(hexValue), let low = rest.next().flatMap(hexValue) else { return nil }
            bytes.append(high << 4 | low)
        }
        // Bytes that are no text are repaired by decoding, so the text no longer matches them.
        let text = String(decoding: bytes, as: UTF8.self)
        return Array(text.utf8) == bytes ? text : nil
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
        default: return nil
        }
    }

    static func root(of url: URL) -> String? { root(ofHref: url.absoluteString) }

    /// The URL a chip carries, which `root(of:)` reads back.
    static func url(root: String) -> URL? {
        let plain = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return URL(string: prefix + (root.addingPercentEncoding(withAllowedCharacters: plain) ?? root))
    }
}

/// What the text of a message in a Concierge chat needs to draw a link to a
/// chat thread as a chip: the thread's live name, and whether it opens. One
/// object for each store, so a row holds a reference that never changes.
@MainActor
final class ThreadLinkContext {
    private weak var store: TranscriptStore?
    /// False in a thread view: a chip met there opens nothing.
    let opens: Bool

    init(store: TranscriptStore, opens: Bool) {
        self.store = store
        self.opens = opens
    }

    /// The thread's own name, when the chat knows it.
    func title(_ root: String) -> String? { store?.threadName(root) }

    /// Whether the chip for `root` opens the thread: the chat holds it, and
    /// nothing is open over it.
    func canOpen(_ root: String) -> Bool { opens && (store?.opensThread(root) ?? false) }

    func open(_ root: String) {
        guard opens else { return }
        store?.openChatThread(root)
    }
}
