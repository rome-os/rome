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
                    .background(Palette.secondaryCard, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                    .hairline(radius: Metrics.groupRadius)
                    .padding(.horizontal, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.instances.enumerated()), id: \.element.id) { index, instance in
                            row(instance, last: index == model.instances.count - 1)
                        }
                    }
                    .background(Palette.secondaryCard, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
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
        .secondaryPageBackground()
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
                    HStack(spacing: 6) {
                        // A long name is cut, never the badge.
                        Text(instance.name)
                            .romeFont(16, .semibold)
                            .foregroundStyle(Palette.fg)
                            .lineLimit(1)
                        if instance.isVisitor { VisitorBadge(fill: Palette.secondaryFill).fixedSize() }
                    }
                    Text(verbatim: instance.host)
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                // Running is the normal case and says nothing; only a stopped one is named.
                if !instance.isRunning {
                    Text("Stopped")
                        .romeFont(14)
                        .foregroundStyle(Palette.sub)
                        .fixedSize()
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
                RoundedRectangle(cornerRadius: 4).fill(Palette.secondaryFill).frame(width: 96, height: 14)
                RoundedRectangle(cornerRadius: 4).fill(Palette.secondaryFill).frame(width: 140, height: 11)
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

/// The search page's results. Only the newest search may fill them: an
/// older one that answers late, or one still on its way when the field is
/// cleared, changes nothing.
@MainActor
@Observable
final class MessageSearch {
    private(set) var hits: [SearchHit] = []
    private(set) var searching = false
    private(set) var searched = false
    @ObservationIgnored private var latest = 0

    func run(_ query: String, using search: (String) async throws -> [SearchHit]) async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        latest += 1
        let serial = latest
        searching = hits.isEmpty
        let result = (try? await search(trimmed)) ?? []
        guard serial == latest else { return }
        hits = result
        searched = true
        searching = false
    }

    /// The field was cleared or is too short to search: whatever is still
    /// on its way is dropped.
    func cancel(clearing: Bool) {
        latest += 1
        searching = false
        if clearing {
            hits = []
            searched = false
        }
    }
}

/// Search across Chat and the task chats.
struct SearchScreen: View {
    let workspace: Workspace
    let onMenu: () -> Void
    let onOpen: (SearchHit) -> Void

    @State private var query = ""
    @State private var search = MessageSearch()
    private var hits: [SearchHit] { search.hits }
    private var searching: Bool { search.searching }
    private var searched: Bool { search.searched }
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
                        .onSubmit { Task { await run() } }
                    if !query.isEmpty {
                        Button { query = ""; search.cancel(clearing: true) } label: {
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
                                        Text(workspace.isMainChat(hit.session.id) ? "Chat" : hit.session.name)
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
            guard trimmed.count >= 2 else {
                search.cancel(clearing: trimmed.isEmpty)
                return
            }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await run()
        }
    }

    private func run() async {
        let backend = workspace.backend
        await search.run(query) { try await backend.search($0) }
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

/// A Rome shared with this account: its owner put them on its allow-list.
struct VisitorBadge: View {
    /// `Palette.secondaryFill` on a second-level page's card.
    var fill = Palette.fill

    var body: some View {
        Text("Visitor")
            .romeFont(11, .semibold)
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(fill, in: Capsule())
            .accessibilityLabel(Text("Visitor"))
    }
}

