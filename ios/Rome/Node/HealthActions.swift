import Foundation
import os

// The phone's Apple Health actions for rome-node: `health.stats` (aggregates)
// and `health.samples` (raw records). Read-only. This file is the whole
// contract: argument parsing, defaults, validation and the JSON replies, over
// a `HealthReading` that HealthKit (HealthKitReader.swift) or a test fills in.

// MARK: - Types

enum HealthKind: Equatable, Sendable {
    /// A number per sample. Cumulative types add up (steps), discrete ones
    /// are averaged, bounded or read at their latest (heart rate).
    case quantity(cumulative: Bool)
    /// Stages of sleep, merged so no minute counts twice.
    case sleep
    /// Time spent in mindful sessions, merged the same way.
    case mindful
    case workouts
}

/// A unit a caller may ask for. `hk` is HealthKit's name for it; `scale`
/// turns HealthKit's value into this unit's (a percent is a fraction there).
struct HealthUnit: Equatable, Sendable {
    let name: String
    let hk: String
    var scale: Double = 1
}

struct HealthType: Equatable, Sendable {
    let name: String
    let kind: HealthKind
    /// The first is the default.
    let units: [HealthUnit]

    var isQuantity: Bool {
        if case .quantity = kind { return true }
        return false
    }

    var isCumulative: Bool { kind == .quantity(cumulative: true) }
}

enum HealthTypes {
    private static let count = [HealthUnit(name: "count", hk: "count")]
    private static let perMinute = [HealthUnit(name: "count/min", hk: "count/min")]
    private static let length = [("m", "m"), ("km", "km"), ("mi", "mi"), ("ft", "ft")].map { HealthUnit(name: $0.0, hk: $0.1) }
    private static let height = [("m", "m"), ("cm", "cm"), ("ft", "ft"), ("in", "in")].map { HealthUnit(name: $0.0, hk: $0.1) }
    private static let energy = [("kcal", "kcal"), ("kJ", "kJ")].map { HealthUnit(name: $0.0, hk: $0.1) }
    private static let time = [("min", "min"), ("s", "s"), ("h", "hr")].map { HealthUnit(name: $0.0, hk: $0.1) }
    private static let mass = [("kg", "kg"), ("g", "g"), ("lb", "lb")].map { HealthUnit(name: $0.0, hk: $0.1) }
    private static let percent = [HealthUnit(name: "%", hk: "%", scale: 100)]
    private static let volume = [("mL", "mL"), ("L", "L"), ("fl_oz_us", "fl_oz_us")].map { HealthUnit(name: $0.0, hk: $0.1) }

    private static func sum(_ name: String, _ units: [HealthUnit]) -> HealthType {
        HealthType(name: name, kind: .quantity(cumulative: true), units: units)
    }

    private static func level(_ name: String, _ units: [HealthUnit]) -> HealthType {
        HealthType(name: name, kind: .quantity(cumulative: false), units: units)
    }

    /// The allow-list, in the order `system.info` names it.
    static let all: [HealthType] = [
        sum("stepCount", count),
        sum("distanceWalkingRunning", length),
        sum("distanceCycling", length),
        sum("flightsClimbed", count),
        sum("activeEnergyBurned", energy),
        sum("basalEnergyBurned", energy),
        sum("appleExerciseTime", time),
        sum("appleStandTime", time),
        level("heartRate", perMinute),
        level("restingHeartRate", perMinute),
        level("walkingHeartRateAverage", perMinute),
        level("heartRateVariabilitySDNN", [HealthUnit(name: "ms", hk: "ms")]),
        level("oxygenSaturation", percent),
        level("respiratoryRate", perMinute),
        level("vo2Max", [HealthUnit(name: "ml/(kg*min)", hk: "ml/(kg*min)")]),
        level("bodyMass", mass),
        level("bodyMassIndex", count),
        level("bodyFatPercentage", percent),
        level("height", height),
        level("bloodPressureSystolic", [HealthUnit(name: "mmHg", hk: "mmHg")]),
        level("bloodPressureDiastolic", [HealthUnit(name: "mmHg", hk: "mmHg")]),
        level("bloodGlucose", [HealthUnit(name: "mg/dL", hk: "mg/dL")]),
        level("bodyTemperature", [HealthUnit(name: "degC", hk: "degC"), HealthUnit(name: "degF", hk: "degF")]),
        sum("dietaryEnergyConsumed", energy),
        sum("dietaryWater", volume),
        HealthType(name: "sleep", kind: .sleep, units: []),
        HealthType(name: "mindfulSession", kind: .mindful, units: []),
        HealthType(name: "workouts", kind: .workouts, units: []),
    ]

    private static let aliases = ["sleepAnalysis": "sleep", "workout": "workouts"]

    static func named(_ name: String) -> HealthType? {
        let name = aliases[name] ?? name
        return all.first { $0.name == name }
    }
}

