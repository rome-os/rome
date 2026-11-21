import SwiftUI

/// A question or approval that no longer waits, folded to two lines: what it
/// asked, muted, then how it ended. A tap opens the whole card below it, read
/// only; with `onOpen` the tap is handed on instead, as an app's card opens
/// its task chat.
struct SettledCard<Full: View>: View {
    let title: String?
    let outcome: String
    /// The outcome reads as a way on ("answer to continue").
    var chevron = false
    var onOpen: (() -> Void)? = nil
    let full: Full?

    @State private var open = false

    init(title: String?, outcome: String, chevron: Bool = false, onOpen: (() -> Void)? = nil, @ViewBuilder full: () -> Full) {
        self.title = title
        self.outcome = outcome
        self.chevron = chevron
        self.onOpen = onOpen
        self.full = full()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if let onOpen {
                    onOpen()
                } else if full != nil {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { open.toggle() }
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    if let title, !title.isEmpty {
                        Text(verbatim: title)
                            .romeFont(CardScale.caption)
                            .foregroundStyle(Palette.sub)
                            .lineLimit(1)
                    }
                    HStack(spacing: 4) {
                        Text(verbatim: outcome)
                            .romeFont(CardScale.body)
                            .foregroundStyle(Palette.fg)
                            .lineLimit(1)
                        if chevron || (full != nil && onOpen == nil) {
                            Image(systemName: open ? "chevron.up" : "chevron.right")
                                .romeFont(10)
                                .foregroundStyle(Palette.sub.opacity(0.6))
                        }
                    }
                }
                // The bubble's full width, so answering or settling never changes it.
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CardScale.paddingH)
                .padding(.vertical, 9)
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
                .contentShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
            }
            .buttonStyle(PressScaleStyle(scale: 0.98))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            if open, let full {
                full
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        // Left, and as wide as a bubble can be.
        .bubbleWidth()
    }
}

extension SettledCard where Full == EmptyView {
    /// A card that only hands its tap on, or only shows its two lines.
    init(title: String?, outcome: String, chevron: Bool = false, onOpen: (() -> Void)? = nil) {
        self.title = title
        self.outcome = outcome
        self.chevron = chevron
        self.onOpen = onOpen
        full = nil
    }
}

/// A task's question or approval shown on its own in a Concierge chat
/// (`show: "ask"`), with no task card around it: the label under it names
/// the task. It is drawn from the `card` its message carries, and neither the
/// task chat nor the task list is read: whether it waits is the card's own
/// (`TaskAskCard.waits`). The newest one that waits takes its answer here.
/// Any other folds to what it asked and how it ended (answered, expired,
/// closed, or waiting on a newer copy), opening read only.
struct TaskAskView: View {
    let chatId: String
    let card: TaskAskCard?
    let latest: Bool
    let store: TranscriptStore
    let onOpenChat: () -> Void

    @Environment(\.isVisitor) private var isVisitor

