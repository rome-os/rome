import SwiftUI

/// The card Rome writes into a chat whose turn could not run on its
/// provider: what stopped, and the ways forward the server offers. A press
/// shows "Continuing…" with the buttons off until the server settles the
/// card, which then reads as one line (docs/domains/agents.md#provider-failure).
struct ProviderFailureCardView: View {
    let part: ProviderFailurePart
    let messageId: String
    let store: TranscriptStore
    @Environment(AppModel.self) private var model
    @Environment(\.isVisitor) private var isVisitor
    @State private var showsDetail = false
    /// Read again when a quota's reset passes, so Continue comes then.
    @State private var now = Date.now

    private var pending: Bool { store.failurePending.contains(messageId) }

    var body: some View {
        let kind = part.kind
        // A turn that waits or needs the guardian stands out; a model change
        // does not. Never red: red is for what cannot recover.
        let accented = kind != .model
        let actions = isVisitor ? [] : ProviderFailureAction.of(part, now: now)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: Self.symbol(kind))
                    .romeFont(12, .semibold)
                Text(verbatim: ProviderFailureCopy.status(part, now: now))
                    .romeFont(CardScale.label, .medium)
            }
            .foregroundStyle(accented ? Palette.warningText : Palette.sub)
            Text(verbatim: ProviderFailureCopy.reason(part, now: now))
                .romeFont(CardScale.body)
                .foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
            if pending {
                HStack(spacing: 8) {
                    Spinner(size: 14, color: Palette.sub)
                    Text("Continuing…").romeFont(CardScale.caption).foregroundStyle(Palette.sub)
                }
                .padding(.top, 6)
                .transition(.opacity)
            } else if !actions.isEmpty {
                buttons(actions)
                    .padding(.top, 6)
            }
            if let failed = store.failureErrors[messageId], !pending {
                Text(failed.switchBody == nil ? "Could not continue" : "Could not switch")
                    .romeFont(CardScale.caption, .medium)
                    .foregroundStyle(Palette.destructive)
            }
            if let detail = part.detail, !detail.isEmpty {
                details(detail)
            }
        }
        // A quota's Continue comes once its reset passes: one wait, no timer.
        .task(id: part.until) {
            guard let until = RomeDate.parse(part.until), until > .now else { return }
            try? await Task.sleep(for: .seconds(until.timeIntervalSinceNow + 1))
            if !Task.isCancelled { now = .now }
        }
        .fillsBubbleWidth()
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .overlay(alignment: .leading) {
            if accented {
                UnevenRoundedRectangle(topLeadingRadius: Metrics.groupRadius, bottomLeadingRadius: Metrics.groupRadius, style: .continuous)
                    .fill(Palette.warning)
                    .frame(width: 3)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
        .animation(.easeOut(duration: 0.2), value: pending)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("provider-failure-\(kind.rawValue)")
    }

    static func symbol(_ kind: ProviderFailurePart.Kind) -> String {
        switch kind {
        case .wait: return "pause.circle"
        case .account: return "exclamationmark.triangle"
        case .model: return "info.circle"
        }
    }

    /// One row when they fit, else one under another.
    private func buttons(_ actions: [ProviderFailureAction]) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttonList(actions) }
            VStack(alignment: .leading, spacing: 8) { buttonList(actions) }
        }
    }

    @ViewBuilder
    private func buttonList(_ actions: [ProviderFailureAction]) -> some View {
        ForEach(Array(actions.enumerated()), id: \.element) { index, action in
            let primary = index == 0
            Button {
                if action == .logIn, part.provider.account == nil {
                    // Rome credits used up: any account logs in, on the AI Tools page.
                    model.openAIModel()
                } else {
                    store.press(action, part: part, messageId: messageId)
                }
            } label: {
                Text(verbatim: action.title)
                    .romeFont(CardScale.actionFont, primary ? .semibold : .medium)
                    .foregroundStyle(primary ? Color.white : Palette.fg)
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                    .frame(height: CardScale.actionHeight)
                    .background(primary ? Palette.primary : Palette.fill, in: Capsule())
                    .fixedSize()
            }
            .buttonStyle(PressScaleStyle())
            .disabled(pending)
        }
    }

    private func details(_ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { showsDetail.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .romeFont(10, .semibold)
                        .rotationEffect(.degrees(showsDetail ? 90 : 0))
                    Text("Details").romeFont(CardScale.caption)
                }
                .foregroundStyle(Palette.sub)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(showsDetail ? Text("Expanded") : Text("Collapsed"))
            if showsDetail {
                Text(verbatim: detail)
                    .romeFont(12, design: .monospaced)
                    .foregroundStyle(Palette.sub)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Palette.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .padding(.top, 2)
    }
}