/// Workout kinds a caller may filter by, by name. HealthKit's own list is
/// longer; anything else reads as `other`.
enum WorkoutActivities {
    static let names = [
        "walking", "running", "cycling", "hiking", "swimming", "yoga", "pilates", "elliptical", "rowing",
        "stairClimbing", "dance", "coreTraining", "flexibility", "cooldown", "functionalStrengthTraining",
        "traditionalStrengthTraining", "highIntensityIntervalTraining", "mixedCardio", "crossTraining",
        "jumpRope", "kickboxing", "boxing", "martialArts", "tennis", "badminton", "tableTennis", "basketball",
        "soccer", "golf", "skiing", "snowboarding", "skating", "surfing", "climbing", "other",
    ]
}

enum Aggregate: String, CaseIterable, Sendable {
    case sum, avg, min, max, latest
}

enum StatsInterval: String, CaseIterable, Sendable {
    case total, hour, day, week, month

    var component: Calendar.Component? {
        switch self {
        case .total: return nil
        case .hour: return .hour
        case .day: return .day
        case .week: return .weekOfYear
        case .month: return .month
        }
    }
}

/// One slice of the window. `aligned` is the calendar hour, day, week or
/// month the slice belongs to (what HealthKit buckets by); `clipped` is the
/// part of it inside the window, which is what the reply reports.
struct HealthBucket: Equatable, Sendable {
    let aligned: DateInterval
    let clipped: DateInterval

    static let limit = 1000

    /// Nil when the window needs more than `limit` slices.
    static func make(window: DateInterval, interval: StatsInterval, calendar: Calendar) -> [HealthBucket]? {
        guard let component = interval.component else { return [HealthBucket(aligned: window, clipped: window)] }
        guard var cursor = calendar.dateInterval(of: component, for: window.start)?.start else { return nil }
        var buckets: [HealthBucket] = []
        while cursor < window.end {
            guard let next = calendar.date(byAdding: component, value: 1, to: cursor), next > cursor else { return nil }
            buckets.append(HealthBucket(
                aligned: DateInterval(start: cursor, end: next),
                clipped: DateInterval(start: max(cursor, window.start), end: min(next, window.end))
            ))
            if buckets.count > limit { return nil }
            cursor = next
        }
        return buckets
    }
}

// MARK: - Reading

enum SleepStage: String, CaseIterable, Sendable {
    case inBed, awake, core, deep, rem, unspecified
}

/// A stretch of sleep or mindfulness; `stage` is nil for a mindful session.
struct HealthSegment: Equatable, Sendable {
    let start: Date
    let end: Date
    var stage: SleepStage?
}

struct WorkoutRecord: Equatable, Sendable {
    let start: Date
    let end: Date
    let activity: String
    let durationMinutes: Double
    var activeEnergyKcal: Double?
    var distanceMeters: Double?
}

struct HealthSource: Equatable, Sendable {
    let name: String
    let bundleId: String
}

struct HealthSample: Equatable, Sendable {
    let id: String
    let start: Date
    let end: Date
    /// A quantity, in the type's default unit.
    var value: Double?
    /// A sleep stage, or `session` for mindfulness.
    var category: String?
    var workout: WorkoutRecord?
    let source: HealthSource
    var device: [String: String]?
    var metadata: [String: JSONValue]?
}

struct QuantityRequest: Sendable {
    let type: HealthType
    let unit: HealthUnit
    let aggregate: Aggregate
    /// Only data inside it counts.
    let window: DateInterval
    let interval: StatsInterval
    /// The `aligned` slices; one for the whole window when `interval` is total.
    let buckets: [DateInterval]
}

struct SampleRequest: Sendable {
    let type: HealthType
    let window: DateInterval
    let ascending: Bool
    /// At most this many, ordered by start.
    let limit: Int
    /// Only samples at or after (ascending) or at or before (descending) this start, in ms since 1970.
    let startBound: Int64?
    /// Source names or bundle ids; empty keeps all.
    let sources: Set<String>
    let includeMetadata: Bool
    let activity: String?
}

enum HealthReadError: Error, Equatable, Sendable {
    /// No HealthKit on this device.
    case unavailable
    /// The phone is locked: Health's data is encrypted until it is opened.
    case locked
}

protocol HealthReading: Sendable {
    var isAvailable: Bool { get }
    /// Shows the system's access sheet the first time, for every type the
    /// actions read. Returns at once afterwards, since iOS asks once per type.
    func requestAccess() async throws
    /// True while iOS has never been asked for the types the actions read, so
    /// asking now shows the system sheet.
    func shouldRequestAccess() async -> Bool
    /// One value per bucket; nil where HealthKit has nothing to read.
    func quantityStats(_ request: QuantityRequest) async throws -> [Double?]
    /// Sleep or mindful segments overlapping the window.
    func segments(_ type: HealthType, in window: DateInterval) async throws -> [HealthSegment]
    func workouts(in window: DateInterval, activity: String?) async throws -> [WorkoutRecord]
    func samples(_ request: SampleRequest) async throws -> [HealthSample]
}

// MARK: - Results

