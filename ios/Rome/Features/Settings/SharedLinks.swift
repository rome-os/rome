import SwiftUI
import UIKit

/// Every live share link of the signed-in person, across all their chats, as
/// Settings lists them. Each link can be sent again, copied or revoked here;
/// no chat screen lists links.
@Observable
@MainActor
final class SharedLinksStore {
    /// The links, newest first; nil until they load.
    private(set) var links: [ChatShareLink]?
    private(set) var failed = false
    private(set) var revokeFailed = false

    @ObservationIgnored private let backend: RomeBackend

    init(backend: RomeBackend) {
        self.backend = backend
    }

    func load() async {
        failed = false
        do {
            links = Self.newestFirst(try await backend.allShares())
        } catch {
            if links == nil { failed = true }
        }
    }

    /// Where the instance's links point: its origin, or the demo's host.
    private var origin: URL? {
        backend.origin ?? URL(string: "https://\(backend.displayOrigin)")
    }

    func url(of link: ChatShareLink) -> URL? { ChatShareFlow.absoluteURL(link.url, origin: origin) }

    /// Stops a link from opening. It leaves the list at once. If the
    /// instance refuses, that link alone comes back, into the list as it is
    /// by then; one the instance no longer knows was revoked already.
    func revoke(_ link: ChatShareLink) async {
        links?.removeAll { $0.id == link.id }
        revokeFailed = false
        do {
            try await backend.revokeShare(id: link.id)
        } catch APIError.notFound {
            // Gone already: nothing to put back.
        } catch {
            if let current = links, !current.contains(where: { $0.id == link.id }) {
                links = Self.newestFirst(current + [link])
            }
            revokeFailed = true
        }
    }

    private static func newestFirst(_ links: [ChatShareLink]) -> [ChatShareLink] {
        links.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }
}

/// Settings' Shared links page: tap a link to send it again, swipe to stop
/// sharing. A page pushed in Settings, not a sheet over it, so nothing of
/// Settings shows around it.
struct SharedLinksScreen: View {
    let store: SharedLinksStore
    @State private var outgoing: ShareOutgoing?

    var body: some View {
        VStack(spacing: 0) {
            if let links = store.links {
                if links.isEmpty {
                    empty
                } else {
                    list(links)
                }
            } else if store.failed {
                failed
            } else {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "Shared links", inSheet: true) }
        .secondaryPageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .task { await store.load() }
        .sheet(item: $outgoing) { outgoing in
            ActivitySheet(items: outgoing.items)
                .presentationDetents([.medium, .large])
        }
    }

    private func list(_ links: [ChatShareLink]) -> some View {
        List {
            if store.revokeFailed {
                Text("Couldn't stop sharing.")
                    .romeFont(13, .medium)
                    .foregroundStyle(Palette.destructive)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(links) { link in
                Button {
                    if let url = store.url(of: link) { outgoing = ShareOutgoing(url: url, title: link.title) }
                } label: {
                    SharedLinkRow(link: link)
                }
                .buttonStyle(RowPressStyle())
                .listRowBackground(Palette.elevated)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await store.revoke(link) }
                    } label: {
                        Label("Stop sharing", systemImage: "xmark.circle")
                    }
                }
                .contextMenu {
                    Button {
                        UIPasteboard.general.url = store.url(of: link)
                    } label: {
                        Label("Copy link", systemImage: "link")
                    }
                    Button(role: .destructive) {
                        Task { await store.revoke(link) }
                    } label: {
                        Label("Stop sharing", systemImage: "xmark.circle")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        // Right under the header: the grouped list's own top margin is far
        // taller.
        .contentMargins(.top, 4, for: .scrollContent)
        .listSectionSpacing(.compact)
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
            Text("Links you share from a chat show here.")
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
            Button("Try again") { Task { await store.load() } }
                .romeFont(15, .semibold)
                .foregroundStyle(Palette.primaryText)
            Spacer()
            Spacer()
        }
    }
}

/// One link: its title, and under it its chat's name and when it was made.
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
                if let detail = Self.detail(of: link) {
                    Text(verbatim: detail)
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
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

    /// "Trip to Lisbon · 2d ago": the chat's name, then the date; either
    /// alone when the other is missing.
    static func detail(of link: ChatShareLink) -> String? {
        let chat = link.chatName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = [chat?.isEmpty == false ? chat : nil, link.date.map { RelativeTime.ago($0) }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
