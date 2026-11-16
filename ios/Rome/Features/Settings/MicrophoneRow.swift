import AVFoundation
import SwiftUI

/// Which microphone voice input records from, as the dashboard's Settings
/// offers it: System default, then each input iOS lists now.
struct MicrophoneRow: View {
    var last = false
    @State private var options: [MicrophoneOption] = []
    @State private var chosen = MicrophoneChoice().chosen

    /// What the row shows: the chosen microphone, or System default.
    private var value: String {
        options.first { $0.id == chosen }?.name ?? String(localized: "System default")
    }

    /// An unplugged microphone leaves the list, and the choice switches to
    /// the system default, which voice input then records from.
    private func refresh() {
        options = MicrophoneChoice.available()
        chosen = MicrophoneChoice().settle(connected: options.map(\.id))
    }

    var body: some View {
        SettingsRow(systemImage: "mic.badge.plus", title: "Microphone", last: last) {
            Menu {
                Picker("Microphone", selection: Binding(
                    get: { chosen },
                    set: { id in
                        let choice = MicrophoneChoice()
                        choice.chosen = id
                        chosen = choice.chosen
                    }
                )) {
                    Text("System default").tag(String?.none)
                    ForEach(options) { option in
                        Text(verbatim: option.name).tag(Optional(option.id))
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(verbatim: value)
                        .romeFont(17)
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Image(systemName: "chevron.up.chevron.down")
                        .romeFont(12, .semibold)
                        .foregroundStyle(Palette.sub)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Microphone")
            .accessibilityValue(Text(verbatim: value))
            .accessibilityIdentifier("voice-input-microphone")
        }
        .onAppear { refresh() }
        // A headset plugged in or taken off changes the list.
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification).receive(on: RunLoop.main)) { _ in
            refresh()
        }
    }
}
