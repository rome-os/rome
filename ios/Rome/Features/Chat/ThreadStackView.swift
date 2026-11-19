import SwiftUI

/// The sizes of a thread's stack under its root bubble
/// (docs/domains/chats.md#chat-thread), as the dashboard draws it.
enum ThreadStackMetrics {
    /// How far the stack's top hides behind its root bubble.
    static let tuck: CGFloat = 16
    /// The stack's height: the part behind the bubble, and the line under it.
    static let height: CGFloat = 52
    /// What shows under the bubble.
    static var shown: CGFloat { height - tuck }
    /// How far the thin second layer of a thread with two or more replies
    /// shows under the stack. Every stack keeps the room, so a second reply
    /// never moves the rows below it.
    static let layerLift: CGFloat = 5
    /// The room a stack takes under its bubble.
    static var reserve: CGFloat { shown + layerLift }
    /// Each side's inset of the stack from the bubble's edge.
    static let inset: CGFloat = 16
    /// A root bubble that has a stack is at least this wide, 14rem, so the
    /// avatar, a few words and the count fit.
    static let minRootWidth: CGFloat = 224
    /// The stack's corner.
    static let corner: CGFloat = 16
}

extension EnvironmentValues {
    /// Set on a row whose stack a pill just brought into view: the stack takes a tint for a moment.
    @Entry var rowStackTinted = false
    /// Set by the rows of a Concierge chat: its thread links read their names and open threads through it.
    @Entry var threadLinks: ThreadLinkContext? = nil
}

extension View {
    /// Hangs the thread's stack under this bubble or card, behind it. The room
    /// under it is the stack's, and the stack is as wide as this view less an
    /// inset each side, so it is never wider than the bubble it hangs from.
    func threadStack(_ stack: ThreadStack?, onOpen: @escaping () -> Void) -> some View {
        padding(.bottom, stack == nil ? 0 : ThreadStackMetrics.reserve)
            .background(alignment: .bottom) {
                if let stack {
                    ThreadStackBar(stack: stack, onOpen: onOpen)
                        .padding(.horizontal, ThreadStackMetrics.inset)
                        .padding(.bottom, ThreadStackMetrics.layerLift)
                }
            }
    }

    /// The least width of a root bubble's content with a stack under it.
    func stackMinWidth(_ stack: ThreadStack?, padding: CGFloat = 28) -> some View {
        frame(minWidth: stack == nil ? nil : ThreadStackMetrics.minRootWidth - padding, alignment: .leading)
    }
}

/// The newest message of a thread on one line, the agent's small avatar before
/// it and, on the right, the unread replies in orange or, when none is unread,
/// how many there are in muted text. It shows no status. A tap opens the thread.
struct ThreadStackBar: View {
    let stack: ThreadStack
    let onOpen: () -> Void
    @Environment(\.rowStackTinted) private var landed

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: ThreadStackMetrics.corner, style: .continuous)
        Button(action: onOpen) {
            HStack(spacing: 8) {
                StackAvatar()
                Text(verbatim: stack.preview)
                    .romeFont(13)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if stack.hasUnread {
                    Text(verbatim: "\(stack.count)")
                        .romeFont(11, .semibold, monospacedDigits: true)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Palette.primary, in: Capsule())
                } else {
                    Text(ThreadStackCopy.replies(stack.total))
                        .romeFont(12, monospacedDigits: true)
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .foregroundStyle(stack.hasUnread ? Palette.fg : Palette.sub)
            .padding(.horizontal, 12)
            .frame(minHeight: ThreadStackMetrics.shown)
            // The part behind the bubble is above the line's own room.
            .frame(height: ThreadStackMetrics.height, alignment: .bottom)
            .background {
                ZStack {
                    // A thin second layer says there is more than one reply.
                    if stack.layered {
                        shape.fill(Palette.fillStrong)
                            .overlay(shape.strokeBorder(Palette.hair, lineWidth: 0.5))
                            .padding(.horizontal, 8)
                            .offset(y: ThreadStackMetrics.layerLift)
                    }
                    shape.fill(Palette.fill)
                        .overlay(shape.fill(Palette.primarySoft).opacity(landed ? 1 : 0))
                        .overlay(shape.strokeBorder(Palette.hair, lineWidth: 0.5))
                }
                .animation(.easeOut(duration: 0.3), value: landed)
            }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Open the thread, newest: \(stack.preview)"))
        .accessibilityValue(stack.hasUnread ? ThreadStackCopy.newReplies(stack.unread) : ThreadStackCopy.replies(stack.total))
        .accessibilityIdentifier("thread-stack")
    }
}

/// The agent's small avatar: the mascot on a round tile.
struct StackAvatar: View {
    var size: CGFloat = 18

    var body: some View {
        Mascot()
            .frame(height: size * 0.57)
            .frame(width: size, height: size)
            .background(Palette.elevated, in: Circle())
            .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

/// The words of a stack and its pills.
enum ThreadStackCopy {
    /// "1 reply", "3 replies"; "3 条" in Chinese.
    static func replies(_ count: Int) -> LocalizedStringKey { "\(count) replies" }

    static func newReplies(_ count: Int) -> LocalizedStringKey { "\(count) new replies" }

    /// What a pill says: "New replies in "Plan Kyoto"", with the name cut short.
    static func pill(_ name: String?) -> String {
        let shown = ThreadStacks.pillName(name.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Thread"))
        return String(localized: "New replies in \"\(shown)\"")
    }
}

/// The row of pills above the composer, one for each thread with replies the
/// guardian has not seen (docs/domains/chats.md#chat-thread), in one row that
/// scrolls sideways. It reads the store itself, so a change in the pills
/// never draws the screen around it again. A pill brings the transcript to the
/// thread's stack and tints it for a moment; it does not open the thread.
struct ThreadPills: View {
    let store: TranscriptStore

    var body: some View {
        let roots = store.pills
        Group {
            if !roots.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(roots, id: \.self) { root in
                            Button { store.showStack(root) } label: {
                                HStack(spacing: 6) {
                                    Circle().fill(Palette.primary).frame(width: 6, height: 6)
                                    StackAvatar(size: 16)
                                    Text(verbatim: ThreadStackCopy.pill(store.threadName(root)))
                                        .romeFont(13)
                                        .foregroundStyle(Palette.fg)
                                        .lineLimit(1)
                                        .fixedSize()
                                }
                                .padding(.leading, 10)
                                .padding(.trailing, 14)
                                .frame(minHeight: 34)
                                .glassSurface(Capsule(), interactive: true, frost: Frost.composer)
                            }
                            .buttonStyle(PressScaleStyle())
                            .accessibilityIdentifier("thread-pill")
                        }
                    }
                    .padding(.horizontal, 2)
                    .padding(.vertical, 2)
                }
                .scrollClipDisabled()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: roots)
    }
}
