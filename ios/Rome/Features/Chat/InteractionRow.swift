import SwiftUI

/// Which card a row that asks or reports draws. The same in every chat: the
/// main chat, a topic chat and a task chat.
enum InteractionCard: Equatable {
    case approval
    case question(sessionId: String)
    case connect
    case tools
    /// Drawn only on the web dashboard; "Open" goes to this chat there.
    case webOnly
    case routineDraft
    case widget

    init?(_ row: TranscriptRow) {
        switch row {
        case .approval: self = .approval
        case .question(_, _, let sessionId, _): self = .question(sessionId: sessionId)
        case .connect: self = .connect
        case .tools: self = .tools
        case .webOnly: self = .webOnly
        case .routineDraft: self = .routineDraft
        case .widgetUI: self = .widget
        default: return nil
        }
    }
}

/// An approval or question card answered here, a tool summary, or the link
/// to the web for the rest. Answers go to the row's own session.
struct InteractionRow: View {
    let row: TranscriptRow
    let store: TranscriptStore
    @Environment(\.isVisitor) private var isVisitor

    var body: some View {
        switch row {
        case .tools(_, let traceID, let count):
            ToolSummary(count: count, calls: store.toolCalls[traceID]) { store.loadToolCalls(traceID) }
        case .approval(_, let part, _) where store.approvals[part.approvalId] != nil && SettledOutcome.folds(store.approvalStatus(part)):
            // Decided: folded to what it asked and how it ended, opening read only.
            let outcome = SettledOutcome.approval(store.approvalStatus(part), resolvedBy: store.approvals[part.approvalId]?.resolvedBy)
            SettledCard(title: SettledOutcome.title(part), outcome: outcome) {
                ApprovalCardView(part: part, status: .pending, submitting: nil, error: nil, resolvedAt: nil, canResolve: false, settled: true, settledLabel: outcome) { _ in }
            }
            // Decided is not done: an approved one may still fail and unfold, so its record stays watched.
            .onAppear { if !isVisitor { store.watchApproval(part.approvalId) } }
        case .approval(_, let part, _):
            ApprovalCardView(
                part: part,
                status: store.approvals[part.approvalId] == nil ? nil : store.approvalStatus(part),
                submitting: store.resolvingApproval[part.approvalId],
                error: store.approvalErrors[part.approvalId],
                resolvedAt: RomeDate.parse(store.approvals[part.approvalId]?.resolvedAt ?? store.approvals[part.approvalId]?.updatedAt),
                canResolve: !isVisitor
            ) { approve in
                store.resolve(part.approvalId, approve: approve)
            }
            // The record is the guardian's to read: a visitor would only get 403s.
            .onAppear { if !isVisitor { store.watchApproval(part.approvalId) } }
            .bubbleWidth()
        case .question(_, let part, _, let answered?):
            SettledCard(title: SettledOutcome.title(part), outcome: SettledOutcome.answer(answered)) {
                QuestionCardView(part: part, answered: answered, sending: false) { _, _ in }
            }
        case .question(_, let part, let sessionId, let answered):
            QuestionCardView(part: part, answered: answered, sending: store.answering.contains(part.toolUseId)) { name, context in
                store.answer(widgetId: part.ui?.widgetId ?? "", toolUseId: part.toolUseId, name: name, context: context, sessionId: sessionId)
            }
            .bubbleWidth()
        case .connect(let id, let part, let sessionId):
            ConnectCardView(part: part, phase: store.connectPhases[id] ?? TranscriptStore.previewPhase(part.service) ?? .idle) {
                store.connect(part, rowId: id, chatId: sessionId)
            }
            .task(id: id) { await store.checkConnected(part, rowId: id) }
            .bubbleWidth()
        case .widgetUI(_, let part, _):
            WidgetUICardView(part: part, call: { method, path, body in
                try await store.appCall(appId: part.appId, method: method, path: path, body: body)
            }, press: { name, context in
                try await store.answerWidget(widgetId: part.widgetId, name: name, context: context)
            })
            .bubbleWidth()
        case .webOnly(_, let kind, let done):
            WebOnlyCard(kind: kind, done: done, sessionId: store.sessionId)
                .bubbleWidth()
        case .routineDraft(_, let part):
            RoutineDraftCardView(part: part, status: store.routineStatus(part), canTurnOn: !isVisitor, sessionId: store.sessionId)
                .task { if !isVisitor { await store.loadRoutines() } }
                .bubbleWidth()
        default:
            EmptyView()
        }
    }
}
