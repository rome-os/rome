import HealthKit

/// HealthKit behind `HealthSyncReading`: anchored queries for what changed,
/// statistics for buckets, sample queries for records. Read-only.
final class LiveHealthSync: HealthSyncReading, @unchecked Sendable {
    private let store = HKHealthStore()

    private func sampleType(_ type: HealthSyncType) throws -> HKSampleType {
        guard HKHealthStore.isHealthDataAvailable(), let sampleType = LiveHealth.sampleType(type.type) else { throw HealthReadError.unavailable }
        return sampleType
    }

    // MARK: Anchors

    func currentAnchor(_ type: HealthSyncType, from: Date) async throws -> Data {
        // An anchored query hands out its anchor only after reading what it
        // covers, so it covers the samples from `from` on. A type iOS has not
        // decided on yet has no anchor: once it is allowed, its first delta
        // reads it from `from`.
        guard let (_, _, anchor) = try await undecidedIsEmpty({
            try await anchored(try sampleType(type), predicate: Self.from(from), anchor: nil)
        }) else { return Data() }
        return try Self.archive(anchor)
    }

    func changes(_ type: HealthSyncType, since anchor: Data, from: Date) async throws -> HealthChanges {
        guard let (added, deleted, next) = try await undecidedIsEmpty({
            try await anchored(try sampleType(type), predicate: Self.from(from), anchor: Self.unarchive(anchor))
        }) else { return HealthChanges(anchor: anchor) }
        return HealthChanges(
            added: added.compactMap { Self.record($0, type) },
            deleted: deleted.map { $0.uuid.uuidString },
            anchor: try Self.archive(next)
        )
    }

    private func anchored(_ type: HKSampleType, predicate: NSPredicate?, anchor: HKQueryAnchor?) async throws -> ([HKSample], [HKDeletedObject], HKQueryAnchor?) {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                let query = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: anchor, limit: HKObjectQueryNoLimit) { _, added, deleted, next, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: (added ?? [], deleted ?? [], next))
                    }
                }
                store.execute(query)
            }
        } catch {
            throw LiveHealth.map(error)
        }
    }

    /// A type whose read access iOS has not decided on yet reads as no data,
    /// as a denied one does (HealthKit hides denials), so one undecided type
    /// never stops the others.
    private func undecidedIsEmpty<T>(_ read: () async throws -> T) async throws -> T? {
        do {
            return try await read()
        } catch let error as HKError where error.code == .errorAuthorizationNotDetermined {
            return nil
        }
    }

    private static func from(_ date: Date) -> NSPredicate {
        HKQuery.predicateForSamples(withStart: date, end: nil, options: .strictStartDate)
    }

    static func archive(_ anchor: HKQueryAnchor?) throws -> Data {
        guard let anchor else { return Data() }
        return try NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    }

    static func unarchive(_ data: Data) -> HKQueryAnchor? {
        data.isEmpty ? nil : try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    // MARK: Buckets

    func buckets(_ type: HealthSyncType, _ resolution: BucketResolution, in window: DateInterval, calendar: Calendar) async throws -> [HealthBucketValue] {
        try await undecidedIsEmpty { try await readBuckets(type, resolution, in: window, calendar: calendar) } ?? []
    }

    private func readBuckets(_ type: HealthSyncType, _ resolution: BucketResolution, in window: DateInterval, calendar: Calendar) async throws -> [HealthBucketValue] {
        guard let quantityType = LiveHealth.quantityType(type.type), let unit = type.type.units.first else { throw HealthReadError.unavailable }
        let component: Calendar.Component = resolution == .hour ? .hour : .day
        guard let start = calendar.dateInterval(of: component, for: window.start)?.start else { return [] }
        let options: HKStatisticsOptions
        if case .bucket(cumulative: true) = type.shape { options = .cumulativeSum } else { options = [.discreteAverage, .discreteMin, .discreteMax] }
        var interval = DateComponents()
        interval.setValue(1, for: component)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: window.end, options: [])
        let hkUnit = HKUnit(from: unit.hk)
        do {
            return try await withCheckedThrowingContinuation { continuation in
                let query = HKStatisticsCollectionQuery(
                    quantityType: quantityType, quantitySamplePredicate: predicate, options: options,
                    anchorDate: start, intervalComponents: interval
                )
                query.initialResultsHandler = { _, collection, error in
                    if let error {
                        if (error as? HKError)?.code == .errorNoData { continuation.resume(returning: []) } else { continuation.resume(throwing: error) }
                        return
                    }
                    var values: [HealthBucketValue] = []
                    collection?.enumerateStatistics(from: start, to: window.end) { statistics, _ in
                        func read(_ quantity: HKQuantity?) -> Double? { quantity.map { $0.doubleValue(for: hkUnit) * unit.scale } }
                        let main = options.contains(.cumulativeSum) ? read(statistics.sumQuantity()) : read(statistics.averageQuantity())
                        guard let main else { return }
                        values.append(HealthBucketValue(
                            start: statistics.startDate, end: statistics.endDate, value: main,
                            min: read(statistics.minimumQuantity()), max: read(statistics.maximumQuantity())
                        ))
                    }
                    continuation.resume(returning: values)
                }
                store.execute(query)
            }
        } catch {
            throw LiveHealth.map(error)
        }
    }

    // MARK: Records

    func records(_ type: HealthSyncType, in window: DateInterval) async throws -> [HealthRecord] {
        try await undecidedIsEmpty { try await readRecords(type, in: window) } ?? []
    }

    private func readRecords(_ type: HealthSyncType, in window: DateInterval) async throws -> [HealthRecord] {
        let sampleType = try sampleType(type)
        let predicate = HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: .strictStartDate)
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.sample(type: sampleType, predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
            limit: nil
        )
        do {
            return try await descriptor.result(for: store).compactMap { Self.record($0, type) }
        } catch {
            throw LiveHealth.map(error)
        }
    }

    private static func record(_ sample: HKSample, _ type: HealthSyncType) -> HealthRecord? {
        var record = HealthRecord(
            id: sample.uuid.uuidString, start: sample.startDate, end: sample.endDate,
            sourceApp: sample.sourceRevision.source.name
        )
        if let quantity = sample as? HKQuantitySample, let unit = type.type.units.first {
            record.value = quantity.quantity.doubleValue(for: HKUnit(from: unit.hk)) * unit.scale
        } else if let category = sample as? HKCategorySample {
            if type.shape == .sleep { record.stage = LiveHealth.stage(category.value) }
        } else if let workout = sample as? HKWorkout {
            record.workout = LiveHealth.record(workout)
        } else {
            return nil
        }
        return record
    }
}
