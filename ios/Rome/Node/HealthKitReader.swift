import HealthKit
import UIKit

/// HealthKit behind `HealthReading`. Read-only: it never asks to write, and
/// it holds no health value past the reply it builds.
final class LiveHealth: HealthReading, @unchecked Sendable {
    private let store = HKHealthStore()
    private let lock = NSLock()
    private var asked = false

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    // MARK: Types

    static let quantityIdentifiers: [String: HKQuantityTypeIdentifier] = [
        "stepCount": .stepCount, "distanceWalkingRunning": .distanceWalkingRunning, "distanceCycling": .distanceCycling,
        "flightsClimbed": .flightsClimbed, "activeEnergyBurned": .activeEnergyBurned, "basalEnergyBurned": .basalEnergyBurned,
        "appleExerciseTime": .appleExerciseTime, "appleStandTime": .appleStandTime, "heartRate": .heartRate,
        "restingHeartRate": .restingHeartRate, "walkingHeartRateAverage": .walkingHeartRateAverage,
        "heartRateVariabilitySDNN": .heartRateVariabilitySDNN, "oxygenSaturation": .oxygenSaturation,
        "respiratoryRate": .respiratoryRate, "vo2Max": .vo2Max, "bodyMass": .bodyMass, "bodyMassIndex": .bodyMassIndex,
        "bodyFatPercentage": .bodyFatPercentage, "height": .height, "bloodPressureSystolic": .bloodPressureSystolic,
        "bloodPressureDiastolic": .bloodPressureDiastolic, "bloodGlucose": .bloodGlucose, "bodyTemperature": .bodyTemperature,
        "dietaryEnergyConsumed": .dietaryEnergyConsumed, "dietaryWater": .dietaryWater,
    ]

    static let activityTypes: [String: HKWorkoutActivityType] = [
        "walking": .walking, "running": .running, "cycling": .cycling, "hiking": .hiking, "swimming": .swimming,
        "yoga": .yoga, "pilates": .pilates, "elliptical": .elliptical, "rowing": .rowing, "stairClimbing": .stairClimbing,
        "dance": .socialDance, "coreTraining": .coreTraining, "flexibility": .flexibility, "cooldown": .cooldown,
        "functionalStrengthTraining": .functionalStrengthTraining, "traditionalStrengthTraining": .traditionalStrengthTraining,
        "highIntensityIntervalTraining": .highIntensityIntervalTraining, "mixedCardio": .mixedCardio,
        "crossTraining": .crossTraining, "jumpRope": .jumpRope, "kickboxing": .kickboxing, "boxing": .boxing,
        "martialArts": .martialArts, "tennis": .tennis, "badminton": .badminton, "tableTennis": .tableTennis,
        "basketball": .basketball, "soccer": .soccer, "golf": .golf, "skiing": .downhillSkiing, "snowboarding": .snowboarding,
        "skating": .skatingSports, "surfing": .surfingSports, "climbing": .climbing, "other": .other,
    ]

    private static func activityName(_ type: HKWorkoutActivityType) -> String {
        if type == .cardioDance { return "dance" }
        return activityTypes.first { $0.value == type }?.key ?? "other"
    }

    static func quantityType(_ type: HealthType) -> HKQuantityType? {
        quantityIdentifiers[type.name].map { HKQuantityType($0) }
    }

    private static func sampleType(_ type: HealthType) -> HKSampleType? {
        switch type.kind {
        case .quantity: return quantityType(type)
        case .sleep: return HKCategoryType(.sleepAnalysis)
        case .mindful: return HKCategoryType(.mindfulSession)
        case .workouts: return HKObjectType.workoutType()
        }
    }

    /// Everything the actions read; the one access sheet asks for all of it.
    static let readTypes: Set<HKObjectType> = Set(HealthTypes.all.compactMap { sampleType($0) })

    // MARK: Access

    func requestAccess() async throws {
        guard isAvailable else { throw HealthReadError.unavailable }
        // Health's data is encrypted while the phone is locked.
        guard await MainActor.run(body: { UIApplication.shared.isProtectedDataAvailable }) else { throw HealthReadError.locked }
        if lock.withLock({ asked }) { return }
        do {
            try await store.requestAuthorization(toShare: [], read: Self.readTypes)
        } catch {
            throw Self.map(error)
        }
        lock.withLock { asked = true }
    }

