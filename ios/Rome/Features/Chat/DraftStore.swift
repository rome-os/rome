import Foundation
import SwiftUI

/// What the guardian left in a chat's composer.
struct Draft: Equatable, Sendable {
    var text: String
    var photos: [ComposerImage]
    /// A send from a chat thread that did not get through: the thread it
    /// was for. Nil for anything typed in the chat's own composer.
    var thread: ThreadTarget? = nil
}

/// A message the guardian has in a chat's transcript, to tell whether an
/// unsent slot in fact got through. The server stores a message under the
/// `inputId` it was sent with, so the ids match.
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
/// next time the chat opens: unsent slots always merge into the live one,
/// oldest first, and from then on the live slot is the only draft. Photos are
/// JPEG files beside the text, in Application Support, not backed up.
///
/// All disk work runs on one serial queue, in the order it was asked for, so
/// a late save can never bring back a draft that was sent or discarded. Disk
/// work for an account that has since ended does nothing, so nothing comes
/// back after the sign-out wipe either.
@MainActor
final class DraftStore {
    let root: URL
    let instance: String
    let account: AccountStamp
    /// Sends of this session still going or failed: their bubble is on
    /// screen, so they are not handed back as a draft too.
    private var unsettled: Set<String> = []
    /// The latest composer of each chat not yet written.
    private var pending: [String: Draft] = [:]
    private var debounce: [String: Task<Void, Never>] = [:]
    private let disk: DraftDisk

    nonisolated static let saveDelay: Duration = .milliseconds(300)
    nonisolated static let photoLimit = 4