/// What an action answers: the reply's result, and how many things it held
/// (for the audit log), or why it did not run.
enum NodeActionResult: Equatable, Sendable {
    case ok(JSONValue, count: Int?)
    case failed(code: String, message: String)
}

struct ActionFailure: Error {
    let code: String
    let message: String

    static func invalid(_ message: String) -> ActionFailure { ActionFailure(code: "invalid_args", message: message) }
}

// MARK: - Actions

struct HealthActions: Sendable {
    let reader: HealthReading
    /// Apple Health's Sync with Rome. Off: the health actions are refused
    /// before Health is touched.
    var enabled = NodeFlag(true)
    var now: @Sendable () -> Date = { Date() }
    /// The phone's calendar. Only its time zone and first weekday count: the
    /// wire speaks Gregorian dates (see `HealthDates.wire`).
    var calendar: @Sendable () -> Calendar = { Calendar.current }

    static let actions = ["system.info", "health.stats", "health.samples"]

    /// The longest window `health.stats` reads sleep, mindful minutes or workouts over.
    static let maxRecordDays = 366

    private static let typeNames = HealthTypes.all.map(\.name).joined(separator: ", ")

    /// iPhone or iPad: the word in what the agent reads.
    var device = DeviceKind.iPhone

    /// What `system.info` tells the agent about each action's arguments.
    static func usage(_ device: DeviceKind = .iPhone) -> [String: String] {
        let name = device.name
        return [
            "system.info": "No arguments.",
            "health.stats": """
                Aggregates over a time window. Args: types (array) or type (string), required: \(typeNames). \
                start, end: ISO 8601 time, with or without offset (without offset = the \(name)'s time zone, e.g. 2026-11-08T18:00), or YYYY-MM-DD in the \(name)'s time zone (an end date means the end of that day); \
                default today from local midnight to now (with only end, the day that ends there). \
                interval: total (default) | hour | day | week | month, at most 1000 buckets. \
                aggregate: sum (default for cumulative types such as stepCount) | avg (default for the rest) | min | max | latest (not for cumulative types). \
                unit: e.g. km, mi, kg, lb, kcal, kJ, count/min, degF (default per type; ignored for sleep, workouts, mindfulSession). \
                activity: a workout kind such as running (workouts only). \
                sleep merges stages and sources so no minute counts twice, with minutes per stage, and is clipped to the window or bucket: \
                daily buckets split a night at midnight, so for one night use a window such as the previous day 18:00 to 12:00. \
                workouts gives count, durationMinutes, activeEnergyKcal, distanceMeters for workouts that start in the window. \
                sleep, mindfulSession and workouts read at most \(maxRecordDays) days per request. \
                A type the user has not allowed, or that has no data, has no value. \
                Apple Health is off for Rome until the user turns it on: Settings → Apple Health → Sync with Rome in the Rome app on the \(name). While it is off the request fails with health_off, and only the user can change that on the \(name). Example: {"types":["stepCount","sleep","restingHeartRate","workouts"]}
                """,
            "health.samples": """
                Raw records, newest first. Args: type (string, required; same names as health.stats), start, end (as health.stats), \
                limit 1-1000 (default 100), order desc (default) | asc by start, cursor (nextCursor of the previous reply), \
                sources (array of app names or bundle ids), includeMetadata (bool, default false), activity (workouts only). \
                A reply with nextCursor has more. Fails with health_off while Apple Health is off for Rome: the user must turn on Settings → Apple Health → Sync with Rome in the Rome app on the \(name). Example: {"type":"heartRate","start":"2026-11-08","limit":50}
                """,
        ]
    }

    static func off(_ device: DeviceKind) -> NodeActionResult {
        .failed(code: "health_off", message: "Apple Health is off for Rome on this \(device.name). The user must turn on Settings → Apple Health → Sync with Rome in the Rome app on the \(device.name).")
    }

    func run(_ action: String, args: JSONValue?) async -> NodeActionResult {
        if Self.actions.contains(action), action != "system.info", !enabled.isOn { return Self.off(device) }
        do {
            switch action {
            case "health.stats": return try await stats(args)
            case "health.samples": return try await samples(args)
            default: return .failed(code: "unsupported_action", message: "This \(device.name) does not support this action.")
            }
        } catch let failure as ActionFailure {
            return .failed(code: failure.code, message: failure.message)
        } catch let error as HealthReadError {
            switch error {
            case .unavailable: return .failed(code: "health_unavailable", message: "Health data is not available on this device.")
            case .locked: return .failed(code: "health_locked", message: "The \(device.name) is locked, so Health data cannot be read. Unlock it and try again.")
            }
        } catch is CancellationError {
            return .failed(code: "health_failed", message: "The request was cancelled.")
        } catch {
            return .failed(code: "health_failed", message: "Health could not be read.")
        }
    }

    // MARK: Arguments

