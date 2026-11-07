import Foundation
import SwiftUI

/// What the guardian left in a chat's composer.
struct Draft: Equatable, Sendable {
    var text: String
    var photos: [ComposerImage]
}

/// A message the guardian has in a chat's transcript, to tell whether an
/// unsent slot in fact got through.
struct SentMessage: Sendable {
    let id: String
    let text: String
    let date: Date
}

/// One draft per chat of one instance, kept on this phone only.
///
/// Each chat has a live slot, saved a moment after each edit, and a slot per
/// message being sent, removed once the server takes it. A send that fails,
/// or is cut off when the app is killed, comes back into the composer the
/// next time the chat opens: unsent slots merge into the live one, oldest
/// first, and from then on the live slot is the only draft. Photos are JPEG
/// files beside the text, in Application Support, not backed up.
///
/// All disk work runs on one serial queue, in the order it was asked for, so
/// a late save can never bring back a draft that was sent or discarded.
@MainActor
final class DraftStore {
    let root: URL
    let instance: String
    /// Sends of this session still going or failed: their bubble is on
    /// screen, so they are not handed back as a draft too.
    private var unsettled: Set<String> = []
    /// The latest composer of each chat not yet written.
    private var pending: [String: Draft] = [:]
    private var debounce: [String: Task<Void, Never>] = [:]
    private let disk = DraftDisk()

    nonisolated static let saveDelay: Duration = .milliseconds(300)
    nonisolated static let photoLimit = 4

