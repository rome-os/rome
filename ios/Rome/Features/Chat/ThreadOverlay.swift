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
    /// The chat's name, as its header shows it.
    let name: String
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
            VStack(spacing: 0) {
                // In place from the first frame: it stands for the header below.
                header
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            ConciergeRow(row: row, store: chat, tasks: tasks, onOpenChat: onOpenChat, inThread: true)
                                .padding(.top, TranscriptSpacing.top(row, after: index > 0 ? rows[index - 1] : nil))
                        }
                    }
                    .padding(.horizontal, Metrics.pagePadding)
                    .padding(.vertical, 12)
                    // At least as tall as the scroll, with the messages at its
                    // foot: the space around them is the blurred chat, and a
                    // tap there closes. A message keeps its own taps.
                    .frame(maxWidth: .infinity, minHeight: visibleHeight, alignment: .bottom)
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { visibleHeight = $0 }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .opacity(shown ? 1 : 0)
                .offset(y: shown ? 0 : 36)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { shown = true }
        }
    }

    /// The chat's own header, laid over it unchanged: the same identity in
    /// the middle, still, and the close button where the "…" sits.
    private var header: some View {
        HStack(alignment: .top) {
            // Where the drawer button sits below, so the identity keeps its place.
            Color.clear.frame(width: 44, height: 44)
            ChatIdentity(name: name, still: true)
                .frame(maxWidth: .infinity)
            GlassCircleButton(accessibilityLabel: "Close", action: close) {
                Image(systemName: "xmark").romeFont(15, .semibold)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 6)
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

/// Under the first message of a chat thread: how many replies it has. A
/// tap opens the thread.
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
