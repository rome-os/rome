import SwiftUI

/// Settings → current instance: every Rome on the account, the open one ticked.
struct InstancesScreen: View {
    let onSwitched: () -> Void
    @Environment(AppModel.self) private var model
    @State private var switching: String?
    @State private var stoppedNotice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if model.instances.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(0..<3, id: \.self) { index in
                            SkeletonRow(last: index == 2)
                        }
                    }
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.instances.enumerated()), id: \.element.id) { index, instance in
                            row(instance, last: index == model.instances.count - 1)
                        }
                    }
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                }
                if let stoppedNotice {
                    Text(stoppedNotice)
                        .romeFont(13)
                        .foregroundStyle(Palette.destructive)
                        .padding(.horizontal, 16)
                        .transition(.opacity)
                }
                Text("Instances are managed in Rome Cloud.")
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, 16)
            }
            .padding(.top, 8)
            .padding(.bottom, 32)
            .animation(.easeOut(duration: 0.2), value: stoppedNotice)
        }
        .softTopScrollEdge()
        .floatingTopBar { PageHeader(title: "Switch instance", inSheet: true) }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task { await model.refreshInstances() }
    }

    private func row(_ instance: CloudInstance, last: Bool) -> some View {
        let current = instance.id == model.currentInstanceID
        return Button {
            guard !current, switching == nil else { return }
            guard instance.isRunning else {
                stoppedNotice = String(localized: "“\(instance.name)” is stopped. Start it in Rome Cloud, then open it here.")
                return
            }
            switching = instance.id
            Task {
                onSwitched()
                await model.switchInstance(to: instance)
                switching = nil
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(instance.name)
                        .romeFont(17, .semibold)
                        .foregroundStyle(Palette.fg)
                    Text(instance.host)
                        .romeFont(14)
                        .foregroundStyle(Palette.sub)
                }
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(instance.isRunning ? Palette.success : Palette.sub.opacity(0.4)).frame(width: 7, height: 7)
                    Text(instance.isRunning ? "Running" : "Stopped")
                        .romeFont(14)
                        .foregroundStyle(Palette.sub)
                }
                Group {
                    if switching == instance.id {
                        Spinner(size: 16, color: Palette.sub)
                    } else if current {
                        Image(systemName: "checkmark")
                            .romeFont(15, .bold)
                            .foregroundStyle(Palette.primary)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 20)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 60)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
            }
            .opacity(instance.isRunning ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

private struct SkeletonRow: View {
    let last: Bool
    @State private var pulse = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(Palette.fill).frame(width: 96, height: 14)
                RoundedRectangle(cornerRadius: 4).fill(Palette.fill).frame(width: 140, height: 11)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 60)
        .opacity(pulse ? 0.5 : 1)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true }
        }
    }
}

/// Search across Chat and the task chats.
struct SearchScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    let onOpen: (SearchHit) -> Void

    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searching = false
    @State private var searched = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            DrawerPageHeader(title: Text("Search"), onMenu: onMenu)
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").romeFont(16, .medium).foregroundStyle(Palette.sub)
                    TextField("Search messages", text: $query)
                        .romeFont(17)
                        .focused($focused)
                        .submitLabel(.search)
                        .onSubmit { run() }
                    if !query.isEmpty {
                        Button { query = ""; hits = []; searched = false } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.sub)
                        }
                        .accessibilityLabel("Clear")
                    }
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(Palette.elevated, in: Capsule())
                .softElevation(radius: 22)
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 10)

            if searching {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            } else if searched && hits.isEmpty {
                Spacer()
                Text("No matching messages").romeFont(17, .semibold)
                Text("Try a different word.").romeFont(15).foregroundStyle(Palette.sub).padding(.top, 4)
                Spacer()
                Spacer()
            } else if !searched {
                Spacer()
                Text("Search messages in Chat and tasks").romeFont(15).foregroundStyle(Palette.sub)
                Spacer()
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                            Button { onOpen(hit) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(hit.session.id == conciergeChatID ? "Chat" : hit.session.name)
                                            .romeFont(13, .semibold)
                                            .foregroundStyle(Palette.sub)
                                            .lineLimit(1)
                                        Spacer()
                                        if let date = RomeDate.parse(hit.message.createdAt) {
                                            Text(RelativeTime.ago(date)).romeFont(12).foregroundStyle(Palette.sub)
                                        }
                                    }
                                    Text(highlighted(hit.message.snippet))
                                        .romeFont(16)
                                        .foregroundStyle(Palette.fg)
                                        .lineLimit(3)
                                        .multilineTextAlignment(.leading)
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .overlay(alignment: .bottom) {
                                    if index < hits.count - 1 { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 16) }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                        }
                    }
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.immediately)
            }
        }
        .pageBackground()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .onAppear { focused = true }
        .task(id: query) {
            let trimmed = query.trimmingCharacters(in: .whitespaces)
            guard trimmed.count >= 2 else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            run()
        }
    }

    private func run() {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        searching = hits.isEmpty
        Task {
            let result = (try? await workspace.backend.search(trimmed)) ?? []
            hits = result
            searched = true
            searching = false
        }
    }

    private func highlighted(_ snippet: String) -> AttributedString {
        var text = AttributedString(MarkdownParser.plain(snippet))
        let needle = query.trimmingCharacters(in: .whitespaces)
        if !needle.isEmpty, let range = text.range(of: needle, options: .caseInsensitive) {
            text[range].foregroundColor = Palette.primaryText
            text[range].font = .system(size: 16, weight: .semibold)
        }
        return text
    }
}
