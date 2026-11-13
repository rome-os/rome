import SwiftUI

/// The question or approval a waiting task asks, under its card in the main
/// Chat, with the same controls the task chat has. It reads the task once
/// it waits and again whenever the task's state moves; nothing polls.
struct TaskWaitView: View {
    let store: TaskWaitStore
    let session: ChatSession?
    /// Opens the task chat, for a card answered only there.
    var onOpenChat: () -> Void = {}
    /// A line above the card: an expired question says it still takes an answer.
    var note: LocalizedStringKey? = nil
    /// What the task's row says it waits for: a change reads the card again.
    var waitKey = ""
    @Environment(\.isVisitor) private var isVisitor

    /// Only a task that waits on the guardian and is not running shows a card.
    static func waits(_ session: ChatSession?) -> Bool {
        session?.awaitingGuardian == true && session?.running != true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = store.error {
                Text(verbatim: error)
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            }
            if let note, store.card != nil {
                Text(note)
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            }
            switch store.card {
            case .question(let part, let key):
                QuestionCardView(part: part, answered: store.sent[key], sending: store.answering == key) { answers in
                    Task { await store.answer(part, key: key, answers: answers) }
                }
                .id(key)
                .bubbleWidth()
            case .approval(let approval):
                ApprovalCardView(
                    part: approval.part,
                    status: ApprovalStatus.derive(stored: "pending", record: store.approvalRecord),
                    submitting: store.resolving,
                    error: nil,
                    resolvedAt: nil,
                    canResolve: !isVisitor
                ) { approve in
                    Task { await store.resolve(approve: approve) }
                }
                .id(approval.id)
                .bubbleWidth()
            case .elsewhere:
                // An app's own card, such as a sign-in, is answered in its task chat.
                SettledCard(title: nil, outcome: String(localized: "Open the task chat to answer"), chevron: true, onOpen: onOpenChat)
            case nil:
                EmptyView()
            }
        }
        // The task's state moved (it ran, stopped, or asks again): read it again.
        .task(id: "\(session?.running ?? false)|\(session?.awaitingGuardian ?? false)|\(session?.activityAt ?? "")|\(waitKey)") {
            await store.load()
        }
    }
}
