import SwiftUI

/// Board 4: the Concierge chat, the app's home screen.
struct ChatScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    let onTasks: () -> Void
    let onOpenChat: (String, String) -> Void

    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    private var store: TranscriptStore { workspace.concierge }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The bar is clear: the transcript scrolls under its glass items.
        .floatingTopBar {
            VStack(spacing: 0) {
                ChatHeader(needsYou: workspace.tasks.needsYouCount, onMenu: onMenu, onTasks: onTasks)
                banners
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if workspace.conciergeState == .ready {
                Composer(text: $draft, placeholder: "Message", focus: $composerFocused) {
                    if store.send(draft) { draft = "" }
                }
                .padding(.horizontal, Metrics.pagePadding)
                .padding(.top, 6)
                .padding(.bottom, 8)
                .background(alignment: .bottom) {
                    LinearGradient(colors: [Palette.bg.opacity(0), Palette.bg, Palette.bg], startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea()
                }
            }
        }
    }

    @ViewBuilder
    private var banners: some View {
        VStack(spacing: 8) {
            if let hint = model.autoOpenHint {
                TopBanner(kind: .info, text: hint)
                    .onTapGesture { model.autoOpenHint = nil }
                    .task {
                        try? await Task.sleep(for: .seconds(5))
                        withAnimation { model.autoOpenHint = nil }
                    }
            }
            if store.loadError == .offline {
                TopBanner(kind: .warning, text: String(localized: "No network connection"))
            }
        }
        .padding(.top, model.autoOpenHint != nil || store.loadError == .offline ? 10 : 0)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.autoOpenHint)
    }

    @ViewBuilder
    private var content: some View {
        switch workspace.conciergeState {
        case .loading:
            Spacer()
            Spinner(size: 22, color: Palette.sub)
            Spacer()
        case .off:
            CenteredMessage(
                title: "Concierge is off",
                detail: "Turn it on to chat here.",
                actionTitle: "Turn on Concierge"
            ) { Task { await workspace.enableConcierge() } }
        case .failed:
            CenteredMessage(
                title: "Could not reach your Rome",
                detail: "Check the network and try again",
                actionTitle: "Try again"
            ) { Task { await workspace.openConcierge() } }
        case .ready:
            if store.loaded && store.rows.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Spacer()
                    Text("What needs doing?")
                        .romeFont(30, .bold)
                        .tracking(-0.8)
                    Text("I turn bigger jobs into tasks and tell you when they're done.")
                        .romeFont(16)
                        .lineSpacing(5)
                        .foregroundStyle(Palette.sub)
                    Spacer()
                    Spacer()
                }
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { composerFocused = false }
            } else {
                TranscriptList(store: store, composerFocused: composerFocused, focusMessageID: Binding(
                    get: { workspace.focusMessageID },
                    set: { workspace.focusMessageID = $0 }
                )) { row, previous in
                    rowView(row)
                        .padding(.top, TranscriptSpacing.top(row, after: previous))
                }
                .onTapGesture { composerFocused = false }
                .onAppear { store.markRead() }
                .onChange(of: store.arrivals) { store.markRead() }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: TranscriptRow) -> some View {
        switch row {
        case .separator(_, let date):
            TimeSeparator(date: date)
        case .userText(let id, let text, let pending):
            UserBubble(text: text, pending: pending) { store.retry(id) }
        case .agentText(_, let text, let long, let forwardedFrom, let position):
            AgentBubble(text: text, long: long, forwardedFrom: forwardedFrom, position: position, onOpenChat: onOpenChat)
        case .taskCard(_, let chatId, let title):
            let name = workspace.tasks.title(forChat: chatId, fallback: title)
            TaskCard(title: name, tone: workspace.tasks.tone(forChat: chatId)) {
                onOpenChat(chatId, name)
            }
        case .typing:
            TypingDots().frame(maxWidth: .infinity, alignment: .leading)
        case .approval, .question, .webOnly, .tools:
            WebOnlyCard()
        case .error(_, let text):
            ErrorLine(text: text)
        }
    }
}

/// The floating header: menu, title, tasks with its needs-you badge.
struct ChatHeader: View {
    let needsYou: Int
    let onMenu: () -> Void
    let onTasks: () -> Void

