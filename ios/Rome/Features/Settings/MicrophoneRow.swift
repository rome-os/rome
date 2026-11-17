import AVFoundation
import SwiftUI

/// Which microphone voice input records from, as the dashboard's Settings
/// offers it: System default, then each input iOS lists now.
struct MicrophoneRow: View {
    var last = false
    @State private var options: [MicrophoneOption] = []
    @State private var chosen = MicrophoneChoice().chosen

    /// The chosen microphone while it is listed, else nil for System default.
    /// An unplugged microphone leaves the list, so the row shows System
    /// default. Settings forgets the choice only from a complete list, which
    /// it cannot always get; until then the row still shows System default.
    private var shown: String? {
        options.contains { $0.id == chosen } ? chosen : nil
    }

    /// What the row shows: the chosen microphone, or System default.
    private var value: String {
        options.first { $0.id == shown }?.name ?? String(localized: "System default")
    }

    private func refresh() {
        let list = MicrophoneChoice.available()
        options = list.options
        chosen = MicrophoneChoice().settle(list)
    }

    /// Only a microphone plugged in or taken off changes the list. Listing
    /// the microphones changes the session's category and back, which iOS
    /// also reports as a route change, so refreshing on that would loop.
    nonisolated static func refreshes(on reason: AVAudioSession.RouteChangeReason?) -> Bool {
        reason == .newDeviceAvailable || reason == .oldDeviceUnavailable
    }

    var body: some View {
        SettingsRow(systemImage: "mic.badge.plus", title: "Microphone", last: last) {
            Menu {
                Picker("Microphone", selection: Binding(
                    get: { shown },
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
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification).receive(on: RunLoop.main)) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            if Self.refreshes(on: reason) { refresh() }
        }
    }
}
