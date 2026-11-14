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


/// The words of the label under a reply the Concierge began on its own.
enum SourceCopy {
    /// The sources that label a reply: someone else made Chat speak. A
    /// check, a follow or a digest is the Concierge's own wake-up.
    static let labelled: Set<String> = ["routine", "app", "agent", "automation"]

    static func labels(_ source: TraceSummary.InputSource) -> Bool { source.type.map(labelled.contains) ?? false }

    /// "Routine · Daily summary", "Agent · Flint", or the kind alone.
    static func label(_ source: TraceSummary.InputSource) -> String {
        let kind: String
        switch source.type {
        case "routine": kind = String(localized: "Routine")
        case "app": kind = String(localized: "App")
        case "agent": kind = String(localized: "Agent")
        default: kind = String(localized: "Automation")
        }
        guard let name = source.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return kind }
        return "\(kind) · \(name)"
    }
}

/// A faint line under a Concierge reply: where its turn came from. Styled as
/// the thread label is, and not tappable.
struct SourceLabelLine: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .romeFont(12)
            .foregroundStyle(Palette.sub.opacity(0.75))
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: 260, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 6)
            .accessibilityLabel(Text(verbatim: text))
    }
}

/// "New messages" between two hairlines, above the first message that was
/// unread when the chat opened. Plain: not tappable. The transcript tells
/// the pill whether the line is above the visible rows.
struct UnreadDivider: View {

    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Palette.hair).frame(height: 1)
            Text("New messages")
                .romeFont(12, .medium)
                .foregroundStyle(Palette.sub)
                .lineLimit(1)
                .layoutPriority(1)
            Rectangle().fill(Palette.hair).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// "N new messages" at the top right of a Concierge chat's transcript, while
/// the unread line is out of sight above: a tap takes the transcript up to
/// it. It reads the unread state itself, so the transcript is not drawn
/// again when the pill comes or goes.
struct UnreadPillButton: View {
    let store: TranscriptStore

    var body: some View {
        let shown = store.unreadPill.phase == .shown && store.thread == nil
        Group {
            if shown, let unread = store.unread {
                Button {
                    store.unreadPill.tapped()
                    Task { await store.revealUnread() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.up")
                            .romeFont(12, .semibold)
                        Group {
                            if unread.more {
                                Text("\(unread.count)+ new messages")
                            } else {
                                Text("\(unread.count) new messages")
                            }
                        }
                        .romeFont(13, .semibold)
                        .lineLimit(1)
                    }
                    .foregroundStyle(Palette.fg)
                    .padding(.horizontal, 14)
                    .frame(height: 36)
                    .glassSurface(Capsule(), interactive: true, frost: Frost.composer)
                    .overlay(Capsule().strokeBorder(Palette.hair, lineWidth: 0.5))
                    .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
                    .frame(minHeight: 44)
                    .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle(scale: 0.95))
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, Metrics.pagePadding)
        .readableColumn()
        .padding(.top, 4)
        .animation(.easeOut(duration: 0.2), value: shown)
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
