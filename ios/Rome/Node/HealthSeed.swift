#if DEBUG
import HealthKit

/// Test data for the Simulator, whose Health starts empty: a week of steps,
/// heart rate, sleep with overlapping records, and three runs. Debug builds
/// only, and only with the launch argument `-RomeSeedHealth`. It is the one
/// place the app asks to write to Health, which is why `NSHealthUpdateUsageDescription`
/// is only in `Config/Info-Debug.plist`; Release has no write permission.
enum HealthSeed {
    static var requested: Bool { ProcessInfo.processInfo.arguments.contains("-RomeSeedHealth") }
    private static let doneKey = "healthSeeded"

    static func run() async {
        guard HKHealthStore.isHealthDataAvailable(), !UserDefaults.standard.bool(forKey: doneKey) else { return }
        let store = HKHealthStore()
        let steps = HKQuantityType(.stepCount), heart = HKQuantityType(.heartRate), resting = HKQuantityType(.restingHeartRate)
        let energy = HKQuantityType(.activeEnergyBurned), distance = HKQuantityType(.distanceWalkingRunning)
        let sleep = HKCategoryType(.sleepAnalysis)
        let write: Set<HKSampleType> = [steps, heart, resting, energy, distance, sleep, HKObjectType.workoutType()]
        // One sheet for writing the test data and for the app's own reading.
        do { try await store.requestAuthorization(toShare: write, read: LiveHealth.readTypes) } catch { return }

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        func at(_ day: Int, _ hour: Double) -> Date {
            calendar.date(byAdding: .minute, value: Int(hour * 60), to: calendar.date(byAdding: .day, value: -day, to: today)!)!
        }
        func quantity(_ type: HKQuantityType, _ unit: HKUnit, _ value: Double, _ start: Date, _ end: Date) -> HKQuantitySample {
            HKQuantitySample(type: type, quantity: HKQuantity(unit: unit, doubleValue: value), start: start, end: end)
        }
        func stage(_ value: HKCategoryValueSleepAnalysis, _ start: Date, _ end: Date) -> HKCategorySample {
            HKCategorySample(type: sleep, value: value.rawValue, start: start, end: end)
        }

        var samples: [HKSample] = []
        let now = Date()
        for day in 0..<7 {
            for hour in 8..<20 where at(day, Double(hour) + 1) <= now {
                samples.append(quantity(steps, .count(), Double(300 + (day * 97 + hour * 53) % 600), at(day, Double(hour)), at(day, Double(hour) + 1)))
                samples.append(quantity(energy, .kilocalorie(), Double(20 + (hour * 7 + day) % 40), at(day, Double(hour)), at(day, Double(hour) + 1)))
                samples.append(quantity(distance, .meter(), Double(200 + (hour * 31 + day * 17) % 400), at(day, Double(hour)), at(day, Double(hour) + 1)))
            }
            for half in 16..<44 where at(day, Double(half) / 2) <= now {
                samples.append(quantity(heart, HKUnit.count().unitDivided(by: .minute()), Double(62 + (half * 5 + day * 3) % 45), at(day, Double(half) / 2), at(day, Double(half) / 2)))
            }
            if at(day, 7) <= now {
                samples.append(quantity(resting, HKUnit.count().unitDivided(by: .minute()), Double(56 + day % 5), at(day, 7), at(day, 7)))
            }
            // The night before this day, 23:00 to 07:00, with an overlapping record
            // from a second "source" that merging must not count twice.
            guard at(day, 7) <= now else { continue }
            samples += [
                stage(.inBed, at(day + 1, 23), at(day, 7)),
                stage(.asleepCore, at(day + 1, 23.33), at(day, 1)),
                stage(.asleepDeep, at(day, 1), at(day, 2)),
                stage(.asleepREM, at(day, 2), at(day, 3)),
                stage(.asleepCore, at(day, 3), at(day, 5.5)),
                stage(.asleepREM, at(day, 5.5), at(day, 6.5)),
                stage(.awake, at(day, 6.5), at(day, 6.67)),
                stage(.asleepUnspecified, at(day + 1, 23.5), at(day, 5)),
            ]
        }
        do { try await store.save(samples) } catch { return }

        // Three runs, each with its energy and distance.
        for day in [1, 3, 5] {
            let start = at(day, 7.5), end = at(day, 8.17)
            let configuration = HKWorkoutConfiguration()
            configuration.activityType = .running
            let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: nil)
            do {
                try await builder.beginCollection(at: start)
                try await builder.addSamples([
                    quantity(energy, .kilocalorie(), 320, start, end),
                    quantity(distance, .meter(), 5200, start, end),
                ])
                try await builder.endCollection(at: end)
                _ = try await builder.finishWorkout()
            } catch {
                return
            }
        }
        UserDefaults.standard.set(true, forKey: doneKey)
    }
}
#endif
