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
            ChatHeader(needsYou: workspace.tasks.needsYouCount, onMenu: onMenu, onTasks: onTasks)
            banners
            content
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if workspace.conciergeState == .ready {
                Composer(text: $draft, placeholder: "发消息", focus: $composerFocused) {
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
                TopBanner(kind: .warning, text: "没有网络连接。")
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
                title: "Concierge 未开启",
                detail: "开启后就能在这里对话。",
                actionTitle: "开启 Concierge"
            ) { Task { await workspace.enableConcierge() } }
        case .failed:
            CenteredMessage(
                title: "连接不上你的 Rome",
                detail: "检查网络后再试一次。",
                actionTitle: "重试"
            ) { Task { await workspace.openConcierge() } }
        case .ready:
            if store.loaded && store.rows.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Spacer()
                    Text("有什么要做的？")
                        .romeFont(30, .bold)
                        .tracking(-0.8)
                    Text("复杂的事我会开成任务去做，做完告诉你。")
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
            GlassCircleButton(accessibilityLabel: "打开导航", action: onMenu) {
                MenuGlyph()
            }
            Spacer()
            Text("Chat")
                .romeFont(17, .semibold)
                .tracking(-0.4)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            GlassCircleButton(accessibilityLabel: needsYou > 0 ? "任务，\(needsYou) 个等你处理" : "任务", action: onTasks) {
                ChecklistGlyph()
            }
            .overlay(alignment: .topTrailing) {
                if needsYou > 0 {
                    Text("\(needsYou)")
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
    let title: String
    let detail: String
    let actionTitle: String
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

/// A transcript that sticks to its bottom, loads older pages at the top, and
/// offers a "新消息" pill when something arrives while the guardian reads up.
struct TranscriptList<Row: View>: View {
    let store: TranscriptStore
    var composerFocused = false
    /// Short transcripts sit at the top instead of the bottom (task chats).
    var alignTop = false
    /// Drawn after the last row, inside the scroll: the "运行中…" line.
    var footer: AnyView? = nil
    /// A message to scroll to and briefly highlight.
    var focusMessageID: Binding<String?> = .constant(nil)
    @ViewBuilder let row: (TranscriptRow, TranscriptRow?) -> Row

    @State private var atBottom = true
    @State private var unseen = 0
    @State private var highlighted: String?

    var body: some View {
        let rows = store.rows
        GeometryReader { geometry in
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
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .offset(y: 8)),
                                removal: .opacity
                            ))
                    }
                    if let footer {
                        footer.transition(.opacity)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                        .onAppear { atBottom = true; unseen = 0 }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, Metrics.pagePadding)
                .padding(.bottom, 14)
                .frame(minHeight: alignTop ? geometry.size.height : nil, alignment: .top)
                .animation(.spring(response: 0.38, dampingFraction: 0.88), value: rows.map(\.id))
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: rows.last?.id) {
                if atBottom {
                    withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .onChange(of: store.pending.count) { old, new in
                if new > old {
                    withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .onChange(of: store.arrivals) {
                if !atBottom { unseen += 1 }
            }
            .onChange(of: focusMessageID.wrappedValue, initial: true) { _, target in
                guard let target, let first = rows.first(where: { $0.id.hasPrefix(target + ":") }) else { return }
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
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if unseen > 0 && !atBottom {
                    Button {
                        withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        unseen = 0
                    } label: {
                        HStack(spacing: 6) {
                            Text("新消息")
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
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: unseen > 0 && !atBottom)
        }
        }
    }
}
