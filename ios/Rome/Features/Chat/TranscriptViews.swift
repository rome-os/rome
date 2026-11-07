import SwiftUI

/// The guardian's bubble: coral, right-aligned, fully round.
struct UserBubble: View {
    let text: String
    let pending: PendingSend.State?
    var onRetry: () -> Void = {}

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                if pending == .failed {
                    Button(action: onRetry) { AlertGlyph(size: 18) }
                        .frame(width: 28, height: 28)
                        .accessibilityLabel("Not sent. Tap to retry.")
                }
                Text(text)
                    .romeFont(16)
                    .lineSpacing(5)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Palette.primary, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                    .opacity(pending == .sending ? 0.55 : 1)
                    .contextMenu { CopyButton(text: text) }
            }
            if pending == .failed {
                Button("Not sent · Tap to retry", action: onRetry)
                    .romeFont(12, .medium)
                    .foregroundStyle(Palette.destructive)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 56)
        .animation(.easeOut(duration: 0.2), value: pending)
    }
}

/// The agent's bubble. In a run of bubbles the first keeps a small bottom-left
/// corner and the last a small top-left corner, as on the design's Chat board.
/// Every reply sits in a bubble, a long one too: past about fifteen lines it
/// folds, with "Show more".
struct AgentBubble: View {
    let text: String
    let forwardedFrom: MessagePart.ForwardedFrom?
    let position: BubblePosition
    var onOpenChat: (String, String) -> Void = { _, _ in }
    @State private var expanded = false

    /// How many lines a bubble shows before it folds.
    nonisolated static let foldedLines = 15

    /// Whether `text` runs past `foldedLines` in a bubble: each paragraph
    /// counts its wrapped lines at about 34 characters a line.
    nonisolated static func folds(_ text: String) -> Bool {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) { total, line in
            total + max(1, Int((Double(line.count) / 34).rounded(.up)))
        }
        return lines > foldedLines
    }

    private var shape: UnevenRoundedRectangle {
        let big = Metrics.bubbleRadius
        let small = Metrics.bubbleTight
        let topLeft = position == .last || position == .middle ? small : big
        let bottomLeft = position == .first || position == .middle ? small : big
        return UnevenRoundedRectangle(
            topLeadingRadius: topLeft, bottomLeadingRadius: bottomLeft,
            bottomTrailingRadius: big, topTrailingRadius: big, style: .continuous
        )
    }

    private var folds: Bool { Self.folds(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let forwardedFrom {
                Button {
                    onOpenChat(forwardedFrom.chatId, forwardedFrom.title)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.right").romeFont(11, .semibold)
                        Text("From “\(forwardedFrom.title)”").lineLimit(1)
                    }
                    .romeFont(12, .semibold)
                    .foregroundStyle(Palette.sub)
                }
                .buttonStyle(.plain)
            }
            MarkdownText(source: text)
                .frame(maxHeight: folds && !expanded ? 330 : nil, alignment: .top)
                .clipped()
                .overlay(alignment: .bottom) {
                    if folds && !expanded {
                        LinearGradient(colors: [Palette.bubble.opacity(0), Palette.bubble], startPoint: .top, endPoint: .bottom)
                            .frame(height: 48)
                            .allowsHitTesting(false)
                    }
                }
            if folds { expandButton }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Palette.bubble, in: shape)
        .overlay(alignment: .leading) {
            if forwardedFrom != nil {
                Capsule().fill(Palette.sub.opacity(0.55)).frame(width: 3).padding(.vertical, 10).padding(.leading, 5)
            }
        }
        .contextMenu { CopyButton(text: text) }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, forwardedFrom == nil ? 64 : 32)
    }

    private var expandButton: some View {
        Button(expanded ? "Show less" : "Show more") {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { expanded.toggle() }
        }
        .romeFont(14, .semibold)
        .foregroundStyle(Palette.primaryText)
    }
}

struct CopyButton: View {
    let text: String

    var body: some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
    }
}

/// A card for a task chat the Concierge started: "Task" + status, then its title.
/// A task the Concierge started, as a card in the chat: the label and the
/// title. Its status is left out, since progress is not reported accurately.
struct TaskCard: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Task")
                    .romeFont(12, .semibold)
                    .foregroundStyle(Palette.sub)
                HStack(spacing: 8) {
                    Text(title)
                        .romeFont(16, .semibold)
                        .tracking(-0.3)
                        .foregroundStyle(Palette.fg)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .romeFont(12, .bold)
                        .foregroundStyle(Palette.sub)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 13)
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .softElevation(radius: Metrics.cardRadius)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .containerRelativeFrame(.horizontal) { width, _ in (width - 32) * 0.82 }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Task, \(title)")
    }
}

struct TimeSeparator: View {
    let date: Date

    var body: some View {
        Text(RelativeTime.separator(date))
            .romeFont(12, .medium)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The spacing above a row, which carries the design's rhythm: 3 pt inside a
/// run, 18 pt when the sender changes, room around time separators.
enum TranscriptSpacing {
    static func top(_ row: TranscriptRow, after previous: TranscriptRow?) -> CGFloat {
        guard let previous else { return 8 }
        if case .separator = row { return 20 }
        if case .separator = previous { return 14 }
        if case .typing = row { return 14 }
        if row.isGuardian != previous.isGuardian { return 18 }
        if row.isGuardian { return 6 }
        switch (row, previous) {
        case (.agentText, .agentText): return 3
        case (.taskCard, .agentText), (.agentText, .taskCard), (.taskCard, .taskCard): return 6
        default: return 12
        }
    }
}

/// The capsule composer: a growing text field and a round send button.
struct Composer: View {
    @Binding var text: String
    let placeholder: LocalizedStringKey
    var stopVisible = false
    var stopping = false
    var focus: FocusState<Bool>.Binding
    let onSend: () -> Void
    var onStop: () -> Void = {}

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .romeFont(16)
                .lineLimit(1...6)
                .focused(focus)
                .padding(.vertical, 14)
                .tint(Palette.primary)
            Group {
                if stopVisible && !canSend {
                    Button(action: onStop) {
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(Palette.bg)
                            .frame(width: 12, height: 12)
                            .frame(width: 36, height: 36)
                            .background(Palette.fg, in: Circle())
                            .opacity(stopping ? 0.5 : 1)
                    }
                    .disabled(stopping)
                    .accessibilityLabel("Stop")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Button(action: onSend) {
                        Image(systemName: "arrow.up")
                            .romeFont(16, .bold)
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Palette.primary, in: Circle())
                            .opacity(canSend ? 1 : 0.35)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Send")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .buttonStyle(PressScaleStyle(scale: 0.9))
            .padding(.bottom, 7)
        }
        .padding(.leading, 18)
        .padding(.trailing, 7)
        .frame(minHeight: 50)
        // Glass like the header's buttons: the transcript shows through.
        .glassSurface(RoundedRectangle(cornerRadius: 25, style: .continuous), interactive: true)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: canSend)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: stopVisible)
    }
}
