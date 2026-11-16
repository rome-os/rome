import SwiftUI

/// A task's chat thread over its chat: the chat stays behind it, blurred
/// and dimmed, so the thread reads as part of the conversation. It covers
/// the header and the transcript only: the chat's own composer stays below
/// it and sends into the thread while it is open. A tap beside the
/// messages, or the close button, closes it.
struct ThreadOverlay: View {
    let thread: ThreadStore
    let chat: TranscriptStore
    let tasks: TaskChatsStore
    /// The chat's name and status, as its header shows them.
    let name: String
    /// Read by the header copy, so a status change redraws it alone.
    var activity: () -> ConciergeActivity? = { nil }
    let onClose: () -> Void

    @State private var shown = false
    @State private var visibleHeight: CGFloat = 0

    var body: some View {
        let rows = thread.rows
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)
                .overlay(Palette.scrim.opacity(0.35))
                // Up under the status bar, and down behind the composer, which
                // stays on top of it.
                .ignoresSafeArea(.container, edges: [.top, .bottom])
                .opacity(shown ? 1 : 0)
                .onTapGesture { close() }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        ConciergeRow(row: row, info: thread.info(for: row), store: chat, tasks: tasks, inThread: true, tinted: chat.tinted != nil && row.ownMessageId == chat.tinted)
                            .equatable()
                            .padding(.top, TranscriptSpacing.top(row, after: index > 0 ? rows[index - 1] : nil))
                    }
                }
                .padding(.horizontal, Metrics.pagePadding)
                .readableColumn()
                .padding(.vertical, 12)
                // At least as tall as the scroll, with the messages at its
                // foot: the space around them is the blurred chat, and a
                // tap there closes. A message keeps its own taps.
                .frame(maxWidth: .infinity, minHeight: visibleHeight, alignment: .bottom)
                .contentShape(Rectangle())
                .onTapGesture { close() }
            }
            // The height between the header and the composer.
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { visibleHeight = $0 }
            .modifier(StayAtBottom())
            .scrollDismissesKeyboard(.interactively)
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 36)
            // Rows end in a short fade just above the composer, never behind
            // its glass. Upward the mask reaches past the header, where the
            // rows fade under it instead.
            .mask {
                VStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: 14)
                }
                .ignoresSafeArea(.container, edges: .top)
            }
            .softTopScrollEdge()
            // Above the rows, as the chat's own header is: they scroll under it.
            // In place from the first frame: it stands for the header below.
            .floatingTopBar { header }
        }
        .onAppear {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { shown = true }
        }
    }

    /// The chat's own header, laid over it unchanged: the same identity in
    /// the middle, still, and the close button where the "…" sits.
    private var header: some View {
        HStack(alignment: .center) {
            // Where the drawer button sits below, so the identity keeps its place.
            Color.clear.frame(width: 44, height: 44)
            ChatIdentity.Slot { ChatIdentity(name: name, activity: activity(), still: true) }
            GlassCircleButton(accessibilityLabel: "Close", action: close) {
                Image(systemName: "xmark").romeFont(15, .semibold)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 4)
    }

    /// The composer keeps its text and focus: closed unsent, the text stays
    /// for the chat.
    private func close() {
        withAnimation(.easeOut(duration: 0.2)) { shown = false }
        Task {
            try? await Task.sleep(for: .milliseconds(200))
            onClose()
        }
    }
}

/// Where the thread holds still: it opens on its last message, and the
/// last message stays just above the composer as the keyboard comes up or
/// the read brings older messages in above it.
private struct StayAtBottom: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .defaultScrollAnchor(.bottom)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

/// Above the composer while it replies to a message: a line of that
/// message, and a cross that drops the reply, and an open thread view with it.
/// A reply inside a thread view names the task instead, quoting nothing.
struct QuoteBar: View {
    /// The quoted message; nil while it is not held.
    let message: ChatMessage?
    /// Reply inside a thread view: the task's title.
    var threadTitle: String? = nil
    let onCancel: () -> Void

    private var preview: String {
        let text = message?.parts.compactMap { part -> String? in
            if case .text(let text, _, _) = part { return text }
            return nil
        }.joined(separator: " ") ?? ""
        return MarkdownParser.plain(text).split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrowshape.turn.up.left")
                .romeFont(12)
                .foregroundStyle(Palette.sub)
            Text(verbatim: threadTitle.map { String(localized: "Reply to \($0)") } ?? (preview.isEmpty ? String(localized: "Reply") : preview))
                .romeFont(13)
                .foregroundStyle(Palette.sub)
                .lineLimit(1)
            Spacer(minLength: 4)
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .romeFont(11, .semibold)
                    .foregroundStyle(Palette.sub)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(Text("Cancel reply"))
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(minHeight: 34)
        .glassSurface(Capsule(), frost: Frost.composer)
        .accessibilityElement(children: .contain)
    }
}

/// The quote a reply carries when it does not sit right under what it
/// answers (docs/domains/chats.md#chat-thread): a small reply arrow and the
/// first line of the original, muted, at the top of its bubble. A tap opens the
/// reply's thread view or goes to the original; without one it is plain.
struct QuotedReply: View {
    /// The bubble the quote sits in: the guardian's, which is the primary color, or the Concierge's.
    enum Tone { case sent, received }

