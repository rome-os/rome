import SwiftUI

/// Covers the app while the instance is behind its latest release. There is
/// no way past it but updating; switching instance and signing out stay.
struct UpdateScreen: View {
    @Environment(AppModel.self) private var model
    @State private var showInstances = false
    @State private var confirmSignOut = false

    private var updater: InstanceUpdater { model.update }

    var body: some View {
        ZStack {
            Palette.bg
            // The mascot stays exactly where the opening screen has it; the
            // text hangs below it.
            Mascot(alive: isWaiting)
                .frame(width: Mascot.width)
                .overlay(alignment: .top) {
                    center
                        .frame(width: 320)
                        .fixedSize(horizontal: false, vertical: true)
                        .offset(y: Mascot.width * Mascot.viewBox.height / Mascot.viewBox.width + 20)
                }
        }
        .ignoresSafeArea()
        .overlay(alignment: .top) {
            topBar
                .padding(.horizontal, 16)
                .padding(.top, 4)
        }
        .overlay(alignment: .bottom) {
            bottom
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: updater.state)
        .animation(.easeInOut(duration: 0.25), value: updater.progress)
        .sheet(isPresented: $showInstances) {
            NavigationStack {
                InstancesScreen(onSwitched: { showInstances = false })
            }
            .presentationBackground(Palette.bg)
        }
        .confirmationDialog("After signing out, sign in with Rome Cloud to open Rome again.", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        }
    }

    // MARK: Parts

    private var topBar: some View {
        HStack {
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
            VStack(spacing: 12) {
                LoadingDots()
                if let line = UpdateGate.statusLine(updater.state, progress: updater.progress) {
                    Text(line)
                        .romeFont(17, .semibold)
                        .contentTransition(.opacity)
                        .id(line)
                        .transition(.opacity)
                }
                Text("This can take a few minutes. You can leave the app; it picks up where it left off.")
                    .romeFont(15)
                    .lineSpacing(3)
                    .foregroundStyle(Palette.sub)
            }
            .multilineTextAlignment(.center)
            .accessibilityElement(children: .combine)
            .transition(.opacity)
        case .failed(let failure):
            VStack(spacing: 8) {
                switch failure {
                case .timedOut(let target):
                    Text("The update is taking too long").romeFont(22, .semibold).tracking(-0.4)
                    Text("Your Rome has not come back on \(target). Check it in Rome Cloud, or try again.")
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
                Text("Update your Rome")
                    .romeFont(28, .bold)
                    .tracking(-0.7)
                if latestChanged {
                    Text("A newer release just came out.")
                        .romeFont(15, .semibold)
                        .foregroundStyle(Palette.primaryText)
                }
                if let release {
                    Group {
                        if let current = release.current {
                            Text("Your Rome is on \(current). The latest is \(release.latest). The app needs the latest Rome.")
                        } else {
                            Text("The latest is \(release.latest). The app needs the latest Rome.")
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
            PrimaryButton(title: "Update now") {
                Task { await updater.updateNow() }
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
