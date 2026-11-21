import SwiftUI

/// The update page. Below the app's blocking minimum it covers the app with no
/// way past it but updating; switching instance and signing out stay. Below
/// the background minimum only, it asks once and hands the upgrade to the
/// drawer, which shows how it goes. A release the instance can do without
/// opens it from the banner or the drawer, and it closes again.
struct UpdateScreen: View {
    @Environment(AppModel.self) private var model
    @State private var showInstances = false
    @State private var confirmSignOut = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var updater: InstanceUpdater { model.update }

    private var statusLine: String? { UpdateGate.statusLine(updater.state, progress: updater.progress, agentName: model.workspace?.agentName) }

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // Large text: the page scrolls, and the buttons keep their own room.
                ScrollView {
                    VStack(spacing: 20) {
                        Mascot(alive: isWaiting).frame(width: 64)
                        center
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 24)
                    .frame(maxWidth: .infinity)
                }
                .background(Palette.bg.ignoresSafeArea())
                .safeAreaInset(edge: .top, spacing: 0) {
                    topBar
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    bottom
                        .frame(maxWidth: Metrics.buttonWidth)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                        .padding(.bottom, 18)
                        .background(Palette.bg)
                }
            } else {
                VStack(spacing: 0) {
                    topBar
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                    // The mascot and its text sit a little above the middle of
                    // the room between the bar and the button, and scroll
                    // rather than reach the button when larger text fills it.
                    GeometryReader { room in
                        ScrollView {
                            AboveCenter(minHeight: room.size.height) {
                                VStack(spacing: 20) {
                                    Mascot(alive: isWaiting).frame(width: Mascot.width)
                                    center
                                        .frame(maxWidth: 320)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .padding(.horizontal, 24)
                                .padding(.vertical, 16)
                            }
                        }
                        .scrollBounceBehavior(.basedOnSize)
                    }
                    bottom
                        .frame(maxWidth: Metrics.buttonWidth)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)
                }
                .background(Palette.bg.ignoresSafeArea())
            }
        }
        // VoiceOver hears each step of the update as it comes.
        .onChange(of: statusLine) { _, line in
            if let line { AccessibilityNotification.Announcement(line).post() }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: updater.state)
        .animation(.easeInOut(duration: 0.25), value: updater.progress)
        .sheet(isPresented: $showInstances) {
            NavigationStack {
                InstancesScreen(onSwitched: { showInstances = false })
            }
            .presentationBackground(Palette.bg)
        }
        // The same confirmation as Settings'.
        .alert("Sign out?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: Parts

    private var topBar: some View {
        HStack {
            if updater.canClose {
                Button { updater.closePage() } label: {
                    Image(systemName: "xmark")
                        .romeFont(16, .semibold)
                        .foregroundStyle(Palette.fg)
                        .frame(width: 44, height: 44)
                        .glassSurface(Circle(), interactive: true)
                }
                .accessibilityLabel(Text("Close"))
            }
            Spacer()
            Menu {
                Button { showInstances = true } label: {
                    Label("Switch instance", systemImage: "arrow.left.arrow.right")
                }
                Button(role: .destructive) { confirmSignOut = true } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                HStack(spacing: 8) {
                    Text(instanceName)
                        .romeFont(15, .semibold)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .romeFont(12, .semibold)
                        .foregroundStyle(Palette.sub)
                }
                .foregroundStyle(Palette.fg)
                .padding(.horizontal, 16)
                .frame(height: 44)
                .glassSurface(Capsule(), interactive: true)
            }
            .accessibilityLabel(Text("\(instanceName), account options"))
        }
    }

    @ViewBuilder
    private var center: some View {
        switch updater.state {
        case .starting, .updating:
            VStack(spacing: 16) {
                VStack(spacing: 12) {
                    LoadingDots()
                    if let line = statusLine {
                        Text(line)
                            .romeFont(17, .semibold)
                            .contentTransition(.opacity)
                            .id(line)
                            .transition(.opacity)
                    }
                    Text("This runs on your Rome's server, not on this phone, and can take a few minutes. You can leave the app and come back.")
                        .romeFont(15)
                        .lineSpacing(3)
                        .foregroundStyle(Palette.sub)
                }
                .multilineTextAlignment(.center)
                .accessibilityElement(children: .combine)
                // Something to do while it waits; the game keeps this status.
                Button { model.stackGame = StackGameLaunch(fromUpdate: true) } label: {
                    Label("Play a game", systemImage: "gamecontroller")
                        .romeFont(15, .medium)
                        .foregroundStyle(Palette.fg)
                        .padding(.horizontal, 16)
                        .frame(height: 38)
                        .background(Palette.fill, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle(scale: 0.97))
            }
            .transition(.opacity)
        case .failed(let failure):
            VStack(spacing: 8) {
                switch failure {
                case .timedOut(let target):
                    Text("The update is taking too long").romeFont(22, .semibold).tracking(-0.4)
                    Text("Your Rome has not come back on \(target). Check it in Rome Cloud, or try again.")
                        .romeFont(16)
                        .foregroundStyle(Palette.sub)
                case .rolledBack(_, let from):
                    Text("The update did not finish").romeFont(22, .semibold).tracking(-0.4)
                    Text("Your Rome is still on \(from). Check it in Rome Cloud, or try again.")
                        .romeFont(16)
                        .foregroundStyle(Palette.sub)
                case .start(_, _, let message):
                    Text("Could not start the update").romeFont(22, .semibold).tracking(-0.4)
                    Text(message)
                        .romeFont(16)
                        .foregroundStyle(Palette.sub)
                }
            }
            .lineSpacing(3)
            .multilineTextAlignment(.center)
            .transition(.opacity)
        default:
            VStack(spacing: 8) {
                // Names Rome, so no one reads it as an update to this app.
                Text("Update Rome")
                    .romeFont(28, .bold)
                    .lineLimit(1)
                    .tracking(-0.7)
                if latestChanged {
                    Text("A newer release just came out.")
                        .romeFont(15, .semibold)
                        .foregroundStyle(Palette.primaryText)
                }
                if let release {
                    VStack(spacing: 12) {
                        Group {
                            if updater.belowMinimum {
                                if let current = release.current {
                                    Text("Your Rome is on \(current). The latest is \(release.latest). This app needs a newer Rome.")
                                } else {
                                    Text("The latest is \(release.latest). This app needs a newer Rome.")
                                }
                            } else if let current = release.current {
                                Text("Your Rome is on \(current). The latest is \(release.latest).")
                            } else {
                                Text("The latest is \(release.latest).")
                            }
                        }
                        switch updater.pageVariant {
                        case .blocking:
                            Text("The app cannot be used during this update, which takes a few minutes.")
                        case .background:
                            Text("This update runs in the background. Chat and the main features keep working. A few new features may not work until it finishes.")
                        case nil:
                            EmptyView()
                        }
                    }
                    .romeFont(16)
                    .lineSpacing(3)
                    .foregroundStyle(Palette.sub)
                }
            }
            .multilineTextAlignment(.center)
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var bottom: some View {
        switch updater.state {
        case .required:
            if updater.pageVariant == .background {
                PrimaryButton(title: "Update in background") {
                    Task { await updater.updateFromBackgroundPage() }
                }
            } else {
                PrimaryButton(title: "Update now") {
                    Task { await updater.updateNow() }
                }
            }
        case .failed:
            PrimaryButton(title: "Try again") {
                Task { await updater.retry() }
            }
        default:
            EmptyView()
        }
    }

    // MARK: Reading the state

    private var instanceName: String {
        model.workspace?.instanceName
            ?? model.instances.first { $0.id == model.currentInstanceID }?.name
            ?? String(localized: "My Rome")
    }

    private var release: (current: String?, latest: String)? {
        switch updater.state {
        case .required(let current, let latest, _), .starting(let current, let latest):
            return (current, latest)
        default:
            return nil
        }
    }

    private var latestChanged: Bool {
        if case .required(_, _, true) = updater.state { return true }
        return false
    }

    /// Waiting on the update: the mascot comes alive.
    private var isWaiting: Bool {
        switch updater.state {
        case .starting, .updating: return true
        default: return false
        }
    }
}

/// Places its one view at 45% of the room left around it, from the top: a
/// little above the middle, which reads as balanced. Never shorter than
/// `minHeight`, and as tall as the view when the view needs more.
private struct AboveCenter: Layout {
    var minHeight: CGFloat
    var fraction: CGFloat = 0.45

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let content = subviews.first?.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)) ?? .zero
        return CGSize(width: proposal.width ?? content.width, height: max(minHeight, content.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let view = subviews.first else { return }
        let content = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
        let top = bounds.minY + max(0, (bounds.height - content.height) * fraction)
        view.place(at: CGPoint(x: bounds.midX, y: top), anchor: .top, proposal: ProposedViewSize(width: bounds.width, height: content.height))
    }
}