    let quote: MessagePart.ReplyQuote
    var tone: Tone = .sent
    let onTap: (() -> Void)?

    private var ink: Color { tone == .sent ? .white : Palette.sub }

    /// An automation's message names it first.
    private var line: String {
        quote.author == "automated" ? "\(quote.name ?? String(localized: "Automation")) · \(quote.line)" : quote.line
    }

    var body: some View {
        let content = HStack(spacing: 4) {
            Image(systemName: "arrowshape.turn.up.left").romeFont(11).opacity(0.8)
            Text(verbatim: line).romeFont(12).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .foregroundStyle(ink.opacity(0.8))
        .frame(maxWidth: 288, alignment: .leading)
        if let onTap {
            Button(action: onTap) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityHint(Text("Shows the message it replies to"))
                .accessibilityIdentifier("reply-quote")
        } else {
            content
        }
    }
}

/// The mark of a reply that sits right under what it answers, in place of a
/// quote: a hook up to the message above, or a line across the gap to the reply
/// above that answers the same message. It grows out of the bubble's outer top
/// corner in the bubble's color, and both stems stand 20 pt in from the outer
/// edge, on the straight part of the edge, so a run of replies reads as one
/// rail. A tap leads where the quote would.
struct ReplyRail: View {
    enum Kind: Hashable, Sendable {
        case hook
        case line(gap: CGFloat)
    }

    let kind: Kind
    /// The reply is the guardian's: its bubble is on the trailing side and ember.
    let isUser: Bool
    /// The quoted text, which the mark's name carries.
    let label: String
    let onTap: (() -> Void)?

    private static let stem: CGFloat = 20
    private static let hookHeight: CGFloat = 14

    private var height: CGFloat {
        switch kind {
        case .hook: return Self.hookHeight
        case .line(let gap): return gap
        }
    }

    var body: some View {
        let mark = RailShape(kind: kind, stem: Self.stem, trailing: isUser)
            .stroke(isUser ? Palette.primary : Palette.replyRail, lineWidth: 1.5)
            .frame(width: 2 * Self.stem + 4, height: height)
        Group {
            if let onTap {
                Button(action: onTap) { mark.contentShape(Rectangle()) }.buttonStyle(.plain)
            } else {
                mark
            }
        }
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityIdentifier("reply-quote")
        // Above the bubble it grows from, taking no room.
        .offset(y: -height)
    }
}

extension View {
    /// What a reply that is a task card carries, as a text reply does: the quote
    /// above the card, or, where it sits right under what it answers, the mark
    /// growing out of the card's top corner.
    @ViewBuilder
    func replyMark(quote: MessagePart.ReplyQuote?, rail: ReplyRail.Kind?, onTap: (() -> Void)?) -> some View {
        if let quote {
            VStack(alignment: .leading, spacing: 6) {
                if rail == nil { QuotedReply(quote: quote, tone: .received, onTap: onTap) }
                self
            }
            .overlay(alignment: .topLeading) {
                if let rail { ReplyRail(kind: rail, isUser: false, label: quote.text, onTap: onTap) }
            }
        } else {
            self
        }
    }
}

private struct RailShape: Shape {
    let kind: ReplyRail.Kind
    let stem: CGFloat
    let trailing: Bool

    func path(in rect: CGRect) -> Path {
        // The stem, measured from the bubble's outer edge, and the way the hook turns.
        let x = trailing ? rect.maxX - stem : stem
        let turn: CGFloat = trailing ? -1 : 1
        var path = Path()
        switch kind {
        case .line:
            path.move(to: CGPoint(x: x, y: rect.minY))
            path.addLine(to: CGPoint(x: x, y: rect.maxY))
        case .hook:
            let radius: CGFloat = 8
            path.move(to: CGPoint(x: x, y: rect.maxY))
            path.addLine(to: CGPoint(x: x, y: rect.minY + radius))
            path.addQuadCurve(to: CGPoint(x: x + turn * radius, y: rect.minY), control: CGPoint(x: x, y: rect.minY))
            path.addLine(to: CGPoint(x: x + turn * 14, y: rect.minY))
        }
        return path
    }
}

extension TranscriptRow {
    /// The stored message a row draws, a card's included: part rows are
    /// `<message id>:<part index>`. A label is under its message, not of it,
    /// so a tint leaves it out.
    var ownMessageId: String? {
        switch self {
        case .separator, .typing, .tools, .sourceLabel, .unreadDivider: return nil
        default: return messageId ?? Self.message(ofPart: id)
        }
    }
}

extension EnvironmentValues {
    /// Set on a row whose message is tinted. The bubble or card reads it, so
    /// the tint hugs its shape and never fills the row's width.
    @Entry var rowTinted = false
}

extension View {
    /// The tint of a message a thread view or a quote led to.
    func tinted(_ on: Bool) -> some View {
        background {
            if on {
                RoundedRectangle(cornerRadius: Metrics.bubbleRadius + 4, style: .continuous)
                    .fill(Palette.primarySoft)
                    .padding(.horizontal, -6)
                    .padding(.vertical, -3)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.3), value: on)
    }
}
