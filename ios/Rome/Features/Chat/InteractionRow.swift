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
    /// Chat's card to connect Claude or ChatGPT.
    case aiTools
    /// A provider failure card.
    case providerFailure
    case routineDraft
    case widget

    init?(_ row: TranscriptRow) {
        switch row {
        case .approval: self = .approval
        case .question(_, _, let sessionId, _): self = .question(sessionId: sessionId)
        case .connect: self = .connect
        case .tools: self = .tools
        case .webOnly: self = .webOnly
        case .aiTools: self = .aiTools
        case .providerFailure: self = .providerFailure
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
                QuestionCardView(part: part, answered: answered) { _, _ in WidgetEventReply() }
            }
        case .question(_, let part, _, let answered):
            QuestionCardView(part: part, answered: answered) { name, context in
                try await store.answerWidget(widgetId: part.ui?.widgetId ?? "", name: name, context: context)
            }
            .bubbleWidth()
        case .connect(let id, let part, let sessionId):
            ConnectCardView(part: part, phase: store.connectPhases[id] ?? TranscriptStore.previewPhase(part.service) ?? .idle) {
                store.connect(part, rowId: id, chatId: sessionId)
            }
            .task(id: id) { await store.checkConnected(part, rowId: id) }
            .bubbleWidth()
        case .widgetUI(_, let part, _, let answered):
            WidgetUICardView(part: part, call: { method, path, body in
                try await store.appCall(appId: part.appId, method: method, path: path, body: body)
            }, press: { name, context in
                try await store.answerWidget(widgetId: part.widgetId, name: name, context: context)
            }, waiting: part.waits ? .init(answered: answered) : nil)
            // An agent card, Rome's own card the agent composed, takes the
            // chat's width as on the web; an app's card and a card the agent
            // waits on keep a bubble's (docs/domains/chats.md#agent-card).
            .bubbleWidth(full: part.appId == "core" && !part.waits)
        case .webOnly(_, let kind, let done):
            WebOnlyCard(kind: kind, done: done, sessionId: store.sessionId)
                .bubbleWidth()
        case .aiTools(_, let toolUseId, let sessionId, let done) where !isVisitor:
            AIToolsCard(toolUseId: toolUseId, sessionId: sessionId, done: done, store: store)
                .bubbleWidth()
        case .aiTools(_, _, _, let done):
            // The guardian's accounts: a visitor's chat only points at the web.
            WebOnlyCard(kind: .aiTools, done: done, sessionId: store.sessionId)
                .bubbleWidth()
        case .providerFailure(_, let part, let messageId):
            ProviderFailureCardView(part: part, messageId: messageId, store: store)
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

/// Chat's card to connect Claude or ChatGPT (`ai-tools-card`): Connect opens
/// Settings at the AI Tools page. As on the web, the card answers itself
/// with `connected` once an account is logged in, and the turn goes on.
struct AIToolsCard: View {
    let toolUseId: String
    let sessionId: String
    let done: Bool
    let store: TranscriptStore
    @Environment(AppModel.self) private var model

    /// An account is logged in, or Rome credits were chosen: Chat can run.
    private var connected: Bool { model.workspace?.aiModel.runsChats == true }
    private var answering: Bool { store.answeringCards.contains(toolUseId) }
    private var failed: Bool { store.failedCards.contains(toolUseId) }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "sparkles")
                .romeFont(CardScale.iconGlyph)
                .foregroundStyle(Palette.fg)
                .frame(width: CardScale.iconBox, height: CardScale.iconBox)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: CardScale.iconCorner, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Connect Claude or ChatGPT")
                    .romeFont(CardScale.body)
                    .fixedSize(horizontal: false, vertical: true)
                if failed, !done, !answering {
                    Text("Could not continue")
                        .romeFont(CardScale.caption)
                        .foregroundStyle(Palette.destructive)
                } else if done || answering || connected {
                    Text(done ? "Done" : "Connected")
                        .romeFont(CardScale.caption)
                        .foregroundStyle(Palette.sub)
                }
            }
            Spacer(minLength: 0)
            if failed, !done, !answering, connected {
                // The answer did not go through: nothing else sends it again.
                Button("Retry") { answerIfConnected() }
                    .romeFont(CardScale.actionFont, .semibold)
                    .foregroundStyle(Palette.fg)
                    .padding(.horizontal, 14)
                    .frame(height: CardScale.actionHeight)
                    .background(Palette.fill, in: Capsule())
                    .buttonStyle(PressScaleStyle())
            } else if !done, !answering, !connected {
                Button("Connect") { model.openAIModel() }
                    .romeFont(CardScale.actionFont, .semibold)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: CardScale.actionHeight)
                    .background(Palette.primary, in: Capsule())
                    .buttonStyle(PressScaleStyle())
            }
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
        .task(id: done) {
            guard !done else { return }
            await model.workspace?.aiModel.refresh()
            answerIfConnected()
        }
        .onChange(of: connected) { answerIfConnected() }
    }

    private func answerIfConnected() {
        guard !done, connected else { return }
        let output = Self.answer(credits: model.workspace?.aiModel.hasLoggedInAccount != true)
        Task { await store.answerCard(toolUseId: toolUseId, sessionId: sessionId, output: output) }
    }

    /// The card's answer, as the web card writes it: credits run Rome as a
    /// sign-in does, and say so.
    static func answer(credits: Bool) -> JSONValue {
        var output: [String: JSONValue] = ["connected": .bool(true)]
        if credits { output["credits"] = .bool(true) }
        return .object(output)
    }
}
