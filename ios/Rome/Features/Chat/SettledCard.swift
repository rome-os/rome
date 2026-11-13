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
/// the task. The newest one of a task that waits takes its answer here. An
/// expired one folds to one line that opens to the form, and counts as
/// waiting nowhere until then. Once answered, decided or turned down, or
/// superseded by a newer copy, it folds to what it asked and how it ended,
/// opening read only.
struct TaskAskView: View {
    let chatId: String
    let latest: Bool
    let shownAt: Date
    let tasks: TasksStore
    let wait: TaskWaitStore
    let onOpenChat: () -> Void

    @State private var openedExpired = false

    var body: some View {
        let session = tasks.chats[chatId]
        let mode = TaskAskMode.of(latest: latest, session: session, task: tasks.task(forChat: chatId), openedExpired: openedExpired)
        Group {
            switch mode {
            case .expired:
                SettledCard(title: expiredTitle, outcome: String(localized: "Expired · answer to continue"), chevron: true) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { openedExpired = true }
                }
                .task(id: "\(chatId)|\(tasks.task(forChat: chatId)?.openWait.map { "\($0)" } ?? "")") { await wait.load() }
            case .waiting(let expired):
                TaskWaitView(store: wait, session: session, onOpenChat: onOpenChat, note: expired ? "Expired — answer to continue" : nil, waitKey: tasks.task(forChat: chatId)?.openWait.map { "\($0)" } ?? "")
            case .settled:
                folded
                    // Read again only when the task's wait changed, not on every bit of its activity.
                    .task(id: "\(chatId)|\(shownAt.timeIntervalSince1970)|\(TaskWaitView.waits(session))|\(tasks.task(forChat: chatId)?.status ?? "")|\(tasks.task(forChat: chatId)?.endReason ?? "")") {
                        await wait.loadSettled(until: shownAt)
                    }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The expired question, as the task's card read gives it.
    private var expiredTitle: String? {
        if case .question(let part, _) = wait.card { return SettledOutcome.title(part) }
        return nil
    }

    @ViewBuilder
    private var folded: some View {
        if let ask = wait.settled[shownAt] {
            switch ask.kind {
            case .question(let part, let answer?):
                SettledCard(title: ask.title, outcome: ask.outcome) {
                    QuestionCardView(part: part, answered: answer, sending: false) { _ in }
                }
            case .question:
                // Still open: its newer copy below takes the answer, and this one does not open.
                SettledCard(title: ask.title, outcome: ask.outcome)
            case .approval(let part, _):
                SettledCard(title: ask.title, outcome: ask.outcome) {
                    ApprovalCardView(part: part, status: .pending, submitting: nil, error: nil, resolvedAt: nil, canResolve: false, settled: true, settledLabel: ask.outcome) { _ in }
                }
            }
        } else if wait.settledRead.contains(shownAt) || wait.settledFailed.contains(shownAt) {
            // The card could not be found, or read: a plain line holds its place.
            SettledCard(title: nil, outcome: String(localized: "Answered"))
        } else {
            // Its place is held while the task chat is read, so nothing
            // below jumps when it lands; the read runs from here.
            Color.clear.frame(height: 52)
        }
    }
}

/// What a `show: "ask"` card draws.
enum TaskAskMode: Equatable {
    /// The task waits on this card: it takes an answer. `expired`: its wait
    /// ran out and it was opened again, so it waits on no one.
    case waiting(expired: Bool)
    /// Its wait ran out: one folded line until it is opened.
    case expired
    /// Answered, decided, turned down, or not the newest copy.
    case settled

    static func of(latest: Bool, session: ChatSession?, task: ConciergeTask?, openedExpired: Bool) -> TaskAskMode {
        guard latest, TaskWaitView.waits(session) else { return .settled }
        let expired = task?.status == "ended" && task?.endReason == "no_response"
        if expired && !openedExpired { return .expired }
        return .waiting(expired: expired)
    }
}