    private func object(_ args: JSONValue?, allowed: [String]) throws -> [String: JSONValue] {
        let object: [String: JSONValue]
        switch args {
        case nil, .null?: object = [:]
        case .object(let value)?: object = value
        default: throw ActionFailure.invalid("args must be an object.")
        }
        if let unknown = object.keys.sorted().first(where: { !allowed.contains($0) }) {
            throw ActionFailure.invalid("Unknown argument \"\(unknown)\". Allowed: \(allowed.joined(separator: ", ")).")
        }
        return object
    }

    private func string(_ value: JSONValue?, _ name: String) throws -> String? {
        guard let value, value != .null else { return nil }
        guard let text = value.string, !text.isEmpty else { throw ActionFailure.invalid("\(name) must be a non-empty string.") }
        return text
    }

    private func healthType(named name: String) throws -> HealthType {
        guard let type = HealthTypes.named(name) else {
            throw ActionFailure(code: "unsupported_type", message: "\"\(name)\" is not a supported type. Supported: \(Self.typeNames).")
        }
        return type
    }

    /// The window: ISO instants or dates in the phone's time zone; by default today so far.
    func windowArgs(_ fields: [String: JSONValue], calendar: Calendar) throws -> DateInterval {
        let now = self.now()
        let end: Date
        if let text = try string(fields["end"], "end") {
            guard let date = HealthDates.parse(text, endOfDay: true, calendar: calendar) else {
                throw ActionFailure.invalid("end must be an ISO 8601 time (with or without offset) or a YYYY-MM-DD date.")
            }
            end = date
        } else {
            end = now
        }
        let start: Date
        if let text = try string(fields["start"], "start") {
            guard let date = HealthDates.parse(text, endOfDay: false, calendar: calendar) else {
                throw ActionFailure.invalid("start must be an ISO 8601 time (with or without offset) or a YYYY-MM-DD date.")
            }
            start = date
        } else {
            // Today from midnight; with only an end, the day that ends there.
            start = calendar.startOfDay(for: fields["end"] == nil ? now : end.addingTimeInterval(-1))
        }
        guard start < end else { throw ActionFailure.invalid("start must be before end.") }
        return DateInterval(start: start, end: end)
    }

    private func activityArg(_ value: JSONValue?) throws -> String? {
        guard let name = try string(value, "activity") else { return nil }
        guard WorkoutActivities.names.contains(name) else {
            throw ActionFailure.invalid("Unknown activity \"\(name)\". Use one of: \(WorkoutActivities.names.joined(separator: ", ")).")
        }
        return name
    }

    // MARK: health.stats

    private struct StatsItem {
        let type: HealthType
        let unit: HealthUnit?
        let aggregate: Aggregate
    }

    private func statsItems(_ fields: [String: JSONValue]) throws -> [StatsItem] {
        var names: [String]
        switch (fields["types"], fields["type"]) {
        case (.some, .some): throw ActionFailure.invalid("Send types or type, not both.")
        case (.array(let list)?, nil):
            names = try list.map {
                guard let name = $0.string, !name.isEmpty else { throw ActionFailure.invalid("types must be an array of strings.") }
                return name
            }
        case (nil, .string(let name)?): names = [name]
        case (nil, nil): throw ActionFailure.invalid("types is required.")
        default: throw ActionFailure.invalid("types must be an array of strings; type a string.")
        }
        guard !names.isEmpty else { throw ActionFailure.invalid("types must not be empty.") }
        var seen: Set<String> = []
        names = names.filter { seen.insert($0).inserted }
        let types = try names.map(healthType(named:))
        let unitName = try string(fields["unit"], "unit")
        var aggregate: Aggregate?
        if let name = try string(fields["aggregate"], "aggregate") {
            guard let value = Aggregate(rawValue: name) else {
                throw ActionFailure.invalid("aggregate must be one of: \(Aggregate.allCases.map(\.rawValue).joined(separator: ", ")).")
            }
            aggregate = value
        }
        return try types.map { type in
            guard type.isQuantity else { return StatsItem(type: type, unit: nil, aggregate: .sum) }
            var unit = type.units[0]
            if let unitName {
                guard let match = type.units.first(where: { $0.name == unitName }) else {
                    throw ActionFailure.invalid("Unit \"\(unitName)\" does not fit \(type.name). Use one of: \(type.units.map(\.name).joined(separator: ", ")).")
                }
                unit = match
            }
            let chosen = aggregate ?? (type.isCumulative ? .sum : .avg)
            if type.isCumulative, chosen != .sum {
                throw ActionFailure.invalid("\(type.name) adds up: aggregate must be sum.")
            }
            if !type.isCumulative, chosen == .sum {
                throw ActionFailure.invalid("\(type.name) does not add up: aggregate must be avg, min, max or latest.")
            }
            return StatsItem(type: type, unit: unit, aggregate: chosen)
        }
    }

