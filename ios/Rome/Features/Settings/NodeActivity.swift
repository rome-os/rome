import Foundation

// What the audit log says, in words: one row per request, grouped by day.
// A row names what was read, over which window, and how it went. It never
// shows an action id, the raw args, or a value.

struct NodeActivityRow: Identifiable, Equatable {
    let id: Int
    let title: String
    let detail: String
    let failed: Bool
    /// The time of day the request came.
    let time: String
}

struct NodeActivityDay: Identifiable, Equatable {
    let id: Date
    let title: String
    let rows: [NodeActivityRow]
}

struct NodeActivityFormatter {
    /// Words come from the capability an action belongs to.
    var registry: NodeCapabilityRegistry
    var now: Date = Date()
    var calendar: Calendar = .current
    var locale: Locale = .current

    // MARK: Days

    /// `entries` are newest first, and stay so.
    func days(_ entries: [NodeAuditEntry]) -> [NodeActivityDay] {
        var days: [NodeActivityDay] = []
        for entry in entries {
            let day = calendar.startOfDay(for: entry.time)
            let row = row(entry)
            if let last = days.last, last.id == day {
                days[days.count - 1] = NodeActivityDay(id: day, title: last.title, rows: last.rows + [row])
            } else {
                days.append(NodeActivityDay(id: day, title: dayText(day), rows: [row]))
            }
        }
        return days
    }

    func row(_ entry: NodeAuditEntry) -> NodeActivityRow {
        let capability = registry.capability(for: entry.action)
        let known = capability?.activityTitle(entry)
        let title = known ?? String(localized: "Unsupported request")
        var parts: [String] = []
        var failed = false
        switch entry.outcome {
        case .error where known == nil:
            // The action's name says it all, in the plain color.
            parts = [entry.action]
        case .error:
            failed = true
            parts = [failureText(entry.errorCode)]
        case .interrupted, nil:
            parts = [capability?.activityDetail(entry, formatter: self) ?? "", String(localized: "Interrupted")].filter { !$0.isEmpty }
        case .ok:
            parts = [capability?.activityDetail(entry, formatter: self) ?? entry.count.map { String(localized: "\($0) records") } ?? String(localized: "Done")]
        }
        return NodeActivityRow(
            id: entry.seq, title: title, detail: parts.joined(separator: " · "), failed: failed,
            time: entry.time.formatted(timeStyle)
        )
    }

    // MARK: Words

    /// A short line for each way a request can fail.
    func failureText(_ code: String?) -> String {
        switch code {
        case "invalid_args": return String(localized: "Invalid request")
        case "unsupported_type": return String(localized: "Not a supported type")
        case "unsupported_action": return String(localized: "Not supported")
        case "health_off": return String(localized: "Apple Health is off")
        case "health_no_permission": return String(localized: "No access to Health")
        case "device_off": return String(localized: "Device status is off")
        case "health_unavailable": return String(localized: "Health isn't available")
        case "health_locked": return String(localized: "Health unavailable while locked")
        case "audit_unavailable": return String(localized: "Couldn't record activity")
        case "health_failed": return String(localized: "Couldn't read Health")
        case let code? where code.hasSuffix("_off"): return String(localized: "Turned off")
        case let code? where code.hasSuffix("_no_permission"): return String(localized: "No access")
        default: return String(localized: "Something went wrong")
        }
    }

