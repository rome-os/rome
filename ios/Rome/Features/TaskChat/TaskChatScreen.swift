import SwiftUI

/// Board 6: one task chat. Its brief sits on top, tool work folds into a pill,
/// and what needs the guardian (an approval, a question) stands out.
struct TaskChatScreen: View {
    let workspace: Workspace
    let chatId: String
    let initialTitle: String

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var store: TranscriptStore?
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    private var title: String { workspace.tasks.title(forChat: chatId, fallback: initialTitle) }

    private var tone: TaskTone {
        if let store, store.running { return .running }
        return workspace.tasks.tone(forChat: chatId)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let store {
                if store.loaded {
                    transcript(store)
                } else {
                    Spacer()
                    Spinner(size: 22, color: Palette.sub)
                    Spacer()
                }
            } else {
                Spacer()
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let store {
                Composer(
                    text: $draft,
                    placeholder: "回复这个任务",
                    stopVisible: store.running,
                    stopping: store.stopping,
                    focus: $composerFocused,
                    onSend: { if store.send(draft) { draft = "" } },
                    onStop: { store.stopTurn() }
                )
                .padding(.horizontal, Metrics.pagePadding)
                .padding(.top, 6)
                .padding(.bottom, 8)
                .background(alignment: .bottom) {
                    LinearGradient(colors: [Palette.bg.opacity(0), Palette.bg, Palette.bg], startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea()
                }
            }
        }
        .onAppear {
            if store == nil {
                let created = TranscriptStore(sessionId: chatId, kind: .task, backend: workspace.backend)
                store = created
                created.start()
            }
        }
        .onDisappear { store?.markRead() }
        // Keep the swipe-back gesture with a hidden navigation bar.
        .background(SwipeBackEnabler())
    }

    private var header: some View {
        HStack(spacing: 8) {
            GlassCircleButton(accessibilityLabel: "返回", action: { dismiss() }) {
                Image(systemName: "chevron.left").romeFont(17, .semibold)
            }
            VStack(spacing: 1) {
                Text(title)
                    .romeFont(16, .semibold)
                    .tracking(-0.3)
                    .lineLimit(1)
                if tone != .neutral {
                    HStack(spacing: 5) {
                        if tone == .running {
                            Spinner(size: 10, lineWidth: 2.4, color: tone.text, trackOpacity: 0.3)
                        } else {
                            Circle().fill(tone.dot).frame(width: 6, height: 6)
                        }
                        Text(tone == .running ? "运行中" : tone.label)
                    }
                    .romeFont(12, .medium)
                    .foregroundStyle(tone.text)
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity)
            .animation(.easeInOut(duration: 0.25), value: tone)
            Menu {
                Button {
                    if let url = model.webURL?.appending(path: "chat/\(chatId)") { openURL(url) }
                } label: {
                    Label("在 Web 中打开", systemImage: "safari")
                }
                Button {
                    UIPasteboard.general.url = model.webURL?.appending(path: "chat/\(chatId)")
                } label: {
                    Label("复制链接", systemImage: "link")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .romeFont(17, .semibold)
                    .foregroundStyle(Palette.fg)
                    .frame(width: 44, height: 44)
                    .background(.ultraThinMaterial, in: Circle())
                    .background(Palette.glass, in: Circle())
                    .overlay(Circle().strokeBorder(Palette.hair, lineWidth: 0.5))
                    .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
            }
            .accessibilityLabel("更多")
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .frame(height: 52)
    }

    @ViewBuilder
    private func transcript(_ store: TranscriptStore) -> some View {
        let briefID = store.brief?.id
        TranscriptList(
            store: store,
            composerFocused: composerFocused,
            alignTop: true,
            footer: store.running && store.loaded ? AnyView(runningLine(store)) : nil
        ) { row, previous in
            taskRow(row, store: store, briefID: briefID)
                .padding(.top, spacing(row, after: previous))
        }
        .animation(.easeInOut(duration: 0.25), value: store.running)
        .onTapGesture { composerFocused = false }
    }

    private func runningLine(_ store: TranscriptStore) -> some View {
        HStack(spacing: 8) {
            Spinner(size: 15, color: Palette.running)
            Text(store.stopping ? "正在停止…" : "运行中…")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
            Spacer()
        }
        .padding(.horizontal, 2)
        .padding(.top, 14)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func taskRow(_ row: TranscriptRow, store: TranscriptStore, briefID: String?) -> some View {
        switch row {
        case .separator(let id, let date):
            // The brief opens the chat; no time line above it.
            if let briefID, id == "sep-\(briefID)" {
                EmptyView()
            } else {
                TimeSeparator(date: date)
            }
        case .userText(let id, let text, let pending):
            if let briefID, id.hasPrefix(briefID + ":") {
                BriefCard(text: text)
            } else {
                UserBubble(text: text, pending: pending) { store.retry(id) }
            }
        case .agentText(_, let text, let long, let forwardedFrom, let position):
            AgentBubble(text: text, long: long, forwardedFrom: forwardedFrom, position: long ? .single : position)
        case .tools(_, let traceID, let count):
            ToolSummary(count: count, calls: store.toolCalls[traceID]) { store.loadToolCalls(traceID) }
        case .approval(_, let part, _):
            ApprovalCardView(
                part: part,
                status: store.approvals[part.approvalId] == nil ? nil : store.approvalStatus(part),
                submitting: store.resolvingApproval[part.approvalId],
                error: store.approvalErrors[part.approvalId],
                resolvedAt: RomeDate.parse(store.approvals[part.approvalId]?.resolvedAt ?? store.approvals[part.approvalId]?.updatedAt)
            ) { approve in
                store.resolve(part.approvalId, approve: approve)
            }
            .onAppear { store.watchApproval(part.approvalId) }
        case .question(_, let part, _, let answered):
            QuestionCardView(part: part, answered: answered, sending: store.answering.contains(part.toolUseId)) { values in
                store.answer(part, values: values)
            }
        case .webOnly:
            WebOnlyCard()
        case .error(_, let text):
            ErrorLine(text: text)
        case .taskCard(_, let id, let title):
            TaskCard(title: title, tone: workspace.tasks.tone(forChat: id)) {}
        case .typing:
            TypingDots().frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Task chats space every block by 12 pt, as on the board; bubbles in a run keep 3 pt.
    private func spacing(_ row: TranscriptRow, after previous: TranscriptRow?) -> CGFloat {
        guard let previous else { return 12 }
        if case .separator = row { return 20 }
        if case .separator(let id, _) = previous {
            // Directly under a hidden separator: the brief starts the page.
            return id == "sep-\(store?.brief?.id ?? "")" ? 4 : 14
        }
        if case .agentText = row, case .agentText = previous { return 3 }
        return 12
    }
}

/// Keeps the edge swipe-back working on screens that hide the navigation bar.
/// The gesture only begins when there is a screen to go back to, so a swipe on
/// the root screen never leaves the stack waiting on a pop that cannot happen.
struct SwipeBackEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { Controller() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard let gesture = navigationController?.interactivePopGestureRecognizer else { return }
            gesture.isEnabled = true
            gesture.delegate = self
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            (navigationController?.viewControllers.count ?? 0) > 1
        }
    }
}