/// The main Chat's notice for unattended chats one provider failure stopped:
/// what stopped and the task links. It informs only; each task's own card acts.
struct ProviderOutageNotice: View {
    let part: ProviderOutagePart

    var body: some View {
        VStack(spacing: 4) {
            NoticeLine(text: ProviderFailureCopy.outage(part))
            NoticeLine(text: ProviderFailureCopy.waiting(part.chatIds.count))
            if !part.chatIds.isEmpty {
                // The links read their tasks' names, as task links in a reply do.
                MarkdownText(source: Self.links(part.chatIds), fontSize: 13, lineSpacing: 3, color: Palette.sub)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// One task link per stopped chat, as Markdown task links.
    static func links(_ chatIds: [String]) -> String {
        chatIds.compactMap { id in TaskLink.url(chatId: id).map { "[\(String(localized: "Task"))](\($0.absoluteString))" } }.joined(separator: "  ")
    }
}

/// What a chat's provider failure cards ask its screen to show: the confirm
/// of a move to another provider, and an account's login sheet.
private struct ProviderFailurePrompts: ViewModifier {
    let store: TranscriptStore
    let workspace: Workspace

    func body(content: Content) -> some View {
        content
            .alert(
                Text(verbatim: confirmTitle),
                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { store.failurePrompt = nil } }),
                presenting: confirming
            ) { prompt in
                // A move to an account asks whether it becomes the default too;
                // Rome credits always do.
                if case .switchTo(let provider) = prompt.action {
                    Button("Switch this chat") { confirm(prompt.action, prompt.messageId) }
                    Button("Switch and make default") { confirm(.switchAndMakeDefault(provider), prompt.messageId) }
                } else {
                    Button("Switch") { confirm(prompt.action, prompt.messageId) }
                }
                Button("Cancel", role: .cancel) { store.failurePrompt = nil }
            } message: { prompt in
                Text(verbatim: Self.body(prompt.action))
            }
            .sheet(item: Binding(get: { loggingIn }, set: { if $0 == nil { store.failurePrompt = nil } })) { account in
                AILoginSheet(account: account, backend: workspace.backend) { read in
                    workspace.aiModel.update(read)
                }
            }
    }

    private func confirm(_ action: ProviderFailureAction, _ messageId: String) {
        store.failurePrompt = nil
        Task { await store.send(action, messageId: messageId) }
    }

    private var confirming: (messageId: String, action: ProviderFailureAction)? {
        if case .confirm(let messageId, let action)? = store.failurePrompt { return (messageId, action) }
        return nil
    }

    private var loggingIn: AIAccount? {
        if case .logIn(let account)? = store.failurePrompt { return account }
        return nil
    }

    private var confirmTitle: String {
        switch confirming?.action {
        case .useCredits?: return String(localized: "Switch to \(DefaultModelProvider.romeCredits.name)?")
        case .switchTo(let provider)?: return String(localized: "Switch to \(provider.name)?")
        default: return ""
        }
    }

    static func body(_ action: ProviderFailureAction) -> String {
        switch action {
        case .useCredits: return String(localized: "Every chat runs on Rome credits, and the stopped turn picks up again.")
        case .switchTo(let provider): return String(localized: "This chat continues on \(provider.name), and the stopped turn picks up again.")
        default: return ""
        }
    }
}

extension View {
    /// The confirms and login sheets a chat's failure cards open.
    func providerFailurePrompts(_ store: TranscriptStore, workspace: Workspace) -> some View {
        modifier(ProviderFailurePrompts(store: store, workspace: workspace))
    }

    /// A blank topic chat has no store yet, and no cards.
    @ViewBuilder
    func providerFailurePrompts(_ store: TranscriptStore?, workspace: Workspace) -> some View {
        if let store { providerFailurePrompts(store, workspace: workspace) } else { self }
    }
}
