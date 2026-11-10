import SwiftUI

/// A routine Chat proposed, read-only: its name, when it runs, what it does,
/// and whether it is on. Turning it on, pausing or deleting it stays on the
/// dashboard, which the card links to.
struct RoutineDraftCardView: View {
    let part: MessagePart.RoutineDraftPart
    /// Nil when the routines could not be read; the line is left out.
    let status: RoutineStatus?
    /// A visitor cannot turn a routine on, so gets no link to.
    var canTurnOn = true
    /// The chat the card is in: an unsaved proposal is turned on from its card there.
    var sessionId: String? = nil

    @Environment(AppModel.self) private var model
    @Environment(\.openInstancePage) private var openInstancePage

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: RoutineCardText.symbol(part.trigger))
                    .romeFont(17, .medium)
                    .foregroundStyle(Palette.primaryText)
                    .frame(width: 36, height: 36)
                    .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: RoutineCardText.kind(part.trigger))
                        .romeFont(12, .semibold)
                        .foregroundStyle(Palette.sub)
                    Text(verbatim: part.name)
                        .romeFont(17, .semibold)
                        .tracking(-0.4)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if let status {
                    Text(verbatim: RoutineCardText.status(status))
                        .romeFont(13, .medium)
                        .foregroundStyle(Palette.sub)
                }
            }
            VStack(spacing: 0) {
                ForEach(Array(RoutineCardText.rows(part).enumerated()), id: \.offset) { index, row in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(verbatim: row.label)
                            .romeFont(13)
                            .foregroundStyle(Palette.sub)
                            .frame(width: 64, alignment: .leading)
                        Text(verbatim: row.value)
                            .romeFont(15, .medium)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 10)
                    .overlay(alignment: .top) {
                        if index > 0 { Rectangle().fill(Palette.hair).frame(height: 0.5) }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 2)
            .background(Palette.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            if canTurnOn, let origin = model.webURL {
                Button {
                    openInstancePage(RoutineCardText.destination(status, origin: origin, sessionId: sessionId, mainChatServerID: model.workspace?.mainChatServerID))
                } label: {
                    HStack(spacing: 4) {
                        Text(verbatim: RoutineCardText.link(status))
                        Image(systemName: "chevron.right").romeFont(12, .semibold)
                    }
                    .romeFont(15, .medium)
                    .foregroundStyle(Palette.primaryText)
                }
                .buttonStyle(PressScaleStyle())
            }
        }
        .padding(16)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
        .accessibilityElement(children: .contain)
    }
}

/// The words on a routine card, kept apart from the view so tests read them.
enum RoutineCardText {
    struct Row: Hashable {
        let label: String
        let value: String
    }

    static func kind(_ trigger: MessagePart.RoutineDraftPart.Trigger) -> String {
        switch trigger {
        case .schedule: return String(localized: "Scheduled routine")
        case .event: return String(localized: "Event routine")
        case .manual: return String(localized: "Manual routine")
        }
    }

    static func symbol(_ trigger: MessagePart.RoutineDraftPart.Trigger) -> String {
        switch trigger {
        case .schedule: return "calendar.badge.clock"
        case .event: return "bell"
        case .manual: return "play"
        }
    }

    /// When it runs, what narrows it, and what it does, as the dashboard's card lists them.
    static func rows(_ part: MessagePart.RoutineDraftPart) -> [Row] {
        var rows: [Row] = []
        let when = part.trigger == .manual && part.watchLabel.isEmpty ? String(localized: "When you run it") : part.watchLabel
        if !when.isEmpty {
            rows.append(Row(label: part.trigger == .event ? String(localized: "Watches") : String(localized: "Runs"), value: when))
        }
        if let filter = part.filterSummary {
            rows.append(Row(label: String(localized: "Only when"), value: filter))
        }
        if !part.thenSummary.isEmpty {
            rows.append(Row(label: String(localized: "Then"), value: part.thenSummary))
        }
        return rows
    }

    static func status(_ status: RoutineStatus) -> String {
        switch status {
        case .notOn: return String(localized: "Not on")
        case .on: return String(localized: "On")
        case .paused: return String(localized: "Paused")
        }
    }

    /// The link's words: turning it on while no routine was made from the
    /// card (or its state is unknown), else the routine on the dashboard.
    static func link(_ status: RoutineStatus?) -> String {
        status?.routineId == nil ? String(localized: "Turn it on on the web") : String(localized: "Open in Routines")
    }

    /// Where the link goes. Only the card itself turns an unsaved proposal
    /// on, so that opens the card's chat on the dashboard; a routine made
    /// from it opens its own page.
    static func destination(_ status: RoutineStatus?, origin: URL, sessionId: String?, mainChatServerID: String?) -> URL {
        if let routineId = status?.routineId { return InstancePages.routines(origin: origin, routineId: routineId) }
        return InstancePages.chat(origin: origin, sessionId: sessionId, mainChatServerID: mainChatServerID)
    }
}