    var body: some View {
        HStack {
            GlassCircleButton(accessibilityLabel: "Open navigation", action: onMenu) {
                MenuGlyph()
            }
            Spacer()
            Text("Chat")
                .romeFont(17, .semibold)
                .tracking(-0.4)
                .padding(.horizontal, 18)
                .frame(height: 44)
                .glassSurface(Capsule())
                .accessibilityAddTraits(.isHeader)
            Spacer()
            GlassCircleButton(accessibilityLabel: needsYou > 0 ? "Tasks, \(needsYou) need you" : "Tasks", action: onTasks) {
                ChecklistGlyph()
            }
            .overlay(alignment: .topTrailing) {
                if needsYou > 0 {
                    Text(verbatim: "\(needsYou)")
                        .romeFont(12, .bold, monospacedDigits: true)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 19, minHeight: 19)
                        .background(Palette.destructive, in: Capsule())
                        .overlay(Capsule().strokeBorder(Palette.bg, lineWidth: 2).padding(-2))
                        .offset(x: 3, y: -3)
                        .transition(.scale.combined(with: .opacity))
                        .allowsHitTesting(false)
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: needsYou)
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .frame(height: 52)
    }
}

/// Three lines, the last one shorter.
struct MenuGlyph: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            let scale = size.width / 20
            for (y, length) in [(6.0, 13.0), (10.0, 13.0), (14.0, 9.0)] {
                path.move(to: CGPoint(x: 3.5 * scale, y: y * scale))
                path.addLine(to: CGPoint(x: (3.5 + length) * scale, y: y * scale))
            }
            context.stroke(path, with: .color(Palette.fg), style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
        }
        .frame(width: 20, height: 20)
    }
}

/// Three ticked rows.
struct ChecklistGlyph: View {
    var color: Color = Palette.fg

    var body: some View {
        Canvas { context, size in
            let s = size.width / 20
            var path = Path()
            for y in [5.2, 10.2, 15.2] {
                path.move(to: CGPoint(x: 3 * s, y: y * s))
                path.addLine(to: CGPoint(x: 4.4 * s, y: (y + 1.4) * s))
                path.addLine(to: CGPoint(x: 7 * s, y: (y - 1.2) * s))
                path.move(to: CGPoint(x: 9.8 * s, y: (y + 0.3) * s))
                path.addLine(to: CGPoint(x: 16.8 * s, y: (y + 0.3) * s))
            }
            context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 20, height: 20)
    }
}

/// A title, a line, and one button, centered: empty and error states.
struct CenteredMessage: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let actionTitle: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            VStack(spacing: 8) {
                Text(title).romeFont(20, .semibold)
                Text(detail).romeFont(15).foregroundStyle(Palette.sub)
            }
            .multilineTextAlignment(.center)
            PrimaryButton(title: actionTitle, action: action)
                .frame(maxWidth: 240)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
    }
}

/// A transcript that follows its bottom while the guardian is there, loads
/// older pages at the top, and offers a "New messages" pill when something
/// arrives while they read further up.
struct TranscriptList<Row: View>: View {
    let store: TranscriptStore
    var composerFocused = false
    /// Short transcripts sit at the top instead of the bottom (task chats).
    var alignTop = false
    /// Drawn after the last row, inside the scroll: the "Running…" line.
    var footer: AnyView? = nil
    /// A message to scroll to and briefly highlight.
    var focusMessageID: Binding<String?> = .constant(nil)
    @ViewBuilder let row: (TranscriptRow, TranscriptRow?) -> Row

    /// The list keeps the bottom in view. It turns off when the guardian scrolls
    /// away from the bottom and back on when they come back, never because
    /// content arrived.
    @State private var following = true
    @State private var bottomVisible = true
    /// No finger or fling is moving the scroll.
    @State private var atRest = true
    @State private var unseen = 0
    @State private var highlighted: String?
    @State private var visibleHeight: CGFloat = 0

