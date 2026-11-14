import Foundation
import Observation
import os
import UIKit
import UserNotifications

/// What the Health page's status line says.
enum HealthSyncStatus: Equatable, Sendable {
    case off
    case paused
    /// On, with nothing sent yet.
    case waiting
    case syncing
    /// The backfill is reading this month.
    case syncingHistory(Date)
    case synced(Date)
    case locked
    case needsSignIn
    case needsUpdate
    case failed

    /// From the switches, what the engine is doing, and the newest sync in the log.
    static func make(enabled: Bool, paused: Bool, activity: SyncActivity, newest: SyncLogEntry?, lastGood: SyncLogEntry?) -> HealthSyncStatus {
        guard enabled else { return .off }
        if paused { return .paused }
        if activity.running { return activity.historyMonth.map(HealthSyncStatus.syncingHistory) ?? .syncing }
        switch (newest?.outcome, newest?.errorCode) {
        case (.error?, "signed_out"?): return .needsSignIn
        case (.error?, "needs_update"?): return .needsUpdate
        case (.skipped?, "locked"?): return .locked
        case (.error?, _): return .failed
        default: break
        }
        return lastGood.map { .synced($0.time) } ?? .waiting
    }
}

/// Apple Health's Sync with Rome: the switch, Pause, what the sync is
/// doing, and its history. Off until the guardian turns it on. The same
/// switch decides whether Rome may read Health live through iPhone use
/// (`HealthCapability` reads `flag`).
@MainActor
@Observable
final class HealthSettings {
    enum Defaults {
        static let enabled = "personalData.health.enabled"
        static let paused = "personalData.health.paused"
        /// Set once when the old "Allow Rome to read Health" was on, so the
        /// page says sync is new; gone once sync is turned on.
        static let migrationNote = "personalData.health.migrationNote"
        static let lastSignInNotice = "personalData.health.lastSignInNotice"
        /// The switch before sync, under iPhone use: read once, then removed.
        static let oldSwitch = "nodeHealthEnabled"
    }

    nonisolated static let originKey = "personalData.originId"
    nonisolated static let sourceId = "apple_health"

    private(set) var isEnabled: Bool
    private(set) var isPaused: Bool
    /// "Health now syncs to your Rome. Turn on Sync to keep using it."
    private(set) var showsMigrationNote: Bool
    private(set) var activity = SyncActivity()
    /// Newest first, at most 30 days.
    private(set) var history: [SyncLogEntry] = []
    /// What the Rome holds from this phone, once asked.
    private(set) var stored: PersonalDataCatalogSource?
    /// Background App Refresh is off for the app.
    private(set) var backgroundRefreshOff = false

    var status: HealthSyncStatus {
        HealthSyncStatus.make(
            enabled: isEnabled, paused: isPaused, activity: activity, newest: history.first(where: { $0.outcome != .deleted }),
            lastGood: history.first { [.ok, .partial, .interrupted].contains($0.outcome) }
        )
    }

    /// Read by the live `health.*` actions on the executor's threads.
    @ObservationIgnored let flag: NodeFlag
    @ObservationIgnored let reader: HealthReading
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let log: SyncLogging
    @ObservationIgnored private let source: any PersonalDataSource
    @ObservationIgnored private let observers: HealthObserving
    @ObservationIgnored private let target: @Sendable () async -> PersonalDataTarget?
    @ObservationIgnored private let originStore: OriginStore
    @ObservationIgnored private let device: DeviceKind
    @ObservationIgnored private let notifies: Bool
    @ObservationIgnored private(set) var engine: SyncEngine!
    /// A tapped "sign in again" notification opens Sync history.
    @ObservationIgnored var onOpenHistory: (() -> Void)?

    init(
        reader: HealthReading = LiveHealth(),
        sync: HealthSyncReading = LiveHealthSync(),
        observers: HealthObserving = HealthObservers(),
        log: SyncLogging = SyncLog(),
        progress: ProgressStoring = AnchorStore(url: AnchorStore.defaultURL(source: HealthSettings.sourceId)),
        originStore: OriginStore = .keychain,
        defaults: UserDefaults = .standard,
        device: DeviceKind = .current,
        notifies: Bool = true,
        protectedData: (@Sendable () async -> Bool)? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        pause: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        target: @escaping @Sendable () async -> PersonalDataTarget?
    ) {
        self.reader = reader
        self.observers = observers
        self.log = log
        self.defaults = defaults
        self.originStore = originStore
        self.device = device
        self.notifies = notifies
        self.target = target
        // The old switch covered "read when your Rome asks", not "upload
        // history": sync starts off for everyone, with one line saying so.
        if defaults.object(forKey: Defaults.oldSwitch) as? Bool == true {
            defaults.set(true, forKey: Defaults.migrationNote)
        }
        defaults.removeObject(forKey: Defaults.oldSwitch)
        let on = defaults.object(forKey: Defaults.enabled) as? Bool ?? false
        isEnabled = on
        let paused = defaults.bool(forKey: Defaults.paused)
        isPaused = paused
        showsMigrationNote = !on && defaults.bool(forKey: Defaults.migrationNote)
        flag = NodeFlag(on)
        let source = AppleHealthSource(reader: sync, store: progress)
        self.source = source
        let enabled = SyncSwitchBox(enabled: on, paused: paused)
        switchesBox = enabled
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let deviceName = device.name
        engine = SyncEngine(
            source: source, target: target, log: log,
            origin: { originStore.id().map { .init(id: $0, name: deviceName, platform: "ios", appVersion: appVersion) } },
            switches: { enabled.value },
            protectedData: protectedData ?? { await MainActor.run { UIApplication.shared.isProtectedDataAvailable } },
            now: now, pause: pause,
            onActivity: { [weak self] activity in await self?.setActivity(activity) },
            onLogged: { [weak self] entry in await self?.logged(entry) }
        )
    }

