import Foundation

/// The newest messages of the main Chat and each topic chat, kept on this
/// phone, per instance, so a chat shows its last page at once on the next
/// launch, offline too. Task chats are not kept.
///
/// One JSON file per chat in Application Support, not backed up, readable
/// after the first unlock. A copy older than `maxAge`, or written in another
/// format, is thrown away. Writes wait a moment and run on one serial queue
/// shared by every instance, so a wipe always lands after the writes before it.
@MainActor
final class TranscriptCache {
    let root: URL
    let instance: String
    private var pending: [String: [ChatMessage]] = [:]
    private var debounce: [String: Task<Void, Never>] = [:]

    nonisolated static let format = 1
    nonisolated static let keep = 50
    nonisolated static let maxAge: TimeInterval = 3 * 24 * 3600
    nonisolated static let saveDelay: Duration = .milliseconds(800)
    nonisolated private static let queue = DispatchQueue(label: "cc.romeos.transcripts", qos: .utility)

    nonisolated static var defaultRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appending(path: "Transcripts", directoryHint: .isDirectory)
    }

    init(root: URL = TranscriptCache.defaultRoot, instance: String) {
        self.root = root
        self.instance = instance
    }

    struct Snapshot: Codable {
        var format: Int
        var savedAt: Date
        var chatId: String
        var messages: [ChatMessage]
    }

    private struct MainChat: Codable {
        var chatId: String
    }

    // MARK: Reading

    /// The chat's kept messages, oldest first; nil when there are none fit to show.
    func messages(chat: String, now: Date = .now) -> [ChatMessage]? {
        if let waiting = pending[chat] { return waiting }
        let file = file(chat)
        let snapshot = Self.queue.sync { () -> Snapshot? in
            guard let data = try? Data(contentsOf: file) else { return nil }
            guard let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
                  snapshot.format == Self.format, snapshot.chatId == chat,
                  now.timeIntervalSince(snapshot.savedAt) < Self.maxAge
            else {
                try? FileManager.default.removeItem(at: file)
                return nil
            }
            return snapshot
        }
        guard let snapshot, !snapshot.messages.isEmpty else { return nil }
        return snapshot.messages
    }

    /// The id this person's main chat had last time: a visitor's is their own.
    func mainChat() -> String? {
        let file = folder.appending(path: "main.json")
        return Self.queue.sync {
            (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(MainChat.self, from: $0) }?.chatId
        }
    }

    // MARK: Writing

    /// Keeps the chat's newest `keep` messages; written a moment later.
    func save(chat: String, messages: [ChatMessage]) {
        pending[chat] = Array(messages.suffix(Self.keep))
        debounce[chat]?.cancel()
        debounce[chat] = Task { [weak self] in
            try? await Task.sleep(for: Self.saveDelay)
            guard !Task.isCancelled else { return }
            self?.commit(chat)
        }
    }

    func setMainChat(_ chatId: String) {
        guard !chatId.isEmpty, let data = try? JSONEncoder().encode(MainChat(chatId: chatId)) else { return }
        let folder = folder
        Self.queue.async {
            Self.prepare(folder)
            try? data.write(to: folder.appending(path: "main.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    /// Writes every waiting save now.
    func flush() {
        for chat in Array(pending.keys) { commit(chat) }
    }

    /// Waits for the disk; tests read after it.
    nonisolated static func settle() {
        queue.sync {}
    }

    private func commit(_ chat: String) {
        debounce[chat]?.cancel()
        debounce[chat] = nil
        guard let messages = pending.removeValue(forKey: chat) else { return }
        let snapshot = Snapshot(format: Self.format, savedAt: .now, chatId: chat, messages: messages)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        let folder = folder, file = file(chat)
        Self.queue.async {
            Self.prepare(folder)
            try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    // MARK: Removing

    /// Sign-out: every instance's chats.
    nonisolated static func removeAll(root: URL = defaultRoot) {
        queue.sync { try? FileManager.default.removeItem(at: root) }
    }

    /// Chats of instances the account no longer has. Demo and local ones stay.
    nonisolated static func removeInstances(keeping hosts: Set<String>, root: URL = defaultRoot) {
        let kept = Set(hosts.map(DraftStore.safe)).union([DraftStore.safe(DraftStore.demoInstance)])
        let localPrefix = DraftStore.safe(DraftStore.localInstance(""))
        queue.sync {
            for dir in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            where !kept.contains(dir.lastPathComponent) && !dir.lastPathComponent.hasPrefix(localPrefix) {
                try? FileManager.default.removeItem(at: dir)
            }
        }
    }

    // MARK: Files

    private var folder: URL {
        root.appending(path: DraftStore.safe(instance), directoryHint: .isDirectory)
    }

    private func file(_ chat: String) -> URL {
        folder.appending(path: DraftStore.safe(chat) + ".json")
    }

    nonisolated private static func prepare(_ folder: URL) {
        guard !FileManager.default.fileExists(atPath: folder.path(percentEncoded: false)) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for url in [folder, folder.deletingLastPathComponent()] {
            var url = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
    }
}
