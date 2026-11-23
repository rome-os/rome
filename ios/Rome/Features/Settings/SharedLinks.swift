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
    /// The sheet is up over Settings.
    var shows = false

    @ObservationIgnored private let backend: RomeBackend

    init(backend: RomeBackend) {
        self.backend = backend
    }

    /// Settings' Shared links: the sheet, then the links.
    func open() async {
        shows = true
        await load()
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

extension View {
    /// The Shared links sheet over Settings, up while `store.shows`.
    func sharedLinksSheet(_ store: SharedLinksStore) -> some View {
        modifier(SharedLinksPresenter(store: store))
    }
}

/// The Shared links sheet; on a snapshot run, its content in a sheet's frame.
private struct SharedLinksPresenter: ViewModifier {
    @Bindable var store: SharedLinksStore

    func body(content: Content) -> some View {
        #if DEBUG
        if SnapshotRunner.directory != nil {
            // A system sheet cannot be captured on Mac Catalyst: its content
            // in a large sheet's frame, over the whole window.
            content.overlay {
                if store.shows, let window = Self.window {
                    ZStack(alignment: .bottom) {
                        Color.black
                        SharedLinksSheet(store: store)
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
                            .padding(.top, 64)
                    }
                    .frame(width: window.width, height: window.height)
                    .ignoresSafeArea()
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
        content.sheet(isPresented: $store.shows) {
            SharedLinksSheet(store: store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.hidden)
                .presentationCornerRadius(22)
                .presentationBackground(Palette.sheet)
        }
    }
}

/// Every share link: tap one to send it again, swipe to stop sharing.
struct SharedLinksSheet: View {
    let store: SharedLinksStore
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
                    store.shows = false
                }
            }
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 54)

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
        .background(Palette.sheet.ignoresSafeArea())
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
        // Right under the title, as the Tasks sheet's list sits: the grouped
        // list's own top margin is far taller.
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
