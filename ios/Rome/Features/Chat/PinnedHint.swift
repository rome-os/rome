import SwiftUI

/// What a chat that does not follow the default says about it, above the
/// composer: where it runs and who pinned it there
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

/// The quiet line above the composer while the chat is pinned, with
/// "Back to default". Visitors see none: the default is the guardian's.
struct PinnedHintLine: View {
    let store: TranscriptStore
    @Environment(\.isVisitor) private var isVisitor

    var body: some View {
        if !isVisitor, let text = PinnedHint.text(store.chatSession) {
            HStack(spacing: 4) {
                Text(verbatim: text)
                    .foregroundStyle(Palette.sub)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(verbatim: "·").foregroundStyle(Palette.sub)
                Button {
                    Task { await store.followDefault() }
                } label: {
                    Text("Back to default")
                        .foregroundStyle(Palette.primary)
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.followingDefault)
                .layoutPriority(1)
            }
            .romeFont(13)
            .frame(maxWidth: .infinity)
            .transition(.opacity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("pinned-hint")
        }
    }
}
