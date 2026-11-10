import SwiftUI

/// A chat thread over its chat: the chat stays behind it, blurred and
/// dimmed, so the thread reads as part of the conversation. It covers the
/// header and the transcript only: the chat's own composer stays below it
/// and sends into the thread while it is open. A tap beside the messages,
/// or the close button, closes it.
struct ThreadOverlay: View {
    let thread: ThreadStore
    let chat: TranscriptStore
    let tasks: TasksStore
    /// The chat's name and status, as its header shows them.
    let name: String
    var activity: ConciergeActivity? = nil
    let onOpenChat: (String, String) -> Void
    let onClose: () -> Void

    @State private var shown = false
    @State private var visibleHeight: CGFloat = 0

    var body: some View {
        let rows = thread.rows(answers: chat.answers)
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
                        ConciergeRow(row: row, store: chat, tasks: tasks, onOpenChat: onOpenChat, inThread: true)
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
            ChatIdentity.Slot { ChatIdentity(name: name, activity: activity, still: true) }
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

/// Above the composer while it replies to a message in no chat thread: a
/// line of that message, and a cross that drops the reply.
struct QuoteBar: View {
    /// The quoted message; nil while it is not held.
    let message: ChatMessage?
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
            Text(verbatim: preview.isEmpty ? String(localized: "Reply") : preview)
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

/// Under the root of a chat thread: how many replies it has. A tap opens
/// the thread.
struct ThreadRepliesLine: View {
    let count: Int
    let guardian: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            Text("\(count) replies")
                .romeFont(13, .medium)
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 6)
                .frame(minHeight: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: guardian ? .trailing : .leading)
        .padding(.leading, guardian ? 0 : 8)
    }
}
