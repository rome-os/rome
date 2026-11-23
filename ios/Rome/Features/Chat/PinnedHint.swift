import SwiftUI

/// What a chat that does not follow the default says about it, in the
/// transcript's last row: where it runs and who pinned it there
/// (docs/domains/agents.md#pinned-chat).
enum PinnedHint {
    /// "On ChatGPT" for a kept chat, "You picked Haiku 5.5" for its owner's
    /// pick; nil while the chat follows the default or the server does not say.
    static func text(_ session: ChatSession?) -> String? {
        guard let session, session.followsDefault == false else { return nil }
        let pin = session.pinnedModel
        let provider = pin.map { DefaultModelProvider(wire: $0.providerId).name }
        let model = pin?.model.map(ModelNames.display).flatMap { $0.isEmpty ? nil : $0 }
        if pin?.by == "owner", let name = model ?? provider {
            return String(localized: "You picked \(name)")
        }
        // A held fork names only its provider.
        guard let provider else { return nil }
        return String(localized: "On \(provider)")
    }
}

extension PinnedHint {
    /// What the confirm before Back to default says: where the chat moves
    /// from, and the default it follows from its next reply.
    static func confirmBody(_ session: ChatSession?, default provider: DefaultModelProvider?) -> String {
        guard let provider else {
            return String(localized: "This chat follows your default from its next reply.")
        }
        let pin = session?.pinnedModel
        let to = provider.name
        if pin?.by == "owner" {
            let name = pin?.model.map(ModelNames.display).flatMap { $0.isEmpty ? nil : $0 }
                ?? pin.map { DefaultModelProvider(wire: $0.providerId).name } ?? to
            return String(localized: "This chat stops using \(name) and follows your default, \(to), from its next reply.")
        }
        let from = pin.map { DefaultModelProvider(wire: $0.providerId).name } ?? to
        return String(localized: "This chat moves from \(from) to \(to), your default, from its next reply.")
    }
}

/// The transcript's last row while the chat is pinned, with "Back to
/// default", which asks first. It scrolls with the chat, and new messages
/// land above it. Visitors see none: the default is the guardian's.
struct PinnedHintLine: View {
    let store: TranscriptStore

    /// The row for `TranscriptList`'s footer; nil while the chat follows the
    /// default, or for a visitor.
    static func footer(_ store: TranscriptStore, visitor: Bool) -> AnyView? {
        guard !visitor, PinnedHint.text(store.chatSession) != nil else { return nil }
        return AnyView(PinnedHintLine(store: store))
    }

    var body: some View {
        if let text = PinnedHint.text(store.chatSession) {
            HStack(spacing: 4) {
                Text(verbatim: "\(text) ·")
                    .lineLimit(1)
                    .truncationMode(.tail)
                Button {
                    // A hosted cell presents nothing: the chat's screen asks.
                    store.confirmsFollowDefault = true
                } label: {
                    Text("Back to default")
                        .underline(true, color: Palette.faint)
                        // A 44 pt tap target that takes no more room than the text.
                        .padding(.vertical, 14)
                        .contentShape(Rectangle())
                        .padding(.vertical, -14)
                }
                .buttonStyle(.plain)
                .disabled(store.followingDefault)
                .layoutPriority(1)
            }
            .romeFont(12)
            .foregroundStyle(Palette.faint)
            .frame(maxWidth: .infinity)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("pinned-hint")
        }
    }
}