    /// The switches as the engine's threads read them.
    @ObservationIgnored private let switchesBox: SyncSwitchBox

    // MARK: Launch and foreground

    /// At launch, before `didFinishLaunching` returns: HealthKit relaunches
    /// the app in the background to deliver, and the observers must be there.
    func launch() {
        if isEnabled { startObservers() }
        Task { await reloadHistory() }
    }

    /// The app came to the front: a catch-up, at most every 15 minutes.
    func foreground() {
        backgroundRefreshOff = UIApplication.shared.backgroundRefreshStatus == .denied
        guard isEnabled, !isPaused else { return }
        Task { await engine.sync(.foreground) }
    }

    /// A Rome opened. After the session ran out, or on a Rome that was
    /// updated, sync goes on from the saved anchors.
    func instanceOpened() {
        guard isEnabled, !isPaused, [.needsSignIn, .needsUpdate].contains(status) else { return }
        let engine = engine!
        Task {
            await engine.signedIn()
            await engine.sync(.manual)
        }
    }

    // MARK: Switches

    /// Sync with Rome. On asks iOS for access if it never has, then starts
    /// the backfill. Off stops the observers and tells the Rome, which keeps
    /// what it has until Delete. The task is the whole of it, for tests.
    @discardableResult
    func setEnabled(_ on: Bool) -> Task<Void, Never> {
        isEnabled = on
        defaults.set(on, forKey: Defaults.enabled)
        flag.set(on)
        switchesBox.set(enabled: on, paused: on ? false : isPaused)
        if on {
            isPaused = false
            defaults.removeObject(forKey: Defaults.paused)
            showsMigrationNote = false
            defaults.removeObject(forKey: Defaults.migrationNote)
        }
        let engine = engine!
        let reader = reader
        if on {
            return Task {
                if await reader.shouldRequestAccess() { try? await reader.requestAccess() }
                self.startObservers()
                await engine.signedIn()
                await engine.sync(.backfill)
            }
        }
        observers.stop()
        return Task {
            await engine.cancelRetries()
            await self.tellRome("off")
        }
    }

    /// Pause: observers keep running, but nothing is read or sent. Resume
    /// catches up.
    @discardableResult
    func setPaused(_ paused: Bool) -> Task<Void, Never> {
        isPaused = paused
        defaults.set(paused, forKey: Defaults.paused)
        switchesBox.set(enabled: isEnabled, paused: paused)
        let engine = engine!
        return Task {
            if paused { await engine.cancelRetries() }
            await self.tellRome(paused ? "paused" : "active")
            if !paused { await engine.sync(.manual) }
        }
    }

    /// Sync now: not throttled, and it waits for a sync under way.
    @discardableResult
    func syncNow() -> Task<Void, Never> {
        let engine = engine!
        return Task { await engine.sync(.manual) }
    }

    /// Delete uploaded data: everything this phone sent goes from the Rome,
    /// the anchors go, and sync turns off. False when the Rome could not be
    /// reached, and nothing changed.
    func deleteUploaded() async -> Bool {
        guard let target = await target(), let origin = originStore.id() else { return false }
        do {
            _ = try await target.backend.deleteOrigin(source: Self.sourceId, origin: origin)
        } catch {
            return false
        }
        observers.stop()
        isEnabled = false
        defaults.set(false, forKey: Defaults.enabled)
        flag.set(false)
        switchesBox.set(enabled: false, paused: false)
        isPaused = false
        defaults.removeObject(forKey: Defaults.paused)
        await engine.cancelRetries()
        await source.reset()
        stored = nil
        let entry = await log.append(SyncLogEntry(seq: 0, time: Date(), trigger: .manual, outcome: .deleted))
        await logged(entry)
        return true
    }