    private func stats(_ args: JSONValue?) async throws -> NodeActionResult {
        let calendar = HealthDates.wire(self.calendar())
        let fields = try object(args, allowed: ["types", "type", "start", "end", "interval", "aggregate", "unit", "activity"])
        let items = try statsItems(fields)
        let window = try windowArgs(fields, calendar: calendar)
        var interval = StatsInterval.total
        if let name = try string(fields["interval"], "interval") {
            guard let value = StatsInterval(rawValue: name) else {
                throw ActionFailure.invalid("interval must be one of: \(StatsInterval.allCases.map(\.rawValue).joined(separator: ", ")).")
            }
            interval = value
        }
        let activity = try activityArg(fields["activity"])
        if activity != nil, !items.contains(where: { $0.type.kind == .workouts }) {
            throw ActionFailure.invalid("activity applies to workouts only.")
        }
        guard let buckets = HealthBucket.make(window: window, interval: interval, calendar: calendar) else {
            throw ActionFailure.invalid("That window needs more than \(HealthBucket.limit) \(interval.rawValue) buckets. Use a larger interval or a shorter window.")
        }
        // Sleep, mindful minutes and workouts are read record by record, not
        // summed by HealthKit: one request reads a bounded window of them.
        if items.contains(where: { !$0.type.isQuantity }),
           let longest = calendar.date(byAdding: .day, value: Self.maxRecordDays, to: window.start), window.end > longest {
            throw ActionFailure.invalid(
                "sleep, mindfulSession and workouts read at most \(Self.maxRecordDays) days per request. Use a shorter window, or one request per year."
            )
        }
        guard reader.isAvailable else { throw HealthReadError.unavailable }
        try await reader.requestAccess()

        var results: [JSONValue] = []
        for item in items {
            let perBucket = try await values(for: item, window: window, interval: interval, buckets: buckets, activity: activity)
            var result: [String: JSONValue] = ["type": .string(item.type.name)]
            switch item.type.kind {
            case .quantity:
                result["unit"] = .string(item.unit?.name ?? "")
                result["aggregate"] = .string(item.aggregate.rawValue)
            case .sleep, .mindful:
                result["unit"] = .string("min")
                result["aggregate"] = .string("sum")
            case .workouts:
                result["unit"] = .string("count")
            }
            if interval == .total {
                result.merge(perBucket[0]) { _, new in new }
            } else {
                result["buckets"] = .array(zip(buckets, perBucket).map { bucket, fields in
                    var entry = fields
                    entry["startISO"] = .string(HealthDates.iso(bucket.clipped.start, calendar))
                    entry["endISO"] = .string(HealthDates.iso(bucket.clipped.end, calendar))
                    return .object(entry)
                })
            }
            results.append(.object(result))
        }
        var reply = Self.envelope(window: window, calendar: calendar)
        reply["interval"] = .string(interval.rawValue)
        reply["results"] = .array(results)
        return .ok(.object(reply), count: results.count)
    }

    /// The fields of each bucket's value: `value`, and for sleep and workouts what goes with it.
    private func values(for item: StatsItem, window: DateInterval, interval: StatsInterval, buckets: [HealthBucket], activity: String?) async throws -> [[String: JSONValue]] {
        switch item.type.kind {
        case .quantity:
            guard let unit = item.unit else { return [] }
            let values = try await reader.quantityStats(QuantityRequest(
                type: item.type, unit: unit, aggregate: item.aggregate, window: window, interval: interval, buckets: buckets.map(\.aligned)
            ))
            return buckets.indices.map { index in
                guard index < values.count, let value = values[index] else { return [:] }
                return ["value": Self.number(value)]
            }
        case .sleep:
            let segments = try await reader.segments(item.type, in: window)
            return buckets.map { bucket in
                let sleep = SleepMath.summarize(segments, in: bucket.clipped)
                var fields: [String: JSONValue] = [:]
                if sleep.asleepMinutes > 0 { fields["value"] = Self.number(sleep.asleepMinutes) }
                let stages = sleep.stages.filter { $0.value > 0 }
                if !stages.isEmpty {
                    fields["stages"] = .object(Dictionary(uniqueKeysWithValues: stages.map { ($0.key.rawValue, Self.number($0.value)) }))
                }
                return fields
            }
        case .mindful:
            let segments = try await reader.segments(item.type, in: window)
            return buckets.map { bucket in
                let minutes = SleepMath.unionMinutes(segments.compactMap { segment -> (Date, Date)? in
                    let start = max(segment.start, bucket.clipped.start), end = min(segment.end, bucket.clipped.end)
                    return end > start ? (start, end) : nil
                })
                return minutes > 0 ? ["value": Self.number(minutes)] : [:]
            }
        case .workouts:
            let records = try await reader.workouts(in: window, activity: activity)
            return buckets.map { bucket in
                // A workout belongs to the bucket it starts in.
                let inside = records.filter { $0.start >= bucket.clipped.start && $0.start < bucket.clipped.end }
                var fields: [String: JSONValue] = ["value": .number(Double(inside.count)), "count": .number(Double(inside.count))]
                guard !inside.isEmpty else { return fields }
                fields["durationMinutes"] = Self.number(inside.reduce(0) { $0 + $1.durationMinutes })
                let energy = inside.compactMap(\.activeEnergyKcal)
                if !energy.isEmpty { fields["activeEnergyKcal"] = Self.number(energy.reduce(0, +)) }
                let distance = inside.compactMap(\.distanceMeters)
                if !distance.isEmpty { fields["distanceMeters"] = Self.number(distance.reduce(0, +)) }
                return fields
            }
        }
    }

