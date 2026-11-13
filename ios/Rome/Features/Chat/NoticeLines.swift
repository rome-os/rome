import SwiftUI

/// The words of a Concierge chat's faint lines.
enum NoticeCopy {
    /// "Context tidied up · conversation got long". A reason this build does
    /// not know shows as it came.
    static func renewal(_ reason: String) -> String {
        let why: String
        switch reason {
        case "context": why = String(localized: "conversation got long")
        case "setup": why = String(localized: "setup updated")
        case "idle": why = String(localized: "after a quiet period")
        case "daily": why = String(localized: "daily reset")
        case "working_dir": why = String(localized: "working folder gone")
        default: why = reason
        }
        return String(localized: "Context tidied up · \(why)")
    }
}


/// A faint centered line where the chat's agent session was renewed, with
/// why. Plain: not tappable.
struct SessionRenewalLine: View {
    let reason: String

    var body: some View {
        Text(verbatim: NoticeCopy.renewal(reason))
            .romeFont(12)
            .foregroundStyle(Palette.sub.opacity(0.75))
            .lineLimit(1)
            .frame(maxWidth: .infinity)
    }
}
