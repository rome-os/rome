import Foundation
import SwiftUI

/// What the guardian left in a chat's composer.
struct Draft: Equatable, Sendable {
    var text: String
    var photos: [ComposerImage]
}

/// One draft per chat of one instance, kept on this phone only. Each chat has
/// a live slot, written on every edit, and a slot per message being sent,
/// removed once the server takes it: a send that fails, or is cut off when
/// the app is killed, comes back as the draft the next time the chat opens.
/// Photos are JPEG files beside the text, in Application Support, not backed up.
@MainActor
final class DraftStore {
    let root: URL
    let instance: String
    /// Sends of this session still going or failed: their bubble is on
    /// screen, so they are not handed back as a draft too.
    private var unsettled: Set<String> = []

    nonisolated static var defaultRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appending(path: "Drafts", directoryHint: .isDirectory)
    }

    init(root: URL = DraftStore.defaultRoot, instance: String) {
        self.root = root
        self.instance = instance
    }

    // MARK: Reading

    /// The chat's draft: the live one, else the latest send that never got
    /// through. Photos decode off the main actor.
    func load(chat: String) async -> Draft? {
        let chatDir = folder(chat)
        let live = chatDir.appending(path: "live", directoryHint: .isDirectory)
        let skip = unsettled
        return await Task.detached(priority: .userInitiated) {
            if let draft = Self.read(live) { return draft }
            let slots = (try? FileManager.default.contentsOfDirectory(at: chatDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            let unsent = slots
                .filter { $0.lastPathComponent.hasPrefix("sending-") && !skip.contains(String($0.lastPathComponent.dropFirst(8))) }
                .sorted { Self.modified($0) > Self.modified($1) }
            return unsent.lazy.compactMap { Self.read($0) }.first
        }.value
    }

    // MARK: Writing

    /// Saves the composer as it is; an empty one clears the live slot.
    func save(chat: String, text: String, photos: [ComposerImage]) {
        let live = folder(chat).appending(path: "live", directoryHint: .isDirectory)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty {
            try? FileManager.default.removeItem(at: live)
            removeIfEmpty(folder(chat))
            return
        }
        write(live, text: text, photos: photos)
    }

    /// A message is going out: it is kept until `delivered`. Older unsent
    /// slots of the chat are dropped; this send replaces them.
    func sending(chat: String, inputId: String, text: String, photos: [ComposerImage]) {
        let chatDir = folder(chat)
        for slot in (try? FileManager.default.contentsOfDirectory(at: chatDir, includingPropertiesForKeys: nil)) ?? []
        where slot.lastPathComponent.hasPrefix("sending-") {
            let id = String(slot.lastPathComponent.dropFirst(8))
            if id != inputId && !unsettled.contains(id) { try? FileManager.default.removeItem(at: slot) }
        }
        unsettled.insert(inputId)
        write(chatDir.appending(path: "sending-\(Self.safe(inputId))", directoryHint: .isDirectory), text: text, photos: photos)
    }

    /// The server took the message.
    func delivered(chat: String, inputId: String) {
        try? FileManager.default.removeItem(at: folder(chat).appending(path: "sending-\(Self.safe(inputId))", directoryHint: .isDirectory))
        unsettled.remove(inputId)
        removeIfEmpty(folder(chat))
    }

    /// Drops everything the chat holds: a blank chat left without sending.
    func discard(chat: String) {
        try? FileManager.default.removeItem(at: folder(chat))
    }

    /// Blank topic chats never outlive the app.
    func discardBlankChats() {
        let dir = root.appending(path: Self.safe(instance), directoryHint: .isDirectory)
        for chat in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        where chat.lastPathComponent.hasPrefix(Self.blankPrefix) {
            try? FileManager.default.removeItem(at: chat)
        }
    }

    /// The draft key of a blank topic chat, before it exists on the server.
    nonisolated static let blankPrefix = "new-"
    nonisolated static func blankChat(_ key: UUID) -> String { blankPrefix + key.uuidString }

    /// Sign-out: every instance's drafts.
    nonisolated static func removeAll(root: URL = defaultRoot) {
        try? FileManager.default.removeItem(at: root)
    }

    /// Drafts of instances the account no longer has.
    nonisolated static func removeInstances(keeping hosts: Set<String>, root: URL = defaultRoot) {
        let kept = Set(hosts.map(safe))
        for dir in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        where !kept.contains(dir.lastPathComponent) {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    // MARK: Files

    private struct Manifest: Codable {
        var text: String
        var photos: [UUID]
    }

    private func folder(_ chat: String) -> URL {
        root.appending(path: Self.safe(instance), directoryHint: .isDirectory)
            .appending(path: Self.safe(chat), directoryHint: .isDirectory)
    }

    private func write(_ slot: URL, text: String, photos: [ComposerImage]) {
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

    private func excludeFromBackup(_ url: URL) {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private func removeIfEmpty(_ dir: URL) {
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

    /// A folder name from a host or an id.
    nonisolated static func safe(_ name: String) -> String {
        String(name.map { $0.isLetter || $0.isNumber || "-_.".contains($0) ? $0 : "_" })
    }
}

/// A chat's drafts, for its transcript store's sends.
struct ChatDrafts {
    let store: DraftStore
    let chat: String
}

/// Restores a chat's draft into its composer when the chat opens, and saves
/// the composer on every edit.
private struct ComposerDraft: ViewModifier {
    let store: DraftStore
    let chat: String
    @Binding var text: String
    let attachments: ComposerAttachments
    /// Saving waits until the restore ran, so it never writes over the draft
    /// with an empty composer.
    @State private var restored = false

    func body(content: Content) -> some View {
        content
            .task(id: chat) {
                restored = false
                if text.isEmpty && attachments.images.isEmpty, let draft = await store.load(chat: chat) {
                    // Typed into while it loaded: what was typed wins.
                    if text.isEmpty && attachments.images.isEmpty {
                        text = draft.text
                        attachments.restore(draft.photos)
                    }
                }
                restored = true
            }
            .onChange(of: text) { save() }
            .onChange(of: attachments.images.map(\.id)) { save() }
    }

    private func save() {
        guard restored else { return }
        store.save(chat: chat, text: text, photos: attachments.images)
    }
}

extension View {
    /// Keeps the composer's text and photos as the chat's draft.
    func composerDraft(_ store: DraftStore, chat: String, text: Binding<String>, attachments: ComposerAttachments) -> some View {
        modifier(ComposerDraft(store: store, chat: chat, text: text, attachments: attachments))
    }
}
