import SwiftUI
import UIKit

/// A chat's turns as share mode picks them: an owner message and the replies
/// to it, by the `turnId` its messages carry. Rows of no stored message (a
/// time line, a pending send, the typing dots) belong to no turn.
struct ShareTurns: Equatable {
    /// The turn of each row that has one, by row id.
    private(set) var turnOfRow: [String: String] = [:]
    /// The first row of each turn, where its check circle sits.
    private(set) var leadRows: Set<String> = []
    /// Turn ids in transcript order.
    private(set) var order: [String] = []

    init(messages: [ChatMessage], rows: [TranscriptRow]) {
        var turnOfMessage: [String: String] = [:]
        for message in messages {
            if let turn = message.turnId, !turn.isEmpty { turnOfMessage[message.id] = turn }
        }
        var seen: Set<String> = []
        for row in rows {
            guard let message = Self.messageId(ofRow: row.id), let turn = turnOfMessage[message] else { continue }
            turnOfRow[row.id] = turn
            if seen.insert(turn).inserted {
                order.append(turn)
                leadRows.insert(row.id)
            }
        }
    }

    /// The newest turn: what "Share chat" starts with.
    var latest: String? { order.last }

    /// The stored message a row was drawn from, by the row's id.
    static func messageId(ofRow id: String) -> String? {
        if id.hasPrefix("sep-") { return nil }
        for prefix in ["tools-", "replies-"] where id.hasPrefix(prefix) {
            return String(id.dropFirst(prefix.count))
        }
        return TranscriptRow.message(ofPart: id)
    }

    /// The text of the chosen turns' bubbles, in order: what an instance
    /// that cannot make a link shares instead.
    func text(of turns: Set<String>, rows: [TranscriptRow]) -> String {
        rows.compactMap { row -> String? in
            guard let turn = turnOfRow[row.id], turns.contains(turn) else { return nil }
            switch row {
            case .userText(_, let text, _, _), .agentText(_, let text, _, _, _):
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            default:
                return nil
            }
        }
        .joined(separator: "\n\n")
    }
}

/// What the system share sheet offers: a link with its title, or plain text.
struct ShareOutgoing: Identifiable {
    let id = UUID()
    var url: URL?
    var title: String?
    var text: String?

    var items: [Any] {
        if let url { return [ShareLinkSource(url: url, subject: title)] }
        return [text ?? ""]
    }
}

/// A link for the share sheet, with the share's title as a mail's subject.
final class ShareLinkSource: NSObject, UIActivityItemSource {
    let url: URL
    let subject: String?

    init(url: URL, subject: String?) {
        self.url = url
        self.subject = subject
    }

    func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { url }
    func activityViewController(_ controller: UIActivityViewController, itemForActivityType type: UIActivity.ActivityType?) -> Any? { url }
    func activityViewController(_ controller: UIActivityViewController, subjectForActivityType type: UIActivity.ActivityType?) -> String { subject ?? "" }
}

/// Sharing one chat: share mode, where the guardian picks turns and makes a
/// read-only public link of them, and the chat's list of links. A message's
/// Share and the "…" menu's Share chat both open share mode.
@Observable
@MainActor
final class ChatShareFlow {
    /// The turns picked; nil outside share mode.
    private(set) var selection: Set<String>?
    private(set) var creating = false
    /// A short line over Create link after a failure.
    private(set) var error: String?
    /// Set, the share sheet is up with it.
    var outgoing: ShareOutgoing?
    /// The Shared links sheet is up.
    var showsLinks = false
    /// The chat's links; nil until they load.
    private(set) var links: [ChatShareLink]?
    private(set) var linksFailed = false
    private(set) var revokeFailed = false

    @ObservationIgnored weak var chat: TranscriptStore?
    @ObservationIgnored private let backend: RomeBackend

    init(backend: RomeBackend) {
        self.backend = backend
    }

    var isSelecting: Bool { selection != nil }
    var count: Int { selection?.count ?? 0 }

    func isSelected(_ turn: String) -> Bool { selection?.contains(turn) ?? false }

    /// The chat's turns as its rows show them now.
    var turns: ShareTurns? {
        chat.map { ShareTurns(messages: $0.messages, rows: $0.rows) }
    }

    /// Share mode, with `turn` picked. An open chat thread closes: share mode
    /// works on the main timeline.
    func begin(turn: String?) {
        chat?.closeThread()
        selection = turn.map { [$0] } ?? []
        error = nil
    }

    /// A message's Share: share mode with that message's turn picked.
    func begin(fromRow rowId: String) {
        begin(turn: turns?.turnOfRow[rowId])
    }