    func shouldRequestAccess() async -> Bool {
        guard isAvailable else { return false }
        let status = try? await store.statusForAuthorizationRequest(toShare: [], read: Self.readTypes)
        return status == .shouldRequest
    }

    static func map(_ error: Error) -> Error {
        if let error = error as? HKError {
            switch error.code {
            case .errorDatabaseInaccessible: return HealthReadError.locked
            case .errorHealthDataUnavailable: return HealthReadError.unavailable
            default: break
            }
        }
        return error
    }

    // MARK: Reading

    func quantityStats(_ request: QuantityRequest) async throws -> [Double?] {
        guard let type = Self.quantityType(request.type), let first = request.buckets.first else { throw HealthReadError.unavailable }
        let unit = HKUnit(from: request.unit.hk)
        let options: HKStatisticsOptions
        switch request.aggregate {
        case .sum: options = .cumulativeSum
        case .avg: options = .discreteAverage
        case .min: options = .discreteMin
        case .max: options = .discreteMax
        case .latest: options = .mostRecent
        }
        // The whole window is one bucket as long as it: HealthKit then cuts
        // samples at its edges the way it does between days.
        var components = DateComponents()
        if let component = request.interval.component {
            components.setValue(1, for: component)
        } else {
            components.second = max(1, Int(request.window.duration.rounded(.up)))
        }
        let predicate = HKQuery.predicateForSamples(withStart: request.window.start, end: request.window.end, options: [])
        do {
            return try await withCheckedThrowingContinuation { continuation in
                let query = HKStatisticsCollectionQuery(
                    quantityType: type, quantitySamplePredicate: predicate, options: options,
                    anchorDate: first.start, intervalComponents: components
                )
                query.initialResultsHandler = { _, collection, error in
                    if let error {
                        // Nothing to read is no value, not a failure.
                        if (error as? HKError)?.code == .errorNoData {
                            continuation.resume(returning: request.buckets.map { _ in nil })
                        } else {
                            continuation.resume(throwing: error)
                        }
                        return
                    }
                    continuation.resume(returning: request.buckets.map { bucket in
                        let statistics = collection?.statistics(for: bucket.start)
                        let quantity: HKQuantity?
                        switch request.aggregate {
                        case .sum: quantity = statistics?.sumQuantity()
                        case .avg: quantity = statistics?.averageQuantity()
                        case .min: quantity = statistics?.minimumQuantity()
                        case .max: quantity = statistics?.maximumQuantity()
                        case .latest: quantity = statistics?.mostRecentQuantity()
                        }
                        return quantity.map { $0.doubleValue(for: unit) * request.unit.scale }
                    })
                }
                store.execute(query)
            }
        } catch {
            throw Self.map(error)
        }
    }

