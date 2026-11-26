// Shared by the app and its widget: a voice conversation shown on the Lock
// Screen and in the Dynamic Island while it runs. It only says that one runs:
// it holds no words and does not follow the voice. Live Activities are iPhone
// and iPad only, never Mac Catalyst.
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit

struct VoiceConversationActivityAttributes: ActivityAttributes {
    /// Nothing changes while it shows.
    struct ContentState: Codable, Hashable {}
}
#endif