    static func typeName(_ type: String) -> String {
        switch type {
        case "stepCount": return String(localized: "Steps")
        case "distanceWalkingRunning": return String(localized: "Walking + running distance")
        case "distanceCycling": return String(localized: "Cycling distance")
        case "flightsClimbed": return String(localized: "Flights climbed")
        case "activeEnergyBurned": return String(localized: "Active energy")
        case "basalEnergyBurned": return String(localized: "Resting energy")
        case "appleExerciseTime": return String(localized: "Exercise minutes")
        case "appleStandTime": return String(localized: "Stand time")
        case "heartRate": return String(localized: "Heart rate")
        case "restingHeartRate": return String(localized: "Resting heart rate")
        case "walkingHeartRateAverage": return String(localized: "Walking heart rate")
        case "heartRateVariabilitySDNN": return String(localized: "Heart rate variability")
        case "oxygenSaturation": return String(localized: "Blood oxygen")
        case "respiratoryRate": return String(localized: "Respiratory rate")
        case "vo2Max": return String(localized: "VO₂ max")
        case "bodyMass": return String(localized: "Weight")
        case "bodyMassIndex": return String(localized: "BMI")
        case "bodyFatPercentage": return String(localized: "Body fat")
        case "height": return String(localized: "Height")
        case "bloodPressureSystolic": return String(localized: "Systolic blood pressure")
        case "bloodPressureDiastolic": return String(localized: "Diastolic blood pressure")
        case "bloodGlucose": return String(localized: "Blood glucose")
        case "bodyTemperature": return String(localized: "Body temperature")
        case "dietaryEnergyConsumed": return String(localized: "Dietary energy")
        case "dietaryWater": return String(localized: "Water")
        case "sleep", "sleepAnalysis": return String(localized: "Sleep")
        case "mindfulSession": return String(localized: "Mindful minutes")
        case "workouts", "workout": return String(localized: "Workouts")
        default: return type
        }
    }

    // MARK: Windows

    /// The window the request read: the reply's own when the log has it,
    /// else worked out from the args the way the action does.
    func window(_ entry: NodeAuditEntry, _ args: JSONValue?) -> String {
        var start = entry.windowStart
        var end = entry.windowEnd
        if start == nil || end == nil {
            let endText = args?["end"]?.string
            let givenEnd = endText.flatMap { HealthDates.parse($0, endOfDay: true, calendar: calendar) }
            end = givenEnd ?? entry.time
            start = args?["start"]?.string.flatMap { HealthDates.parse($0, endOfDay: false, calendar: calendar) }
                ?? calendar.startOfDay(for: givenEnd.map { $0.addingTimeInterval(-1) } ?? entry.time)
        }
        guard let start, let end else { return "" }
        return windowText(start: start, end: end, requestedAt: entry.time)
    }

    func windowText(start: Date, end: Date, requestedAt: Date) -> String {
        guard calendar.startOfDay(for: start) == start else { return dateTimeRange(start, end) }
        // From a midnight to a midnight: whole days.
        if calendar.startOfDay(for: end) == end {
            let last = calendar.date(byAdding: .day, value: -1, to: end) ?? end
            return last <= start ? dayText(start) : "\(dayText(start)) – \(dayText(last))"
        }
        // From a midnight to the moment of the request: up to that day.
        if abs(end.timeIntervalSince(requestedAt)) < 120 {
            return calendar.isDate(start, inSameDayAs: end) ? dayText(start) : "\(dayText(start)) – \(dayText(end))"
        }
        return dateTimeRange(start, end)
    }

    private func dateTimeRange(_ start: Date, _ end: Date) -> String {
        "\(dateTime(start)) – \(dateTime(end))"
    }

    /// "Nov 8, 6 PM" or "Nov 8, 6:30 PM": shorter than the system's "Nov 8 at 6:00 PM",
    /// so a window and its count fit one line.
    private func dateTime(_ date: Date) -> String {
        let onTheHour = calendar.component(.minute, from: date) == 0 && calendar.component(.second, from: date) == 0
        return "\(date.formatted(dateStyle(date))), \(date.formatted(onTheHour ? base().hour() : timeStyle))"
    }

    /// "Today", "Yesterday", or a date.
    func dayText(_ date: Date) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return String(localized: "Today") }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return String(localized: "Yesterday")
        }
        return date.formatted(dateStyle(date))
    }

    // MARK: Formats

    private func base() -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    }

    private func dateStyle(_ date: Date) -> Date.FormatStyle {
        let style = base().month(.abbreviated).day()
        return calendar.isDate(date, equalTo: now, toGranularity: .year) ? style : style.year()
    }

    private var timeStyle: Date.FormatStyle { base().hour().minute() }
}
