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
                        .accessibilityLabel("发送失败，点按重试")
                }
                Text(text)
                    .font(.system(size: 16))
                    .lineSpacing(5)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Palette.primary, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
                    .opacity(pending == .sending ? 0.55 : 1)
                    .contextMenu { CopyButton(text: text) }
            }
            if pending == .failed {
                Button("未发送 · 点按重试", action: onRetry)
                    .font(.system(size: 12, weight: .medium))
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
struct AgentBubble: View {
    let text: String
    let long: Bool
    let forwardedFrom: MessagePart.ForwardedFrom?
    let position: BubblePosition
    var onOpenChat: (String, String) -> Void = { _, _ in }
    @State private var expanded = false

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

    private var isTall: Bool { text.count > 600 }

    var body: some View {
        if long && forwardedFrom == nil {
            // A long message reads as a document: full width, no bubble.
            VStack(alignment: .leading, spacing: 8) {
                MarkdownText(source: text, lineSpacing: 6)
                    .frame(maxHeight: isTall && !expanded ? 360 : nil, alignment: .top)
                    .clipped()
                    .overlay(alignment: .bottom) {
                        if isTall && !expanded {
                            LinearGradient(colors: [Palette.bg.opacity(0), Palette.bg], startPoint: .top, endPoint: .bottom)
                                .frame(height: 64)
                        }
                    }
                if isTall { expandButton }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu { CopyButton(text: text) }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if let forwardedFrom {
                    Button {
                        onOpenChat(forwardedFrom.chatId, forwardedFrom.title)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "arrowshape.turn.up.right").font(.system(size: 11, weight: .semibold))
                            Text("来自「\(forwardedFrom.title)」").lineLimit(1)
                        }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.sub)
                    }
                    .buttonStyle(.plain)
                }
                MarkdownText(source: text)
                    .frame(maxHeight: isTall && !expanded ? 320 : nil, alignment: .top)
                    .clipped()
                if isTall { expandButton }
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
    }

    private var expandButton: some View {
        Button(expanded ? "收起" : "展开全文") {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { expanded.toggle() }
        }
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Palette.primaryText)
    }
}

struct CopyButton: View {
    let text: String

    var body: some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Label("复制", systemImage: "doc.on.doc")
        }
    }
}

/// A card for a task chat the Concierge started: "任务" + status, then its title.
struct TaskCard: View {
    let title: String
    let tone: TaskTone
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("任务")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.sub)
                    Spacer(minLength: 0)
                    if tone != .neutral { StatusPill(tone: tone) }
                }
                HStack(spacing: 8) {
                    Text(title)
                        .font(.system(size: 16, weight: .semibold))
                        .tracking(-0.3)
                        .foregroundStyle(Palette.fg)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .bold))
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
        .animation(.easeInOut(duration: 0.25), value: tone)
        .accessibilityLabel("任务，\(title)，\(tone.label)")
    }
}

struct TimeSeparator: View {
    let date: Date

    var body: some View {
        Text(RelativeTime.separator(date))
            .font(.system(size: 12, weight: .medium))
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
    let placeholder: String
    var stopVisible = false
    var stopping = false
    var focus: FocusState<Bool>.Binding
    let onSend: () -> Void
    var onStop: () -> Void = {}

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.system(size: 16))
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
                    .accessibilityLabel("停止")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Button(action: onSend) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Palette.primary, in: Circle())
                            .opacity(canSend ? 1 : 0.35)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("发送")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .buttonStyle(PressScaleStyle(scale: 0.9))
            .padding(.bottom, 7)
        }
        .padding(.leading, 18)
        .padding(.trailing, 7)
        .frame(minHeight: 50)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 25, style: .continuous))
        .softElevation(radius: 25)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: canSend)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: stopVisible)
    }
}
