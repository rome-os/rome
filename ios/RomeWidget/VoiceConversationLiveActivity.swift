import ActivityKit
import SwiftUI
import WidgetKit

/// A running voice conversation on the Lock Screen and in the Dynamic Island:
/// Rome's mascot and a still wave, so the guardian sees it goes on with the
/// screen locked or another app in front. A tap opens Rome.
struct VoiceConversationLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceConversationActivityAttributes.self) { _ in
            HStack(spacing: 14) {
                MascotMark(ink: .white, screen: .black)
                    .frame(width: 34)
                Text("Voice conversation")
                    .font(.headline)
                    .foregroundStyle(.white)
                Spacer(minLength: 8)
                StillWave(height: 24)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { _ in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    MascotMark(ink: .white, screen: .black)
                        .frame(width: 30)
                        .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StillWave(height: 22)
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text("Voice conversation")
                        .font(.headline)
                        .foregroundStyle(.white)
                }
            } compactLeading: {
                MascotMark(ink: .white, screen: .black)
                    .frame(width: 20)
            } compactTrailing: {
                StillWave(height: 14)
            } minimal: {
                StillWave(height: 12)
            }
            .keylineTint(.white)
        }
    }
}

/// The capsule's bars standing still: a voice, not a meter.
struct StillWave: View {
    var height: CGFloat

    /// The bars' shares of the height, from the capsule's shape.
    static let shape: [CGFloat] = [0.5, 0.85, 1, 0.7, 0.9, 0.55]

    var body: some View {
        HStack(alignment: .center, spacing: height / 8) {
            ForEach(Self.shape.indices, id: \.self) { index in
                Capsule()
                    .fill(.white)
                    .frame(width: max(2, height / 7), height: height * Self.shape[index])
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}
