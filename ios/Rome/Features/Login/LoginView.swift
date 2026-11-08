import AuthenticationServices
import SwiftUI

/// Board 1: sign in with Rome Cloud, then open an instance on our own.
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.openURL) private var openURL
    @State private var showDebugMenu = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // Large text: the page scrolls, and the button keeps its own room.
                ScrollView {
                    VStack(spacing: 20) {
                        Mascot(blinks: true).frame(width: 64)
                        center
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 48)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity)
                }
                .background(Palette.bg.ignoresSafeArea())
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    bottom
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                        .padding(.bottom, 18)
                        .background(Palette.bg)
                }
            } else {
                ZStack {
                    Palette.bg
                    // Where the launch and opening screens draw it, so the logo never moves.
                    Mascot(blinks: true)
                        .frame(width: Mascot.width)
                        .overlay(alignment: .top) {
                            center
                                .frame(width: 320)
                                .fixedSize(horizontal: false, vertical: true)
                                .offset(y: Mascot.width * Mascot.viewBox.height / Mascot.viewBox.width + 20)
                        }
                }
                .ignoresSafeArea()
                .overlay(alignment: .bottom) {
                    bottom
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)
                }
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: model.phase)
        .animation(.easeOut(duration: 0.2), value: model.signInError)
        #if DEBUG
        .confirmationDialog("Debug", isPresented: $showDebugMenu) {
            Button("Open demo data") { model.openDemo() }
        }
        #endif
    }

    @ViewBuilder
    private var center: some View {
        switch model.phase {
        case .stopped, .noInstance:
            VStack(spacing: 6) {
                Text(model.phase == .noInstance ? "No Rome to open yet" : "Your Rome is stopped")
                    .romeFont(20, .semibold)
                Text(model.phase == .noInstance ? "Create one in Rome Cloud, then open it here." : "Start it in Rome Cloud, then open it here.")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
            }
            .multilineTextAlignment(.center)
            .transition(.opacity)
        default:
            VStack(spacing: 6) {
                Text(verbatim: "Rome")
                    .romeFont(22, .medium)
                    .tracking(-0.4)
                    .onLongPressGesture(minimumDuration: 1.2) {
                        #if DEBUG
                        showDebugMenu = true
                        #endif
                    }
                Text("Sign in to open your Rome")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
            }
            .multilineTextAlignment(.center)
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var bottom: some View {
        VStack(spacing: 14) {
            switch model.phase {
            case .signedOut, .signingIn:
                if let error = model.signInError {
                    HStack(spacing: 6) {
                        AlertGlyph(size: 14)
                        Text(error).romeFont(14)
                    }
                    .foregroundStyle(Palette.destructive)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Palette.dangerSoft, in: Capsule())
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                ForEach(Self.signedOutActions(browserSignIn: model.browserSignIn), id: \.self) { action in
                    switch action {
                    case .signIn:
                        PrimaryButton(title: "Sign in with Rome Cloud", loadingTitle: "Signing in", loading: model.phase == .signingIn) {
                            signIn()
                        }
                    case .openInBrowser:
                        PrimaryButton(title: "Open in browser") { if let site = model.browserSignIn { openURL(site) } }
                    case .tryAgain:
                        SecondaryButton(title: "Try again") { Task { await model.retry() } }
                    case .signOut:
                        signOutButton
                    }
                }
            case .stopped, .noInstance:
                // Why the list is short now: taken off a Rome's allow-list.
                if let error = model.signInError {
                    HStack(spacing: 6) {
                        AlertGlyph(size: 14)
                        Text(error).romeFont(14)
                    }
                    .foregroundStyle(Palette.destructive)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Palette.dangerSoft, in: Capsule())
                }
                SecondaryButton(title: "Try again") { Task { await model.retry() } }
                signOutButton
            default:
                EmptyView()
            }
        }
    }

    enum SignedOutAction: Hashable { case signIn, openInBrowser, tryAgain, signOut }

    /// The buttons under a signed-out screen. Signed in to Rome Cloud but
    /// refused by the Rome (not_owner): one browser sign-in, then again, or
    /// sign out to use another account.
    static func signedOutActions(browserSignIn: URL?) -> [SignedOutAction] {
        browserSignIn == nil ? [.signIn] : [.openInBrowser, .tryAgain, .signOut]
    }

    private var signOutButton: some View {
        Button("Sign out") { Task { await model.signOut() } }
            .romeFont(17)
            .foregroundStyle(Palette.sub)
            .frame(height: 44)
    }

    private func signIn() {
        let request = model.beginSignIn()
        Task {
            let result: Result<URL, Error>
            do {
                let url = try await webAuthenticationSession.authenticate(
                    using: request.authorizeURL,
                    callbackURLScheme: request.callbackScheme,
                    preferredBrowserSession: .ephemeral
                )
                result = .success(url)
            } catch {
                result = .failure(error)
            }
            await model.finishSignIn(request, callback: result)
        }
    }
}

/// The filled primary capsule (54 pt) with a soft coral glow.
struct PrimaryButton: View {
    let title: LocalizedStringKey
    var loadingTitle: LocalizedStringKey? = nil
    var loading = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if loading {
                    Spinner(size: 18, lineWidth: 2.4, color: .white, trackOpacity: 0.35)
                }
                Text(loading ? (loadingTitle ?? title) : title)
                    .romeFont(17, .semibold)
                    .tracking(-0.3)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(Palette.primary, in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.18), lineWidth: 0.5).blendMode(.overlay))
            .shadow(color: Palette.primary.opacity(0.45), radius: 10, x: 0, y: 6)
            .opacity(loading ? 0.85 : (disabled ? 0.4 : 1))
            .contentShape(Capsule())
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .disabled(loading || disabled)
        .sensoryFeedback(.impact(weight: .medium), trigger: loading)
    }
}

/// The neutral filled capsule (54 pt).
struct SecondaryButton: View {
    let title: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .romeFont(17, .semibold)
                .foregroundStyle(Palette.fg)
                .frame(maxWidth: .infinity)
                .frame(height: 54)
                .background(Palette.fill, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
    }
}