    // MARK: health.samples

    private func samples(_ args: JSONValue?) async throws -> NodeActionResult {
        let calendar = HealthDates.wire(self.calendar())
        let fields = try object(args, allowed: ["type", "start", "end", "limit", "order", "cursor", "sources", "includeMetadata", "activity"])
        guard let name = try string(fields["type"], "type") else { throw ActionFailure.invalid("type is required.") }
        let type = try healthType(named: name)
        var limit = 100
        if let value = fields["limit"], value != .null {
            guard let number = value.number, number == number.rounded(), (1...1000).contains(number) else {
                throw ActionFailure.invalid("limit must be a whole number from 1 to 1000.")
            }
            limit = Int(number)
        }
        var ascending = false
        if let order = try string(fields["order"], "order") {
            guard order == "asc" || order == "desc" else { throw ActionFailure.invalid("order must be asc or desc.") }
            ascending = order == "asc"
        }
        var sources: Set<String> = []
        if let value = fields["sources"], value != .null {
            guard let list = value.array else { throw ActionFailure.invalid("sources must be an array of strings.") }
            for item in list {
                guard let source = item.string, !source.isEmpty else { throw ActionFailure.invalid("sources must be an array of strings.") }
                sources.insert(source)
            }
        }
        var includeMetadata = false
        if let value = fields["includeMetadata"], value != .null {
            guard let flag = value.bool else { throw ActionFailure.invalid("includeMetadata must be true or false.") }
            includeMetadata = flag
        }
        let activity = try activityArg(fields["activity"])
        if activity != nil, type.kind != .workouts { throw ActionFailure.invalid("activity applies to workouts only.") }
        // A cursor belongs to the arguments as given (an omitted end is "now",
        // which differs on every call), and carries the window the first page
        // resolved, so later pages read the same window.
        let startArg = try string(fields["start"], "start")
        let endArg = try string(fields["end"], "end")
        let fingerprint = SampleCursor.fingerprint(type: type, start: startArg, end: endArg, ascending: ascending, sources: sources, activity: activity)
        var cursor: SampleCursor?
        let window: DateInterval
        if let text = try string(fields["cursor"], "cursor") {
            guard let decoded = SampleCursor(text), decoded.query == fingerprint else {
                throw ActionFailure.invalid("cursor does not belong to this query. Use the nextCursor of a reply to the same arguments.")
            }
            cursor = decoded
            window = decoded.window
        } else {
            // To the millisecond, as the cursor keeps it.
            let resolved = try windowArgs(fields, calendar: calendar)
            window = SampleCursor.rounded(resolved)
        }
        guard reader.isAvailable else { throw HealthReadError.unavailable }
        try await reader.requestAccess()

        let skip = cursor?.skip ?? 0
        let fetched = try await reader.samples(SampleRequest(
            type: type, window: window, ascending: ascending, limit: limit + skip + 1, startBound: cursor?.startMs,
            sources: sources, includeMetadata: includeMetadata, activity: activity
        ))
        var items = fetched.filter { sample in
            if let bound = cursor?.startMs {
                let start = SampleCursor.milliseconds(sample.start)
                if ascending ? start < bound : start > bound { return false }
            }
            return sources.isEmpty || sources.contains(sample.source.name) || sources.contains(sample.source.bundleId)
        }
        if let bound = cursor?.startMs {
            var dropped = 0
            items = items.filter { sample in
                guard dropped < skip, SampleCursor.milliseconds(sample.start) == bound else { return true }
                dropped += 1
                return false
            }
        }
        let page = Array(items.prefix(limit))
        var reply = Self.envelope(window: window, calendar: calendar)
        reply["type"] = .string(type.name)
        if let unit = type.units.first { reply["unit"] = .string(unit.name) }
        reply["samples"] = .array(page.map { sampleJSON($0, calendar: calendar) })
        if items.count > limit, let last = page.last {
            let lastMs = SampleCursor.milliseconds(last.start)
            let tied = page.reversed().prefix { SampleCursor.milliseconds($0.start) == lastMs }.count
            // All of this page started with the cursor's own instant: its skipped records still precede it.
            let next = SampleCursor(
                query: fingerprint, window: window, startMs: lastMs,
                skip: tied == page.count && lastMs == cursor?.startMs ? skip + tied : tied
            )
            reply["nextCursor"] = .string(next.encoded)
        }
        return .ok(.object(reply), count: page.count)
    }

