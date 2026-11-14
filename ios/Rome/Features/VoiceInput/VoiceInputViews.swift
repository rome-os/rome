import SwiftUI
import UIKit

/// The microphone beside the message field: one tap starts listening, one stops it.
struct VoiceInputButton: View {
    let state: VoiceInputController.State
    let action: () -> Void

    private var label: LocalizedStringKey {
        switch state {
        case .idle: "Start voice input"
        case .listening: "Stop voice input"
        case .finishing: "Finishing voice input"
        }
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: state == .listening ? "stop.circle.fill" : "mic")
                .romeFont(17, .medium)
                .foregroundStyle(state == .listening ? Palette.primary : Palette.sub)
                .opacity(state == .finishing ? 0.5 : 1)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
        .disabled(state == .finishing)
        .accessibilityLabel(label)
        .accessibilityAddTraits(state == .listening ? .isSelected : [])
        .accessibilityIdentifier("voice-input")
    }
}

/// Why listening stopped on its own, above the field. A blocked microphone's
/// notice opens the app's page in Settings.
struct VoiceInputNotice: View {
    let stop: VoiceInputStop

    var body: some View {
        Group {
            if stop.reason == .microphoneBlocked, let settings = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settings) { line }
            } else {
                line
            }
        }
        .accessibilityIdentifier("voice-input-notice")
    }

    private var line: some View {
        Text(verbatim: stop.notice)
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
