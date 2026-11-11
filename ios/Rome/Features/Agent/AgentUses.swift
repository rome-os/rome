import Foundation

/// What the Agent page's Uses tab offers: starter prompts by scene. A tap
/// puts the prompt in the chat's composer, unsent. Edit the list here; each
/// string needs its Simplified Chinese in `Localizable.xcstrings`.
struct AgentUseGroup: Identifiable {
    let title: String
    let prompts: [String]

    var id: String { title }

    static var all: [AgentUseGroup] {
        [
            AgentUseGroup(title: String(localized: "Every morning"), prompts: [
                String(localized: "Every weekday at 8am, send me a short brief of today's calendar and important emails."),
                String(localized: "Every Monday morning, summarize this week's AI news for me."),
            ]),
            AgentUseGroup(title: String(localized: "Keep an eye on"), prompts: [
                String(localized: "Watch the price of this and tell me when it drops below $___: "),
                String(localized: "Check my inbox every hour and only ping me for urgent emails."),
                String(localized: "Tell me when there's news about ___."),
            ]),
            AgentUseGroup(title: String(localized: "Make an app"), prompts: [
                String(localized: "Make an app to track my workouts, with a weekly chart."),
                String(localized: "Make a small app for splitting bills with friends."),
                String(localized: "Turn what we just did into an app I can reuse."),
            ]),
            AgentUseGroup(title: String(localized: "Use my iPhone"), prompts: [
                String(localized: "How did I sleep last night?"),
                String(localized: "How many steps did I walk this week compared with last week?"),
            ]),
            AgentUseGroup(title: String(localized: "Find out"), prompts: [
                String(localized: "Compare the best noise-cancelling headphones under $300."),
                String(localized: "Plan a 3-day trip to Kyoto, day by day."),
            ]),
        ]
    }
}