    private func sampleJSON(_ sample: HealthSample, calendar: Calendar) -> JSONValue {
        var fields: [String: JSONValue] = [
            "id": .string(sample.id),
            "startISO": .string(HealthDates.iso(sample.start, calendar)),
            "endISO": .string(HealthDates.iso(sample.end, calendar)),
            "source": .object(["name": .string(sample.source.name), "bundleId": .string(sample.source.bundleId)]),
        ]
        if let value = sample.value { fields["value"] = Self.number(value) }
        if let category = sample.category { fields["category"] = .string(category) }
        if let workout = sample.workout {
            var info: [String: JSONValue] = ["activity": .string(workout.activity), "durationMinutes": Self.number(workout.durationMinutes)]
            if let energy = workout.activeEnergyKcal { info["activeEnergyKcal"] = Self.number(energy) }
            if let distance = workout.distanceMeters { info["distanceMeters"] = Self.number(distance) }
            fields["workout"] = .object(info)
        }
        if let device = sample.device, !device.isEmpty { fields["device"] = .object(device.mapValues(JSONValue.string)) }
        if let metadata = sample.metadata, !metadata.isEmpty { fields["metadata"] = .object(metadata) }
        return .object(fields)
    }

    // MARK: Reply pieces

    private static func envelope(window: DateInterval, calendar: Calendar) -> [String: JSONValue] {
        [
            "startISO": .string(HealthDates.iso(window.start, calendar)),
            "endISO": .string(HealthDates.iso(window.end, calendar)),
            "timeZoneIdentifier": .string(calendar.timeZone.identifier),
        ]
    }

    /// Three decimals: HealthKit's doubles carry noise past that.
    static func number(_ value: Double) -> JSONValue {
        .number((value * 1000).rounded() / 1000)
    }
}

// MARK: - Dates

enum HealthDates {
    /// The calendar the wire uses: Gregorian in the phone's time zone, with the
    /// phone's first weekday for week buckets. A phone set to the Buddhist or
    /// Japanese calendar still reads `2026-11-09` as 9 November 2026, and
    /// reports hours, days and months by the Gregorian calendar.
    static func wire(_ phone: Calendar) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = phone.timeZone
        calendar.firstWeekday = phone.firstWeekday
        calendar.minimumDaysInFirstWeek = phone.minimumDaysInFirstWeek
        return calendar
    }

    /// An ISO 8601 instant (`Z` or an offset), a date-time without offset
    /// (`YYYY-MM-DDTHH:mm`, `:ss`, fractions) or a `YYYY-MM-DD` date: the last
    /// two in the calendar's time zone. A time that happens twice when the
    /// clocks go back is its first one; one that never happens moves on.
    /// `endOfDay`: a date means the start of the next day, the end of that one.
    static func parse(_ text: String, endOfDay: Bool, calendar phone: Calendar) -> Date? {
        let calendar = wire(phone)
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        if parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
           text.allSatisfy({ $0 == "-" || $0.isASCII && $0.isNumber }),
           let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) {
            guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return nil }
            // A date that does not exist (February 30th) rolls over: refuse it.
            let back = calendar.dateComponents([.year, .month, .day], from: date)
            guard back.year == year, back.month == month, back.day == day else { return nil }
            return endOfDay ? calendar.date(byAdding: .day, value: 1, to: date) : date
        }
        if let date = localDateTime(text, calendar: calendar) { return date }
        return RomeDate.parse(text)
    }

    private static let localPattern = try! NSRegularExpression(pattern: #"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$"#)

    private static func localDateTime(_ text: String, calendar: Calendar) -> Date? {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = localPattern.firstMatch(in: text, range: range) else { return nil }
        func number(_ group: Int) -> Int? {
            guard let range = Range(match.range(at: group), in: text) else { return nil }
            return Int(text[range])
        }
        guard let year = number(1), let month = number(2), let day = number(3), let hour = number(4), let minute = number(5),
              hour < 24, minute < 60, (number(6) ?? 0) < 60
        else { return nil }
        guard let midnight = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return nil }
        let back = calendar.dateComponents([.year, .month, .day], from: midnight)
        guard back.year == year, back.month == month, back.day == day else { return nil }
        guard var date = calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: number(6) ?? 0)) else { return nil }
        if let fraction = Range(match.range(at: 7), in: text), let digits = Double("0." + text[fraction]) {
            date = date.addingTimeInterval(digits)
        }
        return date
    }

    /// An instant with the calendar's UTC offset, to the second.
    static func iso(_ date: Date, _ calendar: Calendar) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = calendar.timeZone
        return formatter.string(from: date)
    }
}

// MARK: - Paging

/// Where the next page of samples starts: after the last one sent, which may
/// share its start with the ones after it, so the cursor also counts how many
/// of those it already sent. It also holds the window the first page resolved.
struct SampleCursor: Equatable, Sendable {
    let query: String
    let windowStartMs: Int64
    let windowEndMs: Int64
    let startMs: Int64
    let skip: Int

    /// Milliseconds from year 1 to year 9999: what a date the wire can name comes to.
    static let years: ClosedRange<Int64> = -62_135_596_800_000...253_402_300_799_999

