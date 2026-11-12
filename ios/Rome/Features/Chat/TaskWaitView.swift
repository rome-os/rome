import SwiftUI

/// The question or approval a waiting task asks, under its card in the main
/// Chat, with the same controls the task chat has. It reads the task once
/// it waits and again whenever the task's state moves; nothing polls.
struct TaskWaitView: View {
    let store: TaskWaitStore
    let session: ChatSession?
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
            switch store.card {
            case .question(let part, let key):
                QuestionCardView(part: part, answered: store.sent[key], sending: store.answering == key) { output in
                    Task { await store.answer(part, key: key, output: output) }
                }
                .id(key)
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
            case nil:
                EmptyView()
            }
        }
        // The task's state moved (it ran, stopped, or asks again): read it again.
        .task(id: "\(session?.running ?? false)|\(session?.awaitingGuardian ?? false)|\(session?.activityAt ?? "")") {
            await store.load()
        }
    }
}
