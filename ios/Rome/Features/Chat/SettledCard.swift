import SwiftUI

/// A question or approval that no longer waits, folded to two lines: what it
/// asked, muted, then how it ended. A tap opens the whole card below it, read
/// only; with `onOpen` the tap is handed on instead, as an expired question
/// opens its form and an app's card opens its task chat.
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
        // Hugs its words, left, never wider than a bubble.
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
/// the task. It is drawn from the `card` its message carries, and the task
/// chat is never read. The newest one of a task that waits takes its answer
/// here. An expired one folds to one line that opens to the form, and counts
/// as waiting nowhere until then. Once answered, decided or turned down, or
/// superseded by a newer copy, it folds to what it asked and how it ended,
/// opening read only.
struct TaskAskView: View {
    let chatId: String
    let card: TaskAskCard?
    let latest: Bool
    let tasks: TasksStore
    let store: TranscriptStore
    let onOpenChat: () -> Void

    @State private var openedExpired = false
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

    private var mode: TaskAskMode {
        TaskAskMode.of(card: card, latest: latest, task: tasks.task(forChat: chatId))
    }

    @ViewBuilder
    private func questionCard(_ question: TaskAskCard.Question) -> some View {
        let part = card?.questionPart
        let title = part.map(SettledOutcome.title)
        switch mode {
        case .settled:
            if let outcome = question.outcome, let part {
                SettledCard(title: title, outcome: SettledOutcome.answer(outcome.output)) {
                    QuestionCardView(part: part, answered: outcome.output, sending: false) { _ in }
                }
            } else {
                SettledCard(title: title, outcome: question.outcome.map { SettledOutcome.answer($0.output) } ?? String(localized: "Answered"))
            }
        case .expired where !openedExpired:
            SettledCard(title: title, outcome: String(localized: "Expired · answer to continue"), chevron: true) {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { openedExpired = true }
            }
        case .waiting, .expired:
            if let part {
                QuestionCardView(part: part, answered: store.localAnswers[question.id], sending: store.answering.contains(question.id)) { answers in
                    store.answer(part, answers: answers, sessionId: chatId)
                }
                .id(question.id)
                .bubbleWidth()
            } else {
                // An app's own card, such as a sign-in, is answered in its task chat.
                SettledCard(title: nil, outcome: String(localized: "Open the task chat to answer"), chevron: true, onOpen: onOpenChat)
            }
        case .open:
            // Its newer copy below takes the answer, or the task no longer waits.
            SettledCard(title: title, outcome: latest ? String(localized: "No longer waiting") : String(localized: "Waiting: answer the card below"))
        }
    }

    @ViewBuilder
    private func approvalCard(_ approval: TaskAskCard.Approval) -> some View {
        if let part = card?.approvalPart {
            switch mode {
            case .settled:
                let line = approval.outcome.map(TaskAskCard.outcomeLine) ?? ""
                SettledCard(title: SettledOutcome.title(part), outcome: line) {
                    ApprovalCardView(part: part, status: .pending, submitting: nil, error: nil, resolvedAt: nil, canResolve: false, settled: true, settledLabel: line) { _ in }
                }
            case .waiting, .expired:
                ApprovalCardView(
                    part: part,
                    status: .pending,
                    submitting: store.resolvingApproval[approval.id],
                    error: store.approvalErrors[approval.id],
                    resolvedAt: nil,
                    canResolve: !isVisitor
                ) { approve in
                    store.resolve(approval.id, approve: approve)
                }
                .id(approval.id)
                .bubbleWidth()
            case .open:
                SettledCard(title: SettledOutcome.title(part), outcome: latest ? String(localized: "No longer waiting") : String(localized: "Waiting: answer the card below"))
            }
        }
    }
}

/// What a task's question or approval card draws.
enum TaskAskMode: Equatable {
    /// The task waits on this card: it takes an answer.
    case waiting
    /// A question nobody answered in time: one folded line until it is
    /// opened, then the form. It waits on no one.
    case expired
    /// Answered, dismissed, decided or turned down.
    case settled
    /// Not answered, yet not waiting: not the newest card of its task, or its task moved on.
    case open

    /// The newest card of its task chat, with no outcome, whose task needs the
    /// guardian and whose open wait is this card, takes the answer.
    static func of(card: TaskAskCard?, latest: Bool, task: ConciergeTask?) -> TaskAskMode {
        guard let card, let id = card.id else { return .settled }
        if card.settled { return .settled }
        if card.expired { return .expired }
        guard latest, task?.status == "needs_you", task?.waitId == id else { return .open }
        return .waiting
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
        case .failed: return String(localized: "Approved, but did not finish")
        default: return String(localized: "Approved")
        }
    }
}