    nonisolated static var defaultRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appending(path: "Drafts", directoryHint: .isDirectory)
    }

    init(root: URL = DraftStore.defaultRoot, instance: String, account: AccountStamp = .unchecked) {
        self.root = root
        self.instance = instance
        self.account = account
        disk = DraftDisk(account: account)
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
        return await disk.value(nil) {
            Self.restore(into: folder, adopting: others, skip: skip, transcript: transcript, root: root)
        }
    }

    // MARK: Writing

    /// Keeps the composer as it is, with the chat thread it is aimed at;
    /// written a moment later, and an empty one clears the live slot. Only
    /// the newest content of a chat is written.
    func save(chat: String, text: String, photos: [ComposerImage], thread: ThreadTarget? = nil) {
        pending[chat] = Draft(text: text, photos: photos, thread: thread)
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
        await disk.value(()) {}
    }

    /// A message is going out: kept until `delivered`. `fromComposer`: it
    /// came out of the composer just now, so the live slot is gone at once,
    /// with no debounce in between that a kill could cut off.
    func sending(chat: String, inputId: String, text: String, photos: [ComposerImage], fromComposer: Bool = false, thread: ThreadTarget? = nil) {
        unsettled.insert(inputId)
        let folder = folder(chat)
        let slot = folder.appending(path: "sending-\(Self.safe(inputId))", directoryHint: .isDirectory)
        let live = folder.appending(path: "live", directoryHint: .isDirectory)
        if fromComposer {
            debounce[chat]?.cancel()
            debounce[chat] = nil
            pending[chat] = nil
        }
        let root = root
        disk.run {
            if fromComposer { try? FileManager.default.removeItem(at: live) }
            // With the thread it was for, so a relaunch takes it back there.
            Self.write(slot, text: text, photos: photos, root: root, thread: thread)
        }
    }

    /// A blank chat's start failed: its message goes back into the chat's
    /// live slot, never deleted. If the guardian has left the chat, the next
    /// blank chat takes it in.
    func takeBack(chat: String, inputId: String) {
        unsettled.remove(inputId)
        let folder = folder(chat)
        let slot = folder.appending(path: "sending-\(Self.safe(inputId))", directoryHint: .isDirectory)
        let root = root
        disk.run {
            guard let message = Self.read(slot) else { return }
            let live = folder.appending(path: "live", directoryHint: .isDirectory)
            let draft = Self.merged([Self.read(live), message].compactMap { $0 })
            Self.write(live, text: draft.text, photos: Array(draft.photos.prefix(Self.photoLimit)), root: root)
            FileManager.default.createFile(atPath: folder.appending(path: Self.adoptMarker).path(percentEncoded: false), contents: nil)
            try? FileManager.default.removeItem(at: slot)
        }
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

    /// A chat's drafts go by another id: what was kept under `from` moves to
    /// `to`, unless `to` holds drafts of its own.
    func move(chat from: String, to: String) {
        guard from != to else { return }
        if let draft = pending.removeValue(forKey: from), pending[to] == nil { pending[to] = draft }
        debounce[from]?.cancel()
        debounce[from] = nil
        let source = folder(from), target = folder(to)
        disk.run {
            let manager = FileManager.default
            guard manager.fileExists(atPath: source.path(percentEncoded: false)),
                  !manager.fileExists(atPath: target.path(percentEncoded: false))
            else { return }
            try? manager.moveItem(at: source, to: target)
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
            for folder in folders where !Self.adoptable(folder) {
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
                Self.write(live, text: draft.text, photos: draft.photos, root: root, thread: draft.thread)
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
        /// Absent from slots written before chat threads, and for chat sends.
        var thread: ThreadTarget?
    }

    /// A blank chat's folder holding a failed start's message for the next one.
    nonisolated private static let adoptMarker = "adopt"

    nonisolated private static func adoptable(_ folder: URL) -> Bool {
        FileManager.default.fileExists(atPath: folder.appending(path: adoptMarker).path(percentEncoded: false))
    }

    /// Texts joined by a blank line, photos in order.
    nonisolated private static func merged(_ drafts: [Draft]) -> Draft {
        let texts = drafts.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return Draft(text: texts.joined(separator: "\n\n"), photos: drafts.flatMap(\.photos))
    }

    /// The thread a merged draft goes back to: only when everything in it
    /// was sent to that one thread. Anything typed for the chat keeps it there.
    nonisolated static func thread(of drafts: [Draft]) -> ThreadTarget? {
        let parts = drafts.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !$0.photos.isEmpty }
        guard let first = parts.first?.thread, parts.allSatisfy({ $0.thread == first }) else { return nil }
        return first
    }

    /// The live draft with every unsent slot merged in, oldest first.
    nonisolated private static func restore(into folder: URL, adopting others: [URL], skip: Set<String>, transcript: [SentMessage], root: URL) -> Draft? {
        let live = folder.appending(path: "live", directoryHint: .isDirectory)
        let own = read(live)
        // Another blank chat's failed start, left for this one.
        let adopted = others.filter(adoptable).map { $0.appending(path: "live", directoryHint: .isDirectory) }
        let slots = (([folder] + others)
            .flatMap { (try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] }
            .filter { $0.lastPathComponent.hasPrefix("sending-") }
            .filter { !skip.contains(String($0.lastPathComponent.dropFirst(8))) } + adopted)
            .sorted { modified($0) < modified($1) }
        guard !slots.isEmpty else { return own }
        var drafts = own.map { [$0] } ?? []
        for slot in slots {
            defer { try? FileManager.default.removeItem(at: slot) }
            guard let draft = read(slot), !gotThrough(slot, transcript: transcript) else { continue }
            drafts.append(draft)
        }
        for other in others {
            if adoptable(other) { try? FileManager.default.removeItem(at: other.appending(path: adoptMarker)) }
            removeIfEmpty(other)
        }
        let all = merged(drafts)
        let photos = all.photos
        guard !all.text.isEmpty || !photos.isEmpty else {
            try? FileManager.default.removeItem(at: live)
            removeIfEmpty(folder)
            return nil
        }
        let draft = Draft(text: all.text, photos: Array(photos.prefix(photoLimit)), thread: thread(of: drafts))
        write(live, text: draft.text, photos: draft.photos, root: root, thread: draft.thread)
        // Photos past four wait in their own slot for the next draft.
        if photos.count > photoLimit {
            let kept = folder.appending(path: "sending-kept-\(UUID().uuidString)", directoryHint: .isDirectory)
            write(kept, text: "", photos: Array(photos.dropFirst(photoLimit)), root: root)
        }
        return draft
    }

    /// The server has the message already (the reply to the POST got lost):
    /// it stores the message under the slot's `inputId`.
    nonisolated private static func gotThrough(_ slot: URL, transcript: [SentMessage]) -> Bool {
        guard slot.lastPathComponent.hasPrefix("sending-") else { return false }
        let id = String(slot.lastPathComponent.dropFirst(8))
        return transcript.contains { $0.id == id }
    }

    nonisolated private static func write(_ slot: URL, text: String, photos: [ComposerImage], root: URL, thread: ThreadTarget? = nil) {
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
            let manifest = Manifest(text: text, photos: photos.map(\.id), thread: thread)
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
        return Draft(text: manifest.text, photos: photos, thread: manifest.thread)
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

/// One serial queue for every draft file of a store, and only while its
/// account is signed in.
private final class DraftDisk: @unchecked Sendable {
    private let queue = DispatchQueue(label: "cc.romeos.drafts", qos: .utility)
    private let account: AccountStamp

    init(account: AccountStamp) {
        self.account = account
    }

    func run(_ work: @escaping @Sendable () -> Void) {
        let account = account
        queue.async { account.ifCurrent(work) }
    }

    /// `fallback` once the account has ended.
    func value<T: Sendable>(_ fallback: T, _ work: @escaping @Sendable () -> T) async -> T {
        let account = account
        return await withCheckedContinuation { continuation in
            queue.async {
                var result = fallback
                account.ifCurrent { result = work() }
                continuation.resume(returning: result)
            }
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
    /// A restored draft was a send from a chat thread: reopen it there.
    let onThread: ((ThreadTarget) -> Void)?
    /// A prompt to put in the composer, unsent, then cleared. It waits for the
    /// restore, so it never takes the place of a draft still loading.
    let prefill: Binding<String?>
    /// The prompt went in: the composer takes focus.
    let onPrefill: () -> Void
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
                    // The chat changed or closed while it loaded: this draft is not its.
                    guard !Task.isCancelled else { return }
                    // Typed into while it loaded: what was typed wins.
                    if text.isEmpty && attachments.images.isEmpty {
                        text = draft.text
                        attachments.restore(draft.photos)
                        if let thread = draft.thread { onThread?(thread) }
                    }
                }
                restored = true
                applyPrefill()
            }
            .onChange(of: chat) { restored = false }
            .onChange(of: prefill.wrappedValue) { applyPrefill() }
            .onChange(of: text) { save() }
            .onChange(of: attachments.images.map(\.id)) { save() }
            // Opening or closing a thread aims the draft there, or back at the chat.
            .onChange(of: transcript?.composerThread) { save() }
            .onDisappear {
                save()
                Task { await store.flush() }
            }
    }

    private func applyPrefill() {
        guard restored, let prompt = prefill.wrappedValue else { return }
        prefill.wrappedValue = nil
        text = ComposerPrefill.merged(draft: text, prompt: prompt)
        onPrefill()
    }

    private func save() {
        guard restored else { return }
        store.save(chat: chat, text: text, photos: attachments.images, thread: transcript?.composerThread)
    }
}

extension View {
    /// Keeps the composer's text and photos as the chat's draft, and puts a
    /// `prefill` prompt after it.
    func composerDraft(_ store: DraftStore, chat: String, text: Binding<String>, attachments: ComposerAttachments, transcript: TranscriptStore?, onThread: ((ThreadTarget) -> Void)? = nil, prefill: Binding<String?> = .constant(nil), onPrefill: @escaping () -> Void = {}) -> some View {
        modifier(ComposerDraft(store: store, chat: chat, text: text, attachments: attachments, transcript: transcript, onThread: onThread, prefill: prefill, onPrefill: onPrefill))
    }
}