    /// The "…" menu's Share chat: share mode with the newest turn picked.
    func beginWithLatest() {
        begin(turn: turns?.latest)
    }

    func toggle(_ turn: String) {
        guard var picked = selection else { return }
        if picked.remove(turn) == nil { picked.insert(turn) }
        selection = picked
        error = nil
    }

    func cancel() {
        selection = nil
        error = nil
    }

    /// The chat's id on the instance. The main chat's store may go by the
    /// fixed `concierge` id; its messages carry the real one.
    private var sessionId: String? {
        guard let chat else { return nil }
        return chat.messages.first { $0.turnId != nil }?.sessionId ?? chat.sessionId
    }

    /// Where the instance's links point: its origin, or the demo's host.
    private var origin: URL? {
        backend.origin ?? URL(string: "https://\(backend.displayOrigin)")
    }

    /// A share's `url` on the instance, made absolute.
    static func absoluteURL(_ path: String, origin: URL?) -> URL? {
        if let url = URL(string: path), url.scheme != nil { return url }
        guard let origin else { return nil }
        return URL(string: path, relativeTo: origin)?.absoluteURL
    }

    func url(of link: ChatShareLink) -> URL? { Self.absoluteURL(link.url, origin: origin) }

    /// Makes the link of the picked turns and offers it in the share sheet.
    /// An instance that refuses this chat (404: older ones cannot share a
    /// Concierge chat) gets the turns' text shared instead.
    func create() async {
        guard let chat, let sessionId, let picked = selection, !picked.isEmpty, !creating else { return }
        let turns = ShareTurns(messages: chat.messages, rows: chat.rows)
        let ordered = turns.order.filter(picked.contains)
        creating = true
        error = nil
        defer { creating = false }
        do {
            let link = try await backend.shareChat(sessionId: sessionId, turnIds: ordered)
            guard let url = url(of: link) else {
                error = String(localized: "Couldn't create the link.")
                return
            }
            outgoing = ShareOutgoing(url: url, title: link.title)
            links = links.map { [link] + $0 }
            selection = nil
        } catch APIError.notFound {
            outgoing = ShareOutgoing(text: turns.text(of: picked, rows: chat.rows))
            selection = nil
        } catch {
            self.error = String(localized: "Couldn't create the link.")
        }
    }

    func openLinks() {
        showsLinks = true
        Task { await loadLinks() }
    }

    func loadLinks() async {
        guard let sessionId else { return }
        linksFailed = false
        do {
            let loaded = try await backend.chatShares(sessionId: sessionId)
            links = loaded.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
        } catch {
            if links == nil { linksFailed = true }
        }
    }

    /// Stops a link from opening. It leaves the list at once and comes back
    /// if the instance refuses.
    func revoke(_ link: ChatShareLink) async {
        let before = links
        links?.removeAll { $0.id == link.id }
        revokeFailed = false
        do {
            try await backend.revokeShare(id: link.id)
        } catch {
            links = before
            revokeFailed = true
        }
    }
}

// MARK: Views

extension EnvironmentValues {
    /// The chat's turns while share mode is on, for its rows; nil otherwise.
    @Entry var shareTurns: ShareTurns? = nil
    /// The chat's sharing, for the "…" menu; nil where it cannot share.
    @Entry var chatShare: ChatShareFlow? = nil
}

/// A transcript row in share mode: its turn's check circle on the first row,
/// a soft tint while picked, and a tap anywhere on it toggles the turn.
/// Nothing inside the row acts meanwhile. `top` is the row's space above.
private struct ShareSelectable: ViewModifier {
    let rowId: String
    let share: ChatShareFlow
    let top: CGFloat
    @Environment(\.shareTurns) private var turns

    static let circleSpace: CGFloat = 34

    func body(content: Content) -> some View {
        let active = share.isSelecting
        let turn = active ? turns?.turnOfRow[rowId] : nil
        let lead = turns?.leadRows.contains(rowId) ?? false
        let picked = turn.map(share.isSelected) ?? false
        content
            .allowsHitTesting(!active)
            .padding(.leading, active ? Self.circleSpace : 0)
            // The first row's tint stops at its own top; later rows reach up
            // over the space above them, so a turn reads as one block.
            .background { if picked && lead { tint } }
            .overlay(alignment: .leading) {
                if active, lead, let turn {
                    ShareCheckCircle(on: picked)
                        .padding(.leading, 2)
                        .accessibilityHidden(true)
                        .onTapGesture { share.toggle(turn) }
                }
            }
            .padding(.top, top)
            .background { if picked && !lead { tint } }
            .overlay {
                if active, let turn {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { share.toggle(turn) }
                        // One element per turn, on its first row.
                        .accessibilityElement()
                        .accessibilityLabel("Select turn")
                        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
                        .accessibilityHidden(!lead)
                }
            }
            .animation(.easeOut(duration: 0.15), value: picked)
            .animation(.easeOut(duration: 0.2), value: active)
    }