    nonisolated static var defaultRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appending(path: "Drafts", directoryHint: .isDirectory)
    }

    init(root: URL = DraftStore.defaultRoot, instance: String) {
        self.root = root
        self.instance = instance
    }

    // MARK: Reading

    /// The chat's draft. Unsent slots merge into it, oldest first, except
    /// ones whose message is already in `transcript`; photos past four stay
    /// in a kept slot for later. Photos decode off the main actor.
    func load(chat: String, transcript: [SentMessage] = []) async -> Draft? {
        if let draft = pending[chat] { return draft }
        let folder = folder(chat)
        let others = Self.isBlank(chat) ? blankFolders(except: chat) : []
        let skip = unsettled
        let root = root
        return await disk.value {
            Self.restore(into: folder, adopting: others, skip: skip, transcript: transcript, root: root)
        }
    }

    // MARK: Writing

    /// Keeps the composer as it is; written a moment later, and an empty one
    /// clears the live slot. Only the newest content of a chat is written.
    func save(chat: String, text: String, photos: [ComposerImage]) {
        pending[chat] = Draft(text: text, photos: photos)
        debounce[chat]?.cancel()
        debounce[chat] = Task { [weak self] in
            try? await Task.sleep(for: Self.saveDelay)
            guard !Task.isCancelled else { return }
            self?.commit(chat)
        }
    }

    /// Writes every pending save now, and waits for the disk.
    func flush() async {
        for chat in Array(pending.keys) { commit(chat) }
        await disk.value {}
    }

    /// A message is going out: kept until `delivered`.
    func sending(chat: String, inputId: String, text: String, photos: [ComposerImage]) {
        unsettled.insert(inputId)
        let slot = folder(chat).appending(path: "sending-\(Self.safe(inputId))", directoryHint: .isDirectory)
        let root = root
        disk.run { Self.write(slot, text: text, photos: photos, root: root) }
    }

    /// The server took the message, or the composer took it back.
    func delivered(chat: String, inputId: String) {
        unsettled.remove(inputId)
        let folder = folder(chat)
        let slot = folder.appending(path: "sending-\(Self.safe(inputId))", directoryHint: .isDirectory)
        disk.run {
            try? FileManager.default.removeItem(at: slot)
            Self.removeIfEmpty(folder)
        }
    }

    /// Drops everything the chat holds: a blank chat left without sending.
    func discard(chat: String) {
        debounce[chat]?.cancel()
        debounce[chat] = nil
        pending[chat] = nil
        let folder = folder(chat)
        disk.run { try? FileManager.default.removeItem(at: folder) }
    }

    /// At start: blank topic chats lose their live drafts. A blank chat's
    /// first message, cut off while the chat was being made, stays for the
    /// next blank chat to take back.
    func discardBlankChats() {
        let folders = blankFolders(except: nil)
        disk.run {
            for folder in folders {
                try? FileManager.default.removeItem(at: folder.appending(path: "live", directoryHint: .isDirectory))
                Self.removeIfEmpty(folder)
            }
        }
    }

    /// The draft key of a blank topic chat, before it exists on the server.
    nonisolated static let blankPrefix = "new-"
    nonisolated static func blankChat(_ key: UUID) -> String { blankPrefix + key.uuidString }
    nonisolated static func isBlank(_ chat: String) -> Bool { chat.hasPrefix(blankPrefix) }

    /// The draft instance of demo data and of a Rome on this Mac: never
    /// swept by Rome Cloud's list.
    nonisolated static let demoInstance = "demo"
    nonisolated static func localInstance(_ host: String) -> String { "local-" + host }

    /// Sign-out: every instance's drafts.
    nonisolated static func removeAll(root: URL = defaultRoot) {
        try? FileManager.default.removeItem(at: root)
    }

    /// Drafts of instances the account no longer has. Demo and local drafts stay.
    nonisolated static func removeInstances(keeping hosts: Set<String>, root: URL = defaultRoot) {
        let kept = Set(hosts.map(safe)).union([safe(demoInstance)])
        let localPrefix = safe(localInstance(""))
        for dir in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        where !kept.contains(dir.lastPathComponent) && !dir.lastPathComponent.hasPrefix(localPrefix) {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    // MARK: Plumbing

    private func commit(_ chat: String) {
        debounce[chat]?.cancel()
        debounce[chat] = nil
        guard let draft = pending.removeValue(forKey: chat) else { return }
        let folder = folder(chat)
        let live = folder.appending(path: "live", directoryHint: .isDirectory)
        let root = root
        disk.run {
            if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.photos.isEmpty {
                try? FileManager.default.removeItem(at: live)
                Self.removeIfEmpty(folder)
            } else {
                Self.write(live, text: draft.text, photos: draft.photos, root: root)
            }
        }
    }

    private func folder(_ chat: String) -> URL {
        instanceFolder.appending(path: Self.safe(chat), directoryHint: .isDirectory)
    }

    private var instanceFolder: URL {
        root.appending(path: Self.safe(instance), directoryHint: .isDirectory)
    }

    private func blankFolders(except chat: String?) -> [URL] {
        let own = chat.map(Self.safe)
        let prefix = Self.safe(Self.blankPrefix)
        return ((try? FileManager.default.contentsOfDirectory(at: instanceFolder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix(prefix) && $0.lastPathComponent != own }
    }

    private struct Manifest: Codable {
        var text: String
        var photos: [UUID]
    }

    /// Reads the live draft, or makes one from the unsent slots.
    nonisolated private static func restore(into folder: URL, adopting others: [URL], skip: Set<String>, transcript: [SentMessage], root: URL) -> Draft? {
        let live = folder.appending(path: "live", directoryHint: .isDirectory)
        if let draft = read(live) { return draft }
        let slots = ([folder] + others)
            .flatMap { (try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] }
            .filter { $0.lastPathComponent.hasPrefix("sending-") }
            .filter { !skip.contains(String($0.lastPathComponent.dropFirst(8))) }
            .sorted { modified($0) < modified($1) }
        var texts: [String] = []
        var photos: [ComposerImage] = []
        for slot in slots {
            defer { try? FileManager.default.removeItem(at: slot) }
            guard let draft = read(slot), !gotThrough(slot, draft: draft, transcript: transcript) else { continue }
            let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { texts.append(text) }
            photos += draft.photos
        }
        for other in others { removeIfEmpty(other) }
        guard !texts.isEmpty || !photos.isEmpty else {
            removeIfEmpty(folder)
            return nil
        }
        let draft = Draft(text: texts.joined(separator: "\n\n"), photos: Array(photos.prefix(photoLimit)))
        write(live, text: draft.text, photos: draft.photos, root: root)
        // Photos past four wait in their own slot for the next draft.
        if photos.count > photoLimit {
            let kept = folder.appending(path: "sending-kept-\(UUID().uuidString)", directoryHint: .isDirectory)
            write(kept, text: "", photos: Array(photos.dropFirst(photoLimit)), root: root)
        }
        return draft
    }

    /// The server has the message already: its id, or the same text from the
    /// guardian since the slot was written (the reply to the POST got lost).
    nonisolated private static func gotThrough(_ slot: URL, draft: Draft, transcript: [SentMessage]) -> Bool {
        let id = String(slot.lastPathComponent.dropFirst(8))
        if transcript.contains(where: { $0.id == id }) { return true }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        let since = modified(slot).addingTimeInterval(-5)
        return transcript.contains { $0.date >= since && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == text }
    }

    nonisolated private static func write(_ slot: URL, text: String, photos: [ComposerImage], root: URL) {
        let manager = FileManager.default
        do {
            try manager.createDirectory(at: slot, withIntermediateDirectories: true)
            excludeFromBackup(root)
            let wanted = Set(photos.map { "\($0.id.uuidString).jpg" })
            for file in try manager.contentsOfDirectory(atPath: slot.path(percentEncoded: false)) where file.hasSuffix(".jpg") && !wanted.contains(file) {
                try? manager.removeItem(at: slot.appending(path: file))
            }
            // Only new photos are written; typing rewrites the small manifest.
            for photo in photos {
                let file = slot.appending(path: "\(photo.id.uuidString).jpg")
                if !manager.fileExists(atPath: file.path(percentEncoded: false)) { try photo.jpeg.write(to: file, options: .atomic) }
            }
            let manifest = Manifest(text: text, photos: photos.map(\.id))
            try JSONEncoder().encode(manifest).write(to: slot.appending(path: "draft.json"), options: .atomic)
        } catch {
            // A draft that cannot be written is lost, as it was before drafts.
        }
    }

    nonisolated private static func excludeFromBackup(_ url: URL) {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    nonisolated private static func removeIfEmpty(_ dir: URL) {
        if let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false)), items.isEmpty {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    nonisolated private static func read(_ slot: URL) -> Draft? {
        guard let data = try? Data(contentsOf: slot.appending(path: "draft.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
        else { return nil }
        let photos = manifest.photos.compactMap { id -> ComposerImage? in
            guard let jpeg = try? Data(contentsOf: slot.appending(path: "\(id.uuidString).jpg")) else { return nil }
            return ComposerImage(id: id, jpeg: jpeg)
        }
        return Draft(text: manifest.text, photos: photos)
    }

    nonisolated private static func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    /// A folder name from a host or an id: letters, digits, - and _ stay;
    /// everything else, the dots of "." and ".." included, is percent-encoded.
    nonisolated static func safe(_ name: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let encoded = name.addingPercentEncoding(withAllowedCharacters: allowed) ?? "_"
        return encoded.isEmpty ? "_" : encoded
    }
}

/// One serial queue for every draft file.
private final class DraftDisk: @unchecked Sendable {
    private let queue = DispatchQueue(label: "cc.romeos.drafts", qos: .utility)

    func run(_ work: @escaping @Sendable () -> Void) {
        queue.async(execute: work)
    }

    func value<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: work()) }
        }
    }
}

/// A chat's drafts, for its transcript store's sends.
struct ChatDrafts {
    let store: DraftStore
    let chat: String
}

extension TranscriptStore {
    /// The guardian's messages, for telling a lost send from one that got through.
    var sentMessages: [SentMessage] {
        messages.filter(\.isUser).map { message in
            let text = message.parts.compactMap(\.textContent).joined(separator: "\n")
            return SentMessage(id: message.id, text: UploadLines.split(text).text, date: message.date)
        }
    }
}

/// Restores a chat's draft into its composer when the chat opens, and saves
/// the composer as it changes.
private struct ComposerDraft: ViewModifier {
    let store: DraftStore
    let chat: String
    @Binding var text: String
    let attachments: ComposerAttachments
    /// The chat's transcript; the restore waits for it to load. Nil for a
    /// blank chat, which has none.
    let transcript: TranscriptStore?
    /// Saving waits until the restore ran, so it never writes over the draft
    /// with an empty composer.
    @State private var restored = false

    private var ready: Bool { transcript?.loaded ?? true }

    func body(content: Content) -> some View {
        content
            .task(id: "\(chat)|\(ready)") {
                guard ready, !restored else { return }
                if text.isEmpty && attachments.images.isEmpty,
                   let draft = await store.load(chat: chat, transcript: transcript?.sentMessages ?? []) {
                    // Typed into while it loaded: what was typed wins.
                    if text.isEmpty && attachments.images.isEmpty {
                        text = draft.text
                        attachments.restore(draft.photos)
                    }
                }
                restored = true
            }
            .onChange(of: chat) { restored = false }
            .onChange(of: text) { save() }
            .onChange(of: attachments.images.map(\.id)) { save() }
            .onDisappear {
                save()
                Task { await store.flush() }
            }
    }

    private func save() {
        guard restored else { return }
        store.save(chat: chat, text: text, photos: attachments.images)
    }
}

extension View {
    /// Keeps the composer's text and photos as the chat's draft.
    func composerDraft(_ store: DraftStore, chat: String, text: Binding<String>, attachments: ComposerAttachments, transcript: TranscriptStore?) -> some View {
        modifier(ComposerDraft(store: store, chat: chat, text: text, attachments: attachments, transcript: transcript))
    }
}
