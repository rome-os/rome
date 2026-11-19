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
    /// When the newest unread reply was said, in seconds, to order the
    /// threads that wait: the oldest waiting first. 0 when none waits.
    var unreadAt: Double
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
    func holds(_ root: String) -> Bool { roots[root] == root || stacks[root] != nil }

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

    /// The stacks of `messages`, in the order the store holds them. `summaries`
    /// are what the instance says of each thread (docs/domains/chats.md#chat-thread):
    /// a stack reads its numbers from there, not from the replies that are loaded.
    /// Without them (an instance before the Concierge pages) they are summed from
    /// the loaded replies. `hints` name the threads whose root is not loaded.
    /// `arrival` is the order each message first arrived in, which settles messages
    /// made in the same second; a message with none goes by its place in the list.
    /// With `hidesOrphans`, a loaded reply stands in its thread's stack whether
    /// its root is loaded or not, as a Concierge chat paged by main-line messages
    /// never draws a reply on its main line; otherwise a reply whose root has not
    /// paged in yet stays a message of the transcript.
    static func build(
        _ messages: [ChatMessage], arrival: [String: Int] = [:], summaries: [String: ThreadSummary]? = nil,
        hints: [String: String] = [:], hidesOrphans: Bool = false
    ) -> ThreadStacks {
        let roots = TranscriptBuilder.threadRoots(messages)
        guard !roots.isEmpty || !(summaries?.isEmpty ?? true) else { return .none }
        var titles = TranscriptBuilder.threadTitles(messages, roots: roots)
        // A thread whose root is not loaded is named by what the instance read of it.
        for (root, hint) in hints where titles[root] == nil { titles[root] = hint }
        // A reply stands in its thread's stack only when its root draws something
        // to hang the stack under (or, with `hidesOrphans`, is not loaded).
        var holders = Set<String>()
        var loadedRoots = Set<String>()
        for message in messages where roots[message.id] == message.id {
            loadedRoots.insert(message.id)
            if holdsStack(message) { holders.insert(message.id) }
        }
        var stacked = Set<String>()
        for message in messages {
            guard !message.isTrace, let root = roots[message.id], root != message.id else { continue }
            if holders.contains(root) || (hidesOrphans && !loadedRoots.contains(root)) { stacked.insert(message.id) }
        }
        // Summed from loaded replies, a thread has a stack only where its root is loaded to hold it:
        // a pill for any other would have nowhere to go.
        let sums = summaries ?? ThreadSummary.summed(from: messages, arrival: arrival).filter { holders.contains($0.key) }
        var stacks: [String: ThreadStack] = [:]
        for (root, summary) in sums where summary.replyCount > 0 {
            stacks[root] = ThreadStack(
                root: root, total: summary.replyCount, unread: summary.unreadCount, unreadAt: summary.unreadAt,
                lastId: summary.latest.id, preview: preview(of: summary.latest)
            )
        }
        // A thread whose root is not loaded has a stack nothing draws: only its pill shows.
        return ThreadStacks(roots: roots, titles: titles, stacks: stacks, stacked: stacked)
    }

    /// A message a stack counts as a reply: said by the owner or the agent, and no
    /// automation (which a Concierge chat does not draw).
    static func counts(_ message: ChatMessage) -> Bool {
        guard !message.isTrace, !TranscriptBuilder.isAutomated(message) else { return false }
        return message.role == "user" || message.role == "assistant"
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
        guard let root = String(href.dropFirst(prefix.count)).removingPercentEncoding, !root.isEmpty, !root.contains("%") else { return nil }
        return root
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

extension ThreadSummary {
    /// The summary of a thread from all its replies, which only a thread read
    /// whole has. Nil when none counts. The newest is by time, then by arrival
    /// (`arrival` by message id, else the place in `replies`).
    static func of(replies: [ChatMessage], arrival: [String: Int] = [:]) -> ThreadSummary? {
        var count = 0
        var unread = 0
        var unreadAt = 0.0
        var newest: (message: ChatMessage, date: Date, arrival: Int)?
        for (index, message) in replies.enumerated() where ThreadStacks.counts(message) {
            count += 1
            let mine = (message: message, date: message.date, arrival: arrival[message.id] ?? index)
            if message.role != "user", message.read == false {
                unread += 1
                unreadAt = max(unreadAt, mine.date.timeIntervalSince1970)
            }
            if let last = newest, (last.date, last.arrival) >= (mine.date, mine.arrival) { continue }
            newest = mine
        }
        guard let latest = newest?.message else { return nil }
        return ThreadSummary(replyCount: count, unreadCount: unread, latest: latest, unreadAt: unreadAt)
    }

    /// The summary of every thread of `messages` that has replies among them, by root:
    /// right where each thread's replies are all loaded, as on an instance before the
    /// Concierge pages, which brings whole turns.
    static func summed(from messages: [ChatMessage], arrival: [String: Int] = [:]) -> [String: ThreadSummary] {
        var replies: [String: [ChatMessage]] = [:]
        for message in messages where !message.isTrace {
            if let root = message.chatThreadId, root != message.id { replies[root, default: []].append(message) }
        }
        var summaries: [String: ThreadSummary] = [:]
        for (root, own) in replies {
            if let summary = of(replies: own, arrival: arrival) { summaries[root] = summary }
        }
        return summaries
    }

    /// The summary after a reply came live: it counts, and is the newest.
    func withLive(reply message: ChatMessage) -> ThreadSummary {
        var next = self
        next.replyCount += 1
        if message.role != "user", message.read == false {
            next.unreadCount += 1
            next.unreadAt = message.date.timeIntervalSince1970
        }
        next.latest = message
        return next
    }

    /// The summary of a thread's first reply.
    static func first(reply message: ChatMessage) -> ThreadSummary {
        let unread = message.role != "user" && message.read == false
        return ThreadSummary(replyCount: 1, unreadCount: unread ? 1 : 0, latest: message, unreadAt: unread ? message.date.timeIntervalSince1970 : 0)
    }

    /// The summary after the owner has seen every reply.
    var seen: ThreadSummary {
        var next = self
        next.unreadCount = 0
        next.unreadAt = 0
        return next
    }
}
