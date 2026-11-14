import HealthKit

/// HealthKit wakes the app when a type changes: one `HKObserverQuery` per type,
/// with background delivery. They are set up at launch, because iOS launches
/// the app in the background to deliver, and the app must be listening by
/// the time `didFinishLaunching` returns.
protocol HealthObserving: Sendable {
    /// `onChange` runs a sync and calls its completion when the sync is over.
    func start(onChange: @escaping @Sendable (_ done: @escaping @Sendable () -> Void) -> Void)
    func stop()
}

final class HealthObservers: HealthObserving, @unchecked Sendable {
    private let store = HKHealthStore()
    private let lock = NSLock()
    private var queries: [HKObserverQuery] = []

    /// How often iOS may wake the app for a type: hourly for steps, energy,
    /// distance, heart rate, exercise and stand; at once for workouts; daily
    /// for sleep, body readings and the rest.
    static func frequency(_ type: HealthSyncType) -> HKUpdateFrequency {
        switch type.name {
        case "workouts": return .immediate
        case "stepCount", "distanceWalkingRunning", "distanceCycling", "flightsClimbed", "activeEnergyBurned",
             "basalEnergyBurned", "appleExerciseTime", "appleStandTime", "heartRate":
            return .hourly
        default: return .daily
        }
    }

    func start(onChange: @escaping @Sendable (_ done: @escaping @Sendable () -> Void) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        stopQueries()
        var started: [HKObserverQuery] = []
        for type in HealthSyncPlan.all {
            guard let sampleType = LiveHealth.sampleType(type.type) else { continue }
            let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { _, completion, error in
                // The completion is always called, even on failure, or
                // HealthKit backs off and stops waking the app.
                guard error == nil else {
                    completion()
                    return
                }
                onChange { completion() }
            }
            store.execute(query)
            started.append(query)
            store.enableBackgroundDelivery(for: sampleType, frequency: Self.frequency(type)) { _, _ in }
        }
        lock.withLock { queries = started }
    }

    /// Stops listening, and iOS no longer wakes the app for Health.
    func stop() {
        stopQueries()
        guard HKHealthStore.isHealthDataAvailable() else { return }
        store.disableAllBackgroundDelivery { _, _ in }
    }

    private func stopQueries() {
        let held = lock.withLock { () -> [HKObserverQuery] in
            defer { queries = [] }
            return queries
        }
        for query in held { store.stop(query) }
    }
}
