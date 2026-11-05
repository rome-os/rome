import SwiftUI

/// Covers the app while the instance is behind its latest release. There is
/// no way past it but updating; switching instance and signing out stay.
struct UpdateScreen: View {
    @Environment(AppModel.self) private var model
    @State private var showInstances = false
    @State private var confirmSignOut = false

    private var updater: InstanceUpdater { model.update }

    var body: some View {
        VStack(spacing: 0) {
            topBar
                .padding(.horizontal, 16)
                .padding(.top, 4)
            Spacer(minLength: 0)
            center
                .padding(.horizontal, 32)
                .padding(.bottom, 24)
            Spacer(minLength: 0)
            bottom
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
                .frame(minHeight: 120, alignment: .bottom)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.bg.ignoresSafeArea())
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: updater.state)
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
        case .updating(let target, _):
            VStack(spacing: 20) {
                Spinner(size: 30, lineWidth: 2.6, color: Palette.primary, trackOpacity: 0.16)
                    .frame(width: 64, height: 64)
                    .background(Palette.primarySoft, in: Circle())
                VStack(spacing: 8) {
                    Text("Updating to \(target)…")
                        .romeFont(22, .semibold)
                        .tracking(-0.4)
                    Text("This can take a few minutes. You can leave the app; it picks up where it left off.")
                        .romeFont(16)
                        .lineSpacing(3)
                        .foregroundStyle(Palette.sub)
                }
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .transition(.opacity)
        case .failed(let failure):
            VStack(spacing: 18) {
                AlertGlyph(size: 26)
                    .frame(width: 64, height: 64)
                    .background(Palette.dangerSoft, in: Circle())
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
            }
            .frame(maxWidth: .infinity)
            .transition(.opacity)
        default:
            VStack(spacing: 22) {
                Image(systemName: "arrow.up")
                    .romeFont(24, .semibold)
                    .foregroundStyle(Palette.primaryIcon)
                    .frame(width: 64, height: 64)
                    .background(Palette.primarySoft, in: Circle())
                VStack(spacing: 8) {
                    Text("Update your Rome")
                        .romeFont(28, .bold)
                        .tracking(-0.7)
                    Group {
                        if latestChanged {
                            Text("A newer release just came out. Update to it to keep using the app.")
                        } else {
                            Text("This app works with the latest Rome. Update to keep using it.")
                        }
                    }
                    .romeFont(16)
                    .lineSpacing(3)
                    .foregroundStyle(Palette.sub)
                }
                .multilineTextAlignment(.center)
                versions
            }
            .frame(maxWidth: .infinity)
            .transition(.opacity)
        }
    }

    /// Current → latest, the latest in the brand color.
    @ViewBuilder
    private var versions: some View {
        if let release = release {
            HStack(spacing: 10) {
                Text(verbatim: release.current ?? "—")
                    .foregroundStyle(Palette.sub)
                Image(systemName: "arrow.right")
                    .romeFont(13, .semibold)
                    .foregroundStyle(Palette.sub)
                Text(verbatim: release.latest)
                    .foregroundStyle(Palette.primaryText)
            }
            .romeFont(16, .semibold, monospacedDigits: true)
            .padding(.horizontal, 18)
            .frame(height: 40)
            .background(Palette.elevated, in: Capsule())
            .softElevation(radius: 20)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("From \(release.current ?? "—") to \(release.latest)"))
        }
    }

    @ViewBuilder
    private var bottom: some View {
        switch updater.state {
        case .required, .starting:
            PrimaryButton(title: "Update now", loadingTitle: "Starting update", loading: isStarting) {
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

    private var isStarting: Bool {
        if case .starting = updater.state { return true }
        return false
    }
}