    var body: some View {
        Group {
            switch card?.kind ?? .unavailable {
            case .unavailable:
                Text("This card is no longer available")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, CardScale.paddingH)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .question(let question):
                questionCard(question)
            case .approval(let approval):
                approvalCard(approval)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var mode: TaskAskMode { TaskAskMode.of(card: card, latest: latest) }

    @ViewBuilder
    private func questionCard(_ question: TaskAskCard.Question) -> some View {
        let part = card?.questionPart
        let title = part.map(SettledOutcome.title)
        switch mode {
        case .waiting:
            if let part {
                QuestionCardView(part: part, answered: nil) { name, context in
                    try await store.answerWidget(widgetId: part.ui?.widgetId ?? "", name: name, context: context)
                }
                .id(question.id)
                .bubbleWidth()
            } else {
                // An app's own card, such as a sign-in, is answered in its task chat.
                SettledCard(title: nil, outcome: String(localized: "Open the task chat to answer"), chevron: true, onOpen: onOpenChat)
            }
        case .settled:
            if let outcome = question.outcome, let part {
                SettledCard(title: title, outcome: SettledOutcome.answer(outcome.output)) {
                    QuestionCardView(part: part, answered: outcome.output) { _, _ in WidgetEventReply() }
                }
            } else {
                SettledCard(title: title, outcome: question.outcome.map { SettledOutcome.answer($0.output) } ?? String(localized: "Answered"))
            }
        case .expired, .closed, .open:
            // Read only: what it asked, and why it takes no answer here.
            if let part {
                SettledCard(title: title, outcome: mode.foldLine) {
                    QuestionCardView(part: part, answered: nil) { _, _ in WidgetEventReply() }
                }
            } else {
                SettledCard(title: title, outcome: mode.foldLine)
            }
        }
    }

    @ViewBuilder
    private func approvalCard(_ approval: TaskAskCard.Approval) -> some View {
        if let part = card?.approvalPart {
            switch mode {
            case .waiting:
                ApprovalCardView(
                    part: part,
                    status: .pending,
                    submitting: store.resolvingApproval[approval.id],
                    error: store.approvalErrors[approval.id],
                    resolvedAt: nil,
                    canResolve: !isVisitor
                ) { approve in
                    store.resolve(approval.id, approve: approve, watch: false)
                }
                .id(approval.id)
                .bubbleWidth()
            case .settled, .expired, .closed, .open:
                let line = approval.outcome.map(TaskAskCard.outcomeLine) ?? mode.foldLine
                SettledCard(title: SettledOutcome.title(part), outcome: line) {
                    ApprovalCardView(part: part, status: .pending, submitting: nil, error: nil, resolvedAt: nil, canResolve: false, settled: true, settledLabel: line) { _ in }
                }
            }
        }
    }
}

/// What a task's question or approval card draws. Read from the card alone,
/// as Rome filled it in and `chat_card_settled` replaced it since.
enum TaskAskMode: Equatable {
    /// It waits on its owner and is the newest card of its task: it takes an answer.
    case waiting
    /// Answered, dismissed, decided or turned down.
    case settled
    /// A question nobody answered in time. Read only.
    case expired
    /// Its task ended while it had no outcome. Read only.
    case closed
    /// It waits, yet a newer copy of its task takes the answer.
    case open

    static func of(card: TaskAskCard?, latest: Bool) -> TaskAskMode {
        guard let card, card.id != nil else { return .settled }
        if card.settled { return .settled }
        if card.expired { return .expired }
        if card.closed { return .closed }
        return latest ? .waiting : .open
    }

    /// The folded line of a card with no outcome.
    var foldLine: String {
        switch self {
        case .expired: return String(localized: "Expired: no answer within a day")
        case .closed: return String(localized: "Closed: the task ended")
        default: return String(localized: "Waiting: answer the card below")
        }
    }
}

/// The words of a folded question or approval card (docs/domains/chats.md).
enum SettledOutcome {
    /// An answer this long or shorter is repeated on the fold.
    static let shortAnswer = 24

    /// What a question card asked, its questions on one line.
    static func title(_ part: MessagePart.QuestionPart) -> String {
        part.questions.map(\.text).joined(separator: " · ")
    }

    static func title(_ part: MessagePart.ApprovalPart) -> String {
        part.title.flatMap { $0.isEmpty ? nil : $0 } ?? displayActionName(part.actionName)
    }

    /// "Answered: Tea" for a short answer, "Answered" for a long one, or
    /// "Dismissed".
    static func answer(_ output: JSONValue) -> String {
        if output["dismissed"]?.bool == true { return String(localized: "Dismissed") }
        let values = (output["answers"]?.array ?? [])
            .compactMap { $0["value"]?.string }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let text = values.joined(separator: ", ")
        guard !text.isEmpty, text.count <= shortAnswer else { return String(localized: "Answered") }
        return String(localized: "Answered: \(text)")
    }

    /// Whether an approval with this status folds: decided, and not failed,
    /// which keeps its own card.
    static func folds(_ status: ApprovalStatus) -> Bool {
        status != .pending && status != .failed
    }

    /// How a decided approval ended: approved, rejected by the guardian, or
    /// turned down by Rome as its task's wait ran out or its task stopped.
    static func approval(_ status: ApprovalStatus, resolvedBy: String?) -> String {
        if resolvedBy == "rome:task-ended" { return String(localized: "Turned down: no answer within a day") }
        if resolvedBy == "rome:task-stopped" { return String(localized: "Turned down: task stopped") }
        switch status {
        case .rejected: return String(localized: "Rejected")
        case .failed: return String(localized: "Approved, but didn't finish")
        default: return String(localized: "Approved")
        }
    }
}