    private var tint: some View {
        Rectangle()
            .fill(Palette.primarySoft.opacity(0.6))
            .padding(.horizontal, -Metrics.pagePadding)
    }
}

extension View {
    /// A transcript row that share mode can pick, with `top` space above it.
    func shareSelectable(_ row: TranscriptRow, share: ChatShareFlow, top: CGFloat) -> some View {
        modifier(ShareSelectable(rowId: row.id, share: share, top: top))
    }

    /// The chat's header, replaced by Cancel and the count in share mode. The
    /// header's "…" menu offers Share chat and Shared links. Nil: a chat not
    /// started yet, with nothing to share.
    func shareModeHeader(_ share: ChatShareFlow?) -> some View {
        let selecting = share?.isSelecting ?? false
        return self
            .environment(\.chatShare, share)
            .opacity(selecting ? 0 : 1)
            .allowsHitTesting(!selecting)
            .accessibilityHidden(selecting)
            .overlay {
                if selecting, let share { ShareModeBar(share: share) }
            }
    }

    /// The composer, replaced by Create link in share mode; also the share
    /// sheet and the Shared links sheet.
    @ViewBuilder
    func shareModeComposer(_ share: ChatShareFlow?) -> some View {
        if let share { modifier(ShareModeComposer(share: share)) } else { self }
    }
}

/// The "…" menu's Share chat and Shared links.
struct ChatShareMenuItems: View {
    let share: ChatShareFlow?

    var body: some View {
        if let share {
            Button { share.beginWithLatest() } label: { Label("Share chat", systemImage: "square.and.arrow.up") }
            Button { share.openLinks() } label: { Label("Shared links", systemImage: "link") }
        }
    }
}

/// A turn's check circle: an empty ring, or filled coral with a check.
struct ShareCheckCircle: View {
    let on: Bool

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(on ? Palette.primary : Palette.sub.opacity(0.55), lineWidth: 1.5)
                .background(Circle().fill(on ? Palette.primary : .clear))
            if on {
                Image(systemName: "checkmark")
                    .romeFont(11, .bold)
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 22, height: 22)
        .frame(width: 30, height: 44)
        .contentShape(Rectangle())
    }
}

/// Share mode's top bar: Cancel, and how many turns are picked.
private struct ShareModeBar: View {
    let share: ChatShareFlow

    var body: some View {
        ZStack {
            Text("\(share.count) selected")
                .romeFont(15, .semibold)
                .foregroundStyle(Palette.fg)
                .monospacedDigit()
                .padding(.horizontal, 16)
                .frame(height: 44)
                .glassSurface(Capsule())
                .accessibilityAddTraits(.isHeader)
            HStack {
                Button("Cancel") { share.cancel() }
                    .romeFont(15, .medium)
                    .foregroundStyle(Palette.fg)
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .glassSurface(Capsule(), interactive: true)
                    .buttonStyle(PressScaleStyle())
                Spacer()
            }
        }
        .padding(.horizontal, 12)
    }
}

private struct ShareModeComposer: ViewModifier {
    @Bindable var share: ChatShareFlow

    func body(content: Content) -> some View {
        Group {
            if share.isSelecting {
                VStack(spacing: 8) {
                    if let error = share.error {
                        Text(verbatim: error)
                            .romeFont(13, .medium)
                            .foregroundStyle(Palette.destructive)
                            .transition(.opacity)
                    }
                    PrimaryButton(title: "Create link", loadingTitle: "Creating…", loading: share.creating, disabled: share.count == 0) {
                        Task { await share.create() }
                    }
                }
                .onAppear { Keyboard.dismiss() }
            } else {
                content
            }
        }
        .animation(.easeOut(duration: 0.2), value: share.error)
        .sheet(item: $share.outgoing) { outgoing in
            ActivitySheet(items: outgoing.items)
                .presentationDetents([.medium, .large])
        }
        .modifier(SharedLinksPresenter(share: share))
    }
}

/// The Shared links sheet; on a snapshot run, its content in a sheet's frame.
private struct SharedLinksPresenter: ViewModifier {
    @Bindable var share: ChatShareFlow

