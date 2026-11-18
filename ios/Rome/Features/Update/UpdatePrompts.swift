import SwiftUI

/// Words that name the Rome being updated, so no one reads them as an update
/// to this app. A long name is cut in the middle, keeping each line to one.
enum UpdateCopy {
    static let nameLimit = 18

    static func shortName(_ name: String, limit: Int = nameLimit) -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.count > limit else { return name }
        let head = (limit - 1) / 2 + (limit - 1) % 2, tail = (limit - 1) / 2
        return String(name.prefix(head)) + "…" + String(name.suffix(tail))
    }

    static func banner(_ name: String) -> String { String(localized: "\(shortName(name)) has an update") }
    static func updated(_ name: String, version: String) -> String { String(localized: "\(shortName(name)) updated to \(version)") }
    static func confirmTitle(_ name: String, version: String) -> String { String(localized: "Update \(shortName(name)) to \(version)?") }
    static func confirmMessage(_ name: String) -> String {
        String(localized: "\(shortName(name)) restarts to finish the update and cannot answer for a few minutes.")
    }

    /// The drawer row's line for an upgrade that ended without its release.
    static func failed(_ failure: InstanceUpdater.Failure) -> String {
        switch failure {
        case .start: return String(localized: "Update did not start")
        case .timedOut: return String(localized: "Update is taking too long")
        case .rolledBack: return String(localized: "Update did not finish")
        }
    }

    /// The Agent's name as the chat header shows it, or Rome before it is known.
    static func agent(_ name: String?) -> String {
        shortName(AgentName.shown(name))
    }
}

/// The drawer's one row for the open Rome's release: the accent on a light
/// tint, shaped like the drawer's rows, never raised like the selected one.
/// Offered, a tap asks to confirm and the upgrade runs in the background;
/// the row then shows how it goes, and a failure offers Retry. It leaves
/// once the upgrade lands, and the composer says so.
struct DrawerUpdateRow: View {
    /// The Agent's display name, as the Chat header names it.
    let agentName: String?
    let state: InstanceUpdater.RowState

    @Environment(AppModel.self) private var model
    @State private var confirming = false

    private var updater: InstanceUpdater { model.update }
    private var name: String { UpdateCopy.agent(agentName) }

    var body: some View {
        Group {
            switch state {
            case .offered(let version):
                Button { confirming = true } label: {
                    row {
                        Image(systemName: "arrow.down.circle")
                            .romeFont(16, .medium)
                            .frame(width: 22)
                        Text(verbatim: UpdateCopy.banner(name))
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .romeFont(12, .semibold)
                    }
                }
                .buttonStyle(PressScaleStyle(scale: 0.98))
                .confirmationDialog(Text(verbatim: UpdateCopy.confirmTitle(name, version: version)), isPresented: $confirming, titleVisibility: .visible) {
                    Button("Update") { Task { await updater.updateInBackground() } }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(verbatim: UpdateCopy.confirmMessage(name))
                }
            case .starting, .updating:
                row {
                    Spinner(size: 15, lineWidth: 1.8, color: Palette.success)
                        .frame(width: 22)
                    Text(verbatim: progressLine)
                    Spacer(minLength: 4)
                }
                .accessibilityElement(children: .combine)
            case .failed(let failure):
                Button { Task { await updater.retryInBackground() } } label: {
                    row {
                        AlertGlyph(size: 16)
                            .frame(width: 22)
                        Text(verbatim: UpdateCopy.failed(failure))
                        Spacer(minLength: 4)
                        Text("Retry")
                            .romeFont(14, .semibold)
                            .foregroundStyle(Palette.success)
                    }
                }
                .buttonStyle(PressScaleStyle(scale: 0.98))
                .disabled(updater.retrying)
            }
        }
        // VoiceOver hears each step as it comes.
        .onChange(of: progressLine) { _, line in
            if !line.isEmpty { AccessibilityNotification.Announcement(line).post() }
        }
    }

    private var progressLine: String {
        if case .starting = state { return String(localized: "Starting the update…") }
        return UpdateGate.statusLine(updater.state, progress: updater.progress, agentName: agentName) ?? ""
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 10) { content() }
            .romeFont(15, .medium)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .foregroundStyle(Palette.success)
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(Palette.successSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Just above the composer in Chat and topic chats, centred, once: a
/// background upgrade from this phone just landed. It sits in the composer's
/// inset, so the last message rests above it and the header is never covered.
struct UpdatedNotice: View {
    /// The Agent's display name, as the header shows it.
    let agentName: String?
    /// The chat is in front: Chat stays mounted, hidden, under the other
    /// sections, and a hidden one must not use the line up.
    let visible: Bool

    @Environment(AppModel.self) private var model

    private var updater: InstanceUpdater { model.update }

    /// Whether the line shows, and so is used up: only on the chat in front,
    /// with nothing over the whole app. A hidden composer leaves it for the
    /// next one the guardian sees.
    static func shows(chatInFront: Bool, pagesUncovered: Bool) -> Bool {
        chatInFront && pagesUncovered
    }

    var body: some View {
        // Part of the fixed bar with the composer: it comes and goes in place,
        // with no motion of its own, so the space under the transcript never
        // changes on its own schedule.
        Group {
            if Self.shows(chatInFront: visible, pagesUncovered: model.pagesUncovered), let version = updater.updatedInBackgroundTo {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle")
                        .romeFont(14, .semibold)
                        .foregroundStyle(Palette.primaryText)
                    Text(verbatim: UpdateCopy.updated(UpdateCopy.agent(agentName), version: version))
                        .romeFont(14, .medium)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                }
                .padding(.horizontal, 14)
                .frame(height: 36)
                .glassSurface(Capsule(), frost: Frost.composer)
                .accessibilityElement(children: .combine)
                // Said once, for about three seconds on screen.
                .task(id: version) {
                    try? await Task.sleep(for: .seconds(3))
                    guard !Task.isCancelled else { return }
                    updater.clearUpdated()
                }
            }
        }
        .frame(maxWidth: .infinity)
        .transaction { $0.animation = nil }
    }
}
