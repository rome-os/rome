import AuthenticationServices
import SwiftUI

/// Board 1: sign in with Rome Cloud, then open an instance on our own.
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var showDebugMenu = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            center
                .padding(.horizontal, 32)
                .padding(.bottom, 40)
            Spacer(minLength: 0)
            bottom
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
                .frame(minHeight: 120, alignment: .bottom)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.bg.ignoresSafeArea())
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
        case .connecting(let host):
            VStack(spacing: 18) {
                Spinner(size: 28, lineWidth: 2.5, color: Palette.fg, trackOpacity: 0.12)
                VStack(spacing: 4) {
                    Text("Opening your Rome").romeFont(17, .semibold)
                    Text(host).romeFont(15).foregroundStyle(Palette.sub)
                }
            }
            .frame(maxWidth: .infinity)
            .transition(.opacity.combined(with: .scale(scale: 0.98)))
        case .stopped, .noInstance:
            VStack(spacing: 16) {
                Image(systemName: "power")
                    .romeFont(22, .medium)
                    .frame(width: 56, height: 56)
                    .background(Palette.fill, in: Circle())
                VStack(spacing: 6) {
                    Text(model.phase == .noInstance ? "No Rome to open yet" : "Your Rome is stopped")
                        .romeFont(20, .semibold)
                    Text(model.phase == .noInstance ? "Create one in Rome Cloud, then open it here." : "Start it in Rome Cloud, then open it here.")
                        .romeFont(15)
                        .foregroundStyle(Palette.sub)
                }
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .transition(.opacity)
        case .launching:
            Color.clear.frame(height: 1)
        default:
            VStack(alignment: .leading, spacing: 14) {
                Text("Rome")
                    .romeFont(64, .semibold)
                    .tracking(-2.2)
                    .onLongPressGesture(minimumDuration: 1.2) {
                        #if DEBUG
                        showDebugMenu = true
                        #endif
                    }
                Text("Sign in to open your Rome")
                    .romeFont(20)
                    .tracking(-0.3)
                    .foregroundStyle(Palette.sub)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
                PrimaryButton(title: "Sign in with Rome Cloud", loadingTitle: "Signing in", loading: model.phase == .signingIn) {
                    signIn()
                }
            case .stopped, .noInstance:
                SecondaryButton(title: "Try again") { Task { await model.retry() } }
                Button("Sign out") { Task { await model.signOut() } }
                    .romeFont(17)
                    .foregroundStyle(Palette.sub)
                    .frame(height: 44)
            default:
                EmptyView()
            }
        }
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