    static func milliseconds(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

    static func date(_ milliseconds: Int64) -> Date { Date(timeIntervalSince1970: Double(milliseconds) / 1000) }

    static func rounded(_ window: DateInterval) -> DateInterval {
        DateInterval(start: date(milliseconds(window.start)), end: date(milliseconds(window.end)))
    }

    /// Tells a cursor of one query from another's: the arguments as given
    /// (`start` and `end` as the caller wrote them, or nothing).
    static func fingerprint(type: HealthType, start: String?, end: String?, ascending: Bool, sources: Set<String>, activity: String?) -> String {
        "\(type.name)|\(start ?? "")|\(end ?? "")|\(ascending ? "asc" : "desc")|\(sources.sorted().joined(separator: ","))|\(activity ?? "")"
    }

    var window: DateInterval { DateInterval(start: Self.date(windowStartMs), end: Self.date(windowEndMs)) }

    init(query: String, window: DateInterval, startMs: Int64, skip: Int) {
        self.query = query
        windowStartMs = Self.milliseconds(window.start)
        windowEndMs = Self.milliseconds(window.end)
        self.startMs = startMs
        self.skip = skip
    }

    init?(_ text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        // A cursor is whatever the caller sends back: every number must be an
        // exact whole number in range, or the cursor is refused. A plain
        // `Int64(x)` traps on 1e100.
        guard let data = Data(base64Encoded: base64),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let query = value["q"]?.string,
              let start = value["t"]?.number.flatMap({ Int64(exactly: $0) }),
              let skip = value["s"]?.number.flatMap({ Int(exactly: $0) }),
              let windowStart = value["ws"]?.number.flatMap({ Int64(exactly: $0) }),
              let windowEnd = value["we"]?.number.flatMap({ Int64(exactly: $0) }),
              Self.years.contains(start), Self.years.contains(windowStart), Self.years.contains(windowEnd),
              (0..<100_000).contains(skip), windowStart < windowEnd
        else { return nil }
        self.init(
            query: query, window: DateInterval(start: Self.date(windowStart), end: Self.date(windowEnd)),
            startMs: start, skip: skip
        )
    }

    var encoded: String {
        let value = JSONValue.object([
            "q": .string(query), "t": .number(Double(startMs)), "s": .number(Double(skip)),
            "ws": .number(Double(windowStartMs)), "we": .number(Double(windowEndMs)),
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return CloudAuth.base64URL((try? encoder.encode(value)) ?? Data())
    }
}

// MARK: - Sleep

struct SleepSummary: Equatable, Sendable {
    /// Minutes in each stage; the asleep stages and awake never overlap.
    var stages: [SleepStage: Double] = [:]

    var asleepMinutes: Double {
        [SleepStage.deep, .rem, .core, .unspecified].reduce(0) { $0 + (stages[$1] ?? 0) }
    }
}

enum SleepMath {
    /// When sources disagree about the same minute, the deeper stage wins.
    private static let priority: [SleepStage] = [.deep, .rem, .core, .unspecified, .awake]

    /// Minutes per stage inside `window`. Every minute counts in at most one
    /// of the asleep stages and awake, however many sources or stages cover
    /// it. In bed is its own measure (it overlaps sleep by nature): the
    /// minutes covered by any in-bed record.
    static func summarize(_ segments: [HealthSegment], in window: DateInterval) -> SleepSummary {
        var events: [(time: Date, stage: SleepStage, delta: Int)] = []
        var inBed: [(Date, Date)] = []
        for segment in segments {
            let start = max(segment.start, window.start), end = min(segment.end, window.end)
            guard end > start, let stage = segment.stage else { continue }
            if stage == .inBed {
                inBed.append((start, end))
            } else {
                events.append((start, stage, 1))
                events.append((end, stage, -1))
            }
        }
        var summary = SleepSummary()
        var active: [SleepStage: Int] = [:]
        var previous: Date?
        for event in events.sorted(by: { $0.time < $1.time }) {
            if let previous, event.time > previous, let top = priority.first(where: { (active[$0] ?? 0) > 0 }) {
                summary.stages[top, default: 0] += event.time.timeIntervalSince(previous) / 60
            }
            active[event.stage, default: 0] += event.delta
            previous = event.time
        }
        let bed = unionMinutes(inBed)
        if bed > 0 { summary.stages[.inBed] = bed }
        return summary
    }

    /// Minutes covered by at least one of the spans.
    static func unionMinutes(_ spans: [(Date, Date)]) -> Double {
        var total: TimeInterval = 0
        var current: (Date, Date)?
        for span in spans.sorted(by: { $0.0 < $1.0 }) {
            if let held = current, span.0 <= held.1 {
                current = (held.0, max(held.1, span.1))
            } else {
                if let held = current { total += held.1.timeIntervalSince(held.0) }
                current = span
            }
        }
        if let held = current { total += held.1.timeIntervalSince(held.0) }
        return total / 60
    }
}
