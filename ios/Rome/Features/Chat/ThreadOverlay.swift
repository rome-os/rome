import SwiftUI

/// A chat thread over its chat: the chat stays behind it, blurred and
/// dimmed, so the thread reads as part of the conversation. Its messages sit
/// above its own composer, which sends into the thread and closes it. A tap
/// beside the messages, or the close button, closes it too.
struct ThreadOverlay: View {
    let thread: ThreadStore
    let chat: TranscriptStore
    let tasks: TasksStore
    let onOpenChat: (String, String) -> Void
    let onClose: () -> Void

    @State private var draft = ""
    /// The thread's composer takes no photos; the draft keeps none.
    @State private var attachments = ComposerAttachments()
    @State private var focused = false
    @State private var shown = false
    @State private var visibleHeight: CGFloat = 0

    var body: some View {
        let rows = thread.rows(answers: chat.answers)
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)
                .overlay(Palette.scrim.opacity(0.35))
                .ignoresSafeArea()
                .opacity(shown ? 1 : 0)
                .onTapGesture { close() }
            VStack(spacing: 0) {
                // In place from the first frame: it stands for the header below.
                header
                VStack(spacing: 0) {
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
                Composer(text: $draft, placeholder: String(localized: "Reply"), focused: $focused) {
                    if chat.send(draft, fromComposer: true, thread: thread.target) {
                        draft = ""
                        close()
                    }
                }
                .padding(.horizontal, Metrics.pagePadding)
                .padding(.top, 6)
                .padding(.bottom, 8)
                }
                .opacity(shown ? 1 : 0)
                .offset(y: shown ? 0 : 36)
            }
        }
        .modifier(ThreadDraft(chat: chat, thread: thread, text: $draft, attachments: attachments))
        .onAppear {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { shown = true }
            // The keyboard comes up as the thread lands, ready for the reply.
            Task {
                try? await Task.sleep(for: .milliseconds(150))
                focused = true
            }
        }
        .accessibilityAddTraits(.isModal)
    }

    /// The chat's own header, laid over it unchanged: the mascot pill in the
    /// middle, still, and the close button where the "…" sits.
    private var header: some View {
        HStack {
            // Where the drawer button sits below, so the pill keeps its place.
            Color.clear.frame(width: 44, height: 44)
            MascotPill(still: true)
                .accessibilityLabel(Text("Reply"))
                .frame(maxWidth: .infinity)
            GlassCircleButton(accessibilityLabel: "Close", action: close) {
                Image(systemName: "xmark").romeFont(15, .semibold)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .frame(height: 52)
    }

    private func close() {
        focused = false
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

/// The thread's composer keeps its own draft, under the thread's key, so a
/// send that did not get through comes back here.
private struct ThreadDraft: ViewModifier {
    let chat: TranscriptStore
    let thread: ThreadStore
    @Binding var text: String
    let attachments: ComposerAttachments

    func body(content: Content) -> some View {
        if let drafts = chat.drafts {
            content.composerDraft(drafts.store, chat: DraftStore.threadChat(drafts.chat, messageId: thread.anchor.id), text: $text, attachments: attachments, transcript: chat)
        } else {
            content
        }
    }
}