    /// Sign-out: observers off, background delivery off, anchors, the
    /// history and the origin id gone, sync off. The Rome keeps what it has:
    /// only Delete uploaded data removes it.
    @discardableResult
    func forgetAccount() -> Task<Void, Never> {
        observers.stop()
        isEnabled = false
        isPaused = false
        showsMigrationNote = false
        flag.set(false)
        switchesBox.set(enabled: false, paused: false)
        for key in [Defaults.enabled, Defaults.paused, Defaults.migrationNote, Defaults.lastSignInNotice] { defaults.removeObject(forKey: key) }
        originStore.remove()
        history = []
        stored = nil
        let engine = engine!
        let source = source
        let log = log
        return Task {
            await engine.cancelRetries()
            await engine.signedIn()
            await source.reset()
            await log.removeAll()
        }
    }

    // MARK: Reading

    func reloadHistory() async {
        #if DEBUG
        if isDemo { return }
        #endif
        history = await log.recent(limit: 500)
    }

    /// What the Rome holds from this phone: "since May 2026, 66k readings".
    func reloadStored() async {
        #if DEBUG
        if isDemo { return }
        #endif
        guard let target = await target(), let origin = originStore.id() else { return }
        let sources = (try? await target.backend.sources()) ?? []
        stored = sources.first { $0.source == Self.sourceId && $0.origin?.id == origin }
    }

    // MARK: Engine

    private func startObservers() {
        let engine = engine!
        observers.start { done in
            Task { @MainActor in
                let hold = BackgroundHold("health-sync")
                let background = UIApplication.shared.applicationState == .background
                await engine.sync(.observer, budget: background ? SyncEngine.backgroundBudget : nil)
                hold.end()
                done()
            }
        }
    }

    private func tellRome(_ state: String) async {
        guard let target = await target(), let origin = originStore.id() else { return }
        try? await target.backend.setState(source: Self.sourceId, origin: origin, state: state)
    }

    private func setActivity(_ activity: SyncActivity) {
        self.activity = activity
    }

    private func logged(_ entry: SyncLogEntry) {
        history.insert(entry, at: 0)
        if entry.outcome == .error, entry.errorCode == "signed_out" { noticeSignIn() }
    }

    /// One local notification at most once a day, when notifications are
    /// allowed: background sync cannot sign in on its own.
    private func noticeSignIn() {
        guard notifies, UIApplication.shared.applicationState != .active else { return }
        if let last = defaults.object(forKey: Defaults.lastSignInNotice) as? Date, Date().timeIntervalSince(last) < 86_400 { return }
        defaults.set(Date(), forKey: Defaults.lastSignInNotice)
        let content = UNMutableNotificationContent()
        content.body = String(localized: "Health stopped syncing to your Rome. Open Rome to sign in again.")
        content.userInfo = [Self.notificationKey: Self.notificationValue]
        let request = UNNotificationRequest(identifier: "rome.health.sign-in", content: content, trigger: nil)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            UNUserNotificationCenter.current().add(request)
        }
    }

    nonisolated static let notificationKey = "romeLocal"
    nonisolated static let notificationValue = "healthSync"

    nonisolated static func isSyncNotice(_ userInfo: [AnyHashable: Any]) -> Bool {
        userInfo[notificationKey] as? String == notificationValue
    }

    #if DEBUG
    /// Demo data for the snapshot runner: a sync history, a status and the Rome's catalog.
    @ObservationIgnored private var isDemo = false

    func showDemo(_ entries: [SyncLogEntry], stored: PersonalDataCatalogSource?, enabled: Bool = true, activity: SyncActivity = SyncActivity()) {
        isDemo = true
        isEnabled = enabled
        flag.set(enabled)
        isPaused = false
        showsMigrationNote = false
        history = entries
        self.stored = stored
        self.activity = activity
    }
    #endif
}

/// The switches behind a lock, for the engine's threads.
final class SyncSwitchBox: Sendable {
    private let lock: OSAllocatedUnfairLock<SyncSwitches>

    init(enabled: Bool, paused: Bool) { lock = OSAllocatedUnfairLock(initialState: SyncSwitches(enabled: enabled, paused: paused)) }

    var value: SyncSwitches { lock.withLock { $0 } }
    func set(enabled: Bool, paused: Bool) { lock.withLock { $0 = SyncSwitches(enabled: enabled, paused: paused) } }
}

/// The origin id: made once per account, kept in the Keychain, gone on sign-out.
struct OriginStore: Sendable {
    let read: @Sendable () -> String?
    let write: @Sendable (String) -> Void
    let remove: @Sendable () -> Void

    func id() -> String? {
        if let id = read() { return id }
        let id = UUID().uuidString.lowercased()
        write(id)
        return read() ?? id
    }

    static let keychain = OriginStore(
        read: { Keychain.data(for: HealthSettings.originKey).flatMap { String(data: $0, encoding: .utf8) } },
        write: { Keychain.set(Data($0.utf8), for: HealthSettings.originKey) },
        remove: { Keychain.remove(HealthSettings.originKey) }
    )

    /// In memory, for tests.
    static func memory() -> OriginStore {
        let box = OSAllocatedUnfairLock<String?>(initialState: nil)
        return OriginStore(read: { box.withLock { $0 } }, write: { id in box.withLock { $0 = id } }, remove: { box.withLock { $0 = nil } })
    }
}