    func body(content: Content) -> some View {
        #if DEBUG
        if SnapshotRunner.directory != nil {
            // A system sheet cannot be captured on Mac Catalyst: its content
            // in a large sheet's frame, reaching past the composer it hangs
            // from to the whole window.
            content.overlay(alignment: .bottom) {
                if share.showsLinks, let window = Self.window {
                    ZStack(alignment: .bottom) {
                        Color.black
                        SharedLinksSheet(share: share)
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                            .padding(.top, 64)
                    }
                    .frame(width: window.width, height: window.height)
                    // The composer sits 8 pt above the window's foot.
                    .offset(y: 8)
                }
            }
        } else {
            sheet(content)
        }
        #else
        sheet(content)
        #endif
    }

    #if DEBUG
    private static var window: CGSize? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first?.bounds.size
    }
    #endif

    private func sheet(_ content: Content) -> some View {
        content.sheet(isPresented: $share.showsLinks) {
            SharedLinksSheet(share: share)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.hidden)
                .presentationCornerRadius(22)
                .presentationBackground(Palette.sheet)
        }
    }
}

/// The chat's share links: tap one to send it again, swipe to stop sharing.
struct SharedLinksSheet: View {
    let share: ChatShareFlow
    @Environment(\.dismiss) private var dismiss
    @State private var outgoing: ShareOutgoing?

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.grabber)
                .frame(width: 36, height: 5)
                .padding(.top, 7)
            HStack {
                Text("Shared links")
                    .romeFont(24, .bold)
                    .tracking(-0.6)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                SheetCloseButton {
                    dismiss()
                    share.showsLinks = false
                }
            }
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 54)

            if let links = share.links {
                if links.isEmpty {
                    empty
                } else {
                    list(links)
                }
            } else if share.linksFailed {
                failed
            } else {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.sheet.ignoresSafeArea())
        .sheet(item: $outgoing) { outgoing in
            ActivitySheet(items: outgoing.items)
                .presentationDetents([.medium, .large])
        }
    }

    private func list(_ links: [ChatShareLink]) -> some View {
        List {
            if share.revokeFailed {
                Text("Couldn't stop sharing.")
                    .romeFont(13, .medium)
                    .foregroundStyle(Palette.destructive)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(links) { link in
                Button {
                    if let url = share.url(of: link) { outgoing = ShareOutgoing(url: url, title: link.title) }
                } label: {
                    SharedLinkRow(link: link)
                }
                .buttonStyle(RowPressStyle())
                .listRowBackground(Palette.elevated)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await share.revoke(link) }
                    } label: {
                        Label("Stop sharing", systemImage: "xmark.circle")
                    }
                }
                .contextMenu {
                    Button {
                        UIPasteboard.general.url = share.url(of: link)
                    } label: {
                        Label("Copy link", systemImage: "link")
                    }
                    Button(role: .destructive) {
                        Task { await share.revoke(link) }
                    } label: {
                        Label("Stop sharing", systemImage: "xmark.circle")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .animation(.easeOut(duration: 0.2), value: links)
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: "link")
                .romeFont(22, .semibold)
                .foregroundStyle(Palette.sub)
                .frame(width: 52, height: 52)
                .background(Palette.fillStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text("No shared links")
                .romeFont(17, .semibold)
                .padding(.top, 6)
            Text("Links you create in this chat show here.")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    private var failed: some View {
        VStack(spacing: 12) {
            Spacer()
            Text("Couldn't load the links.")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
            Button("Try again") { Task { await share.loadLinks() } }
                .romeFont(15, .semibold)
                .foregroundStyle(Palette.primaryText)
            Spacer()
            Spacer()
        }
    }
}

/// One link: its title, and when it was made.
private struct SharedLinkRow: View {
    let link: ChatShareLink

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "link")
                .romeFont(CardScale.iconGlyph, .medium)
                .foregroundStyle(Palette.primaryText)
                .frame(width: CardScale.iconBox, height: CardScale.iconBox)
                .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: CardScale.iconCorner, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Group {
                    if let title = link.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                        Text(verbatim: title)
                    } else {
                        Text("Shared chat")
                    }
                }
                .romeFont(16, .medium)
                .foregroundStyle(Palette.fg)
                .lineLimit(1)
                if let date = link.date {
                    Text(verbatim: RelativeTime.ago(date))
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "square.and.arrow.up")
                .romeFont(15, .medium)
                .foregroundStyle(Palette.sub)
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shares the link")
    }
}