    var body: some View {
        let rows = store.rows
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if store.hasOlder {
                        Spinner(size: 16, color: Palette.sub)
                            .padding(.vertical, 12)
                            .onAppear { Task { await store.loadOlder() } }
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                        row(item, index > 0 ? rows[index - 1] : nil)
                            .background {
                                if let highlighted, item.id.hasPrefix(highlighted + ":") {
                                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                                        .fill(Palette.primarySoft)
                                        .padding(-6)
                                        .transition(.opacity)
                                }
                            }
                            .id(item.id)
                    }
                    if let footer {
                        footer
                    }
                    BottomMarker(visible: $bottomVisible, following: $following)
                        .id("bottom")
                }
                .padding(.horizontal, Metrics.pagePadding)
                .frame(minHeight: alignTop ? visibleHeight : nil, alignment: .top)
            }
            .modifier(FollowBottom(following: $following, bottomVisible: bottomVisible, holdOlder: store.placingOlder, atRest: $atRest))
            .onChange(of: store.olderPage != nil && atRest) { _, ready in
                if ready { Task { await store.placeOlderPage() } }
            }
            .scrollDismissesKeyboard(.interactively)
            .softTopScrollEdge()
            // The height between the bars; the scroll view itself runs under them.
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { visibleHeight = $0 }
            .onChange(of: following) { _, now in
                if now { unseen = 0 }
            }
            .onChange(of: store.pending.count) { old, new in
                if new > old { scrollToBottom(proxy) }
            }
            .onChange(of: store.arrivals) {
                if !following { unseen += 1 }
            }
            .onChange(of: focusMessageID.wrappedValue, initial: true) { _, target in
                guard let target, let first = rows.first(where: { $0.id.hasPrefix(target + ":") }) else { return }
                following = false
                withAnimation(.spring(response: 0.45, dampingFraction: 0.9)) { proxy.scrollTo(first.id, anchor: .center) }
                withAnimation(.easeOut(duration: 0.2)) { highlighted = target }
                focusMessageID.wrappedValue = nil
                Task {
                    try? await Task.sleep(for: .seconds(1.6))
                    withAnimation(.easeOut(duration: 0.6)) { highlighted = nil }
                }
            }
            .onChange(of: composerFocused) { _, focused in
                if focused {
                    Task {
                        try? await Task.sleep(for: .milliseconds(300))
                        scrollToBottom(proxy)
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if unseen > 0 && !following {
                    Button {
                        scrollToBottom(proxy)
                    } label: {
                        HStack(spacing: 6) {
                            Text("New messages")
                            Image(systemName: "arrow.down").romeFont(12, .bold)
                        }
                        .romeFont(14, .semibold)
                        .foregroundStyle(Palette.fg)
                        .padding(.horizontal, 14)
                        .frame(height: 36)
                        .background(Palette.elevated, in: Capsule())
                        .softElevation(radius: 18)
                    }
                    .buttonStyle(PressScaleStyle())
                    .padding(.bottom, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: unseen > 0 && !following)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        following = true
        unseen = 0
        withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { proxy.scrollTo("bottom", anchor: .bottom) }
    }
}

/// Where the transcript holds still as its content changes. On iOS 18 and
/// later: it opens at the bottom; while it follows the bottom, new content
/// pushes up from there; while the guardian reads further up, the rows they
/// see stay put, also when an older page lands above them.
private struct FollowBottom: ViewModifier {
    @Binding var following: Bool
    /// The bottom marker is on screen.
    let bottomVisible: Bool
    /// An older page is going in at the top; it must land above the rows in view.
    let holdOlder: Bool
    @Binding var atRest: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                // The role nearest the scroll view wins over the general anchor.
                .defaultScrollAnchor(following || holdOlder ? .bottom : .top, for: .sizeChanges)
                .defaultScrollAnchor(.bottom)
                .onScrollPhaseChange { old, phase in
                    atRest = phase == .idle || phase == .animating
                    switch phase {
                    case .interacting:
                        // A drag owns the scroll: nothing moves it from under the finger.
                        following = false
                    case .idle:
                        // Where a drag or fling comes to rest decides; a tap or a
                        // programmatic scroll only turns following back on.
                        if old == .interacting || old == .decelerating {
                            following = bottomVisible
                        } else if bottomVisible {
                            following = true
                        }
                    default:
                        break
                    }
                }
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

/// The space under the last row. It reports whether the bottom is on screen:
/// from the scroll view on iOS 18 and later, from appearing and disappearing
/// before.
private struct BottomMarker: View {
    @Binding var visible: Bool
    @Binding var following: Bool

    var body: some View {
        if #available(iOS 18, *) {
            Color.clear
                .frame(height: 14)
                .onScrollVisibilityChange(threshold: 0.5) { visible = $0 }
        } else {
            Color.clear
                .frame(height: 14)
                .onAppear { visible = true; following = true }
                .onDisappear { visible = false; following = false }
        }
    }
}