    func segments(_ type: HealthType, in window: DateInterval) async throws -> [HealthSegment] {
        guard let sampleType = Self.sampleType(type) else { throw HealthReadError.unavailable }
        let predicate = HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: [])
        let found = try await fetch(sampleType, predicate: predicate, limit: nil, ascending: true)
        return found.compactMap { sample in
            guard let category = sample as? HKCategorySample else { return nil }
            return HealthSegment(
                start: sample.startDate, end: sample.endDate,
                stage: type.kind == .sleep ? Self.stage(category.value) : nil
            )
        }
    }

    func workouts(in window: DateInterval, activity: String?) async throws -> [WorkoutRecord] {
        var predicates = [HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: [])]
        if let activity, let type = Self.activityTypes[activity] {
            predicates.append(HKQuery.predicateForWorkouts(with: type))
        }
        let found = try await fetch(HKObjectType.workoutType(), predicate: NSCompoundPredicate(andPredicateWithSubpredicates: predicates), limit: nil, ascending: true)
        return found.compactMap { ($0 as? HKWorkout).map(Self.record) }
    }

    func samples(_ request: SampleRequest) async throws -> [HealthSample] {
        guard let sampleType = Self.sampleType(request.type) else { throw HealthReadError.unavailable }
        var predicates = [HKQuery.predicateForSamples(withStart: request.window.start, end: request.window.end, options: [])]
        if let bound = request.startBound {
            // To the millisecond, both ways: the cursor's own start is included.
            let date = Date(timeIntervalSince1970: Double(bound) / 1000)
            predicates.append(request.ascending
                ? HKQuery.predicateForSamples(withStart: date.addingTimeInterval(-0.001), end: nil, options: .strictStartDate)
                : HKQuery.predicateForSamples(withStart: nil, end: date.addingTimeInterval(0.001), options: .strictStartDate))
        }
        if !request.sources.isEmpty {
            let sources = try await self.sources(for: sampleType, matching: request.sources)
            guard !sources.isEmpty else { return [] }
            predicates.append(HKQuery.predicateForObjects(from: sources))
        }
        if let activity = request.activity, let type = Self.activityTypes[activity] {
            predicates.append(HKQuery.predicateForWorkouts(with: type))
        }
        let found = try await fetch(sampleType, predicate: NSCompoundPredicate(andPredicateWithSubpredicates: predicates), limit: request.limit, ascending: request.ascending)
        let unit = request.type.units.first
        return found.compactMap { sample in
            let source = sample.sourceRevision.source
            var result = HealthSample(
                id: sample.uuid.uuidString, start: sample.startDate, end: sample.endDate,
                source: HealthSource(name: source.name, bundleId: source.bundleIdentifier)
            )
            if let quantity = sample as? HKQuantitySample, let unit {
                result.value = quantity.quantity.doubleValue(for: HKUnit(from: unit.hk)) * unit.scale
            } else if let category = sample as? HKCategorySample {
                result.category = request.type.kind == .sleep ? Self.stage(category.value).rawValue : "session"
            } else if let workout = sample as? HKWorkout {
                result.workout = Self.record(workout)
            } else {
                return nil
            }
            if let device = sample.device {
                result.device = [
                    "name": device.name, "model": device.model, "manufacturer": device.manufacturer,
                ].compactMapValues { $0 }
            }
            if request.includeMetadata, let metadata = sample.metadata {
                result.metadata = metadata.compactMapValues(Self.json)
            }
            return result
        }
    }

    // MARK: Queries

    private func fetch(_ type: HKSampleType, predicate: NSPredicate, limit: Int?, ascending: Bool) async throws -> [HKSample] {
        let order: SortOrder = ascending ? .forward : .reverse
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.sample(type: type, predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate, order: order), SortDescriptor(\.endDate, order: order)],
            limit: limit
        )
        do {
            return try await descriptor.result(for: store)
        } catch {
            throw Self.map(error)
        }
    }

    /// The sources of a type whose app name or bundle id is one of `names`.
    private func sources(for type: HKSampleType, matching names: Set<String>) async throws -> Set<HKSource> {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                let query = HKSourceQuery(sampleType: type, samplePredicate: nil) { _, sources, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: (sources ?? []).filter { names.contains($0.name) || names.contains($0.bundleIdentifier) })
                    }
                }
                store.execute(query)
            }
        } catch {
            throw Self.map(error)
        }
    }

    // MARK: Mapping

    private static func stage(_ value: Int) -> SleepStage {
        switch HKCategoryValueSleepAnalysis(rawValue: value) {
        case .inBed: return .inBed
        case .awake: return .awake
        case .asleepCore: return .core
        case .asleepDeep: return .deep
        case .asleepREM: return .rem
        default: return .unspecified
        }
    }

    private static func record(_ workout: HKWorkout) -> WorkoutRecord {
        func sum(_ identifier: HKQuantityTypeIdentifier, _ unit: HKUnit) -> Double? {
            workout.statistics(for: HKQuantityType(identifier))?.sumQuantity()?.doubleValue(for: unit)
        }
        // Distance only from the types a caller may read, so a type that was refused never leaks through a workout.
        let distances = [sum(.distanceWalkingRunning, .meter()), sum(.distanceCycling, .meter())].compactMap { $0 }
        return WorkoutRecord(
            start: workout.startDate, end: workout.endDate, activity: activityName(workout.workoutActivityType),
            durationMinutes: workout.duration / 60,
            activeEnergyKcal: sum(.activeEnergyBurned, .kilocalorie()),
            distanceMeters: distances.isEmpty ? nil : distances.reduce(0, +)
        )
    }

    private static func json(_ value: Any) -> JSONValue? {
        switch value {
        case let text as String: return .string(text)
        case let date as Date: return .string(RomeDate.string(date))
        case let quantity as HKQuantity: return .string(quantity.description)
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        default: return nil
        }
    }
}
