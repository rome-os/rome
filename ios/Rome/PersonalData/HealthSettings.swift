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

/// The Rome Health would sync to: the one open now.
struct HealthInstance: Equatable, Sendable {
    let id: String
    let name: String
    /// A visitor has no personal data to send to someone else's Rome.
    let isVisitor: Bool
}

/// Where one Rome's sync keeps its anchors and its history.
struct HealthStores: Sendable {
    let log: SyncLogging
    let progress: ProgressStoring

    /// Application Support/personal-data/<instance>/, one folder per Rome.
    static var root: URL { URL.applicationSupportDirectory.appending(path: "personal-data") }

    static func files(for instanceId: String) -> HealthStores {
        let safe = instanceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_."))) ?? instanceId
        let folder = root.appending(path: safe)
        return HealthStores(
            log: SyncLog(url: folder.appending(path: "sync-history.jsonl")),
            progress: AnchorStore(url: folder.appending(path: "\(HealthSettings.sourceId)-progress.json"))
        )
    }

    static func removeAllFiles() {
        try? FileManager.default.removeItem(at: root)
    }
}

/// One Rome's sync: its engine, anchors and history. Only the open Rome's
/// lane runs; another Rome's waits, untouched, until it is open again.
final class HealthLane: Sendable {
    let instanceId: String
    let engine: SyncEngine
    let source: AppleHealthSource
    let log: SyncLogging
    let switches: SyncSwitchBox

    init(instanceId: String, engine: SyncEngine, source: AppleHealthSource, log: SyncLogging, switches: SyncSwitchBox) {
        self.instanceId = instanceId
        self.engine = engine
        self.source = source
        self.log = log
        self.switches = switches
    }
}

/// Apple Health's Sync with Rome, per Rome: each Rome has its own switch
/// (off until turned on there), anchors, history and Delete, and only the
/// Rome open now syncs. The same switch decides whether that Rome may read
/// Health live through iPhone use (`HealthCapability` reads `flag`).
@MainActor
@Observable
final class HealthSettings {
    enum Defaults {
        static func enabled(_ instance: String) -> String { "personalData.health.enabled.\(instance)" }
        static func paused(_ instance: String) -> String { "personalData.health.paused.\(instance)" }
        /// Set once when the old "Allow Rome to read Health" was on, so the
        /// page says sync is new; gone once sync is turned on.
        static let migrationNote = "personalData.health.migrationNote"
        static let lastSignInNotice = "personalData.health.lastSignInNotice"
        /// Every key of this account starts so.
        static let prefix = "personalData.health."
        /// The switch before sync, under iPhone use: read once, then removed.
        static let oldSwitch = "nodeHealthEnabled"
    }

    nonisolated static let originKey = "personalData.originId"
    nonisolated static let sourceId = "apple_health"

    /// The Rome open now; nil before one opens or after sign-out.
    private(set) var instance: HealthInstance?
    private(set) var isEnabled = false
    private(set) var isPaused = false
    /// "Health now syncs to your Rome. Turn on Sync to keep using it."
    private(set) var showsMigrationNote: Bool
    private(set) var activity = SyncActivity()
    /// The open Rome's syncs, newest first, at most 30 days.
    private(set) var history: [SyncLogEntry] = []
    /// Background App Refresh is off for the app.
    private(set) var backgroundRefreshOff = false

    /// The switch can be turned on: a Rome the guardian owns is open.
    var canSync: Bool { instance.map { !$0.isVisitor } ?? false }

    var status: HealthSyncStatus {
        HealthSyncStatus.make(
            enabled: isEnabled, paused: isPaused, activity: activity, newest: history.first(where: { $0.outcome != .deleted }),
            lastGood: history.first { [.ok, .partial, .interrupted].contains($0.outcome) }
        )
    }

    /// Read by the live `health.*` actions on the executor's threads.
    @ObservationIgnored let flag = NodeFlag()
    @ObservationIgnored let reader: HealthReading
    @ObservationIgnored private let sync: HealthSyncReading
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let stores: @Sendable (String) -> HealthStores
    @ObservationIgnored private let removeAllStores: @Sendable () -> Void
    @ObservationIgnored private let observers: HealthObserving
    @ObservationIgnored private let target: @Sendable (String) async -> PersonalDataTarget?
    @ObservationIgnored private let originStore: OriginStore
    @ObservationIgnored private let device: DeviceKind
    @ObservationIgnored private let notifies: Bool
    @ObservationIgnored private let protectedData: @Sendable () async -> Bool
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let pause: @Sendable (TimeInterval) async throws -> Void
    /// The open Rome's sync; nil without one, or for a visitor.
    @ObservationIgnored private(set) var lane: HealthLane?
    /// A tapped "sign in again" notification opens Sync history.
    @ObservationIgnored var onOpenHistory: (() -> Void)?

    /// `target`: where an instance's batches go, by its id; nil unless that
    /// instance is the one open, so another Rome never receives anything.
    init(
        reader: HealthReading = LiveHealth(),
        sync: HealthSyncReading = LiveHealthSync(),
        observers: HealthObserving = HealthObservers(),
        stores: @escaping @Sendable (String) -> HealthStores = HealthStores.files(for:),
        removeAllStores: @escaping @Sendable () -> Void = HealthStores.removeAllFiles,
        originStore: OriginStore = .keychain,
        defaults: UserDefaults = .standard,
        device: DeviceKind = .current,
        notifies: Bool = true,
        protectedData: (@Sendable () async -> Bool)? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        pause: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        instance: HealthInstance? = nil,
        target: @escaping @Sendable (String) async -> PersonalDataTarget?
    ) {
        self.reader = reader
        self.sync = sync
        self.observers = observers
        self.stores = stores
        self.removeAllStores = removeAllStores
        self.defaults = defaults
        self.originStore = originStore
        self.device = device
        self.notifies = notifies
        self.target = target
        self.protectedData = protectedData ?? { await MainActor.run { UIApplication.shared.isProtectedDataAvailable } }
        self.now = now
        self.pause = pause
        // The old switch covered "read when your Rome asks", not "upload
        // history": sync starts off for everyone, with one line saying so.
        if defaults.object(forKey: Defaults.oldSwitch) as? Bool == true {
            defaults.set(true, forKey: Defaults.migrationNote)
        }
        defaults.removeObject(forKey: Defaults.oldSwitch)
        showsMigrationNote = defaults.bool(forKey: Defaults.migrationNote)
        open(instance)
    }

    // MARK: The open Rome

    /// Another Rome opened, or none is. Its own switch, anchors and history
    /// take over; the last Rome's sync stops where it is and goes on from
    /// there the next time that Rome is open.
    func select(_ instance: HealthInstance?) {
        guard instance != self.instance else { return }
        if let instance, instance.id == self.instance?.id, instance.isVisitor == self.instance?.isVisitor {
            self.instance = instance
            return
        }
        if let old = lane { Task { await old.engine.quiesce() } }
        open(instance)
        Task { await reloadHistory() }
    }

    private func open(_ instance: HealthInstance?) {
        self.instance = instance
        history = []
        activity = SyncActivity()
        guard let instance, !instance.isVisitor else {
            lane = nil
            isEnabled = false
            isPaused = false
            flag.set(false)
            observers.stop()
            return
        }
        isEnabled = defaults.bool(forKey: Defaults.enabled(instance.id))
        isPaused = defaults.bool(forKey: Defaults.paused(instance.id))
        if isEnabled { showsMigrationNote = false }
        flag.set(isEnabled)
        lane = makeLane(instance.id, enabled: isEnabled, paused: isPaused)
        if isEnabled { startObservers() } else { observers.stop() }
    }

    private func makeLane(_ instanceId: String, enabled: Bool, paused: Bool) -> HealthLane {
        let stores = stores(instanceId)
        let source = AppleHealthSource(reader: sync, store: stores.progress)
        let switches = SyncSwitchBox(enabled: enabled, paused: paused)
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let deviceName = device.name
        let originStore = originStore
        let target = target
        let engine = SyncEngine(
            source: source,
            // Only this Rome, and only while it is the one open.
            target: { await target(instanceId).flatMap { $0.instanceId == instanceId ? $0 : nil } },
            log: stores.log,
            origin: { originStore.id().map { .init(id: $0, name: deviceName, platform: "ios", appVersion: appVersion) } },
            switches: { switches.value },
            protectedData: protectedData,
            now: now, pause: pause,
            onActivity: { [weak self] activity in await self?.setActivity(activity, from: instanceId) },
            onLogged: { [weak self] entry in await self?.logged(entry, from: instanceId) }
        )
        return HealthLane(instanceId: instanceId, engine: engine, source: source, log: stores.log, switches: switches)
    }

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
        guard isEnabled, !isPaused, let engine = lane?.engine else { return }
        run { await engine.sync(.foreground) }
    }

    /// A Rome opened: a foreground catch-up, since one asked at launch may
    /// have found no Rome yet. After the session ran out, or on a Rome that
    /// was updated, sync goes on from the saved anchors at once.
    func instanceOpened() {
        guard isEnabled, !isPaused, let engine = lane?.engine else { return }
        let stuck = [.needsSignIn, .needsUpdate].contains(status)
        run {
            if stuck { await engine.signedIn() }
            await engine.sync(stuck ? .manual : .foreground)
        }
    }

    /// A sync the app starts in front keeps going for the half minute iOS
    /// grants after the guardian leaves, so a week of history in progress
    /// is usually finished and kept.
    @discardableResult
    private func run(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            let hold = BackgroundHold("health-sync")
            await work()
            hold.end()
        }
    }

    // MARK: Switches

    /// Sync with Rome, for the open Rome. On asks iOS for access if it never
    /// has, then starts the backfill. Off stops the observers and tells the
    /// Rome, which keeps what it has until Delete. The task is the whole of
    /// it, for tests.
    @discardableResult
    func setEnabled(_ on: Bool) -> Task<Void, Never> {
        guard let lane, let id = instance?.id else { return Task {} }
        isEnabled = on
        defaults.set(on, forKey: Defaults.enabled(id))
        flag.set(on)
        lane.switches.set(enabled: on, paused: on ? false : isPaused)
        if on {
            isPaused = false
            defaults.removeObject(forKey: Defaults.paused(id))
            showsMigrationNote = false
            defaults.removeObject(forKey: Defaults.migrationNote)
        }
        let engine = lane.engine
        let reader = reader
        if on {
            return run {
                if await reader.shouldRequestAccess() { try? await reader.requestAccess() }
                self.startObservers()
                await engine.signedIn()
                await engine.sync(.backfill)
            }
        }
        observers.stop()
        return Task {
            // A sync under way stops before its next read or batch.
            await engine.quiesce()
            await self.tellRome("off", lane: lane)
        }
    }

    /// Pause: observers keep running, but nothing is read or sent. Resume
    /// catches up.
    @discardableResult
    func setPaused(_ paused: Bool) -> Task<Void, Never> {
        guard let lane, let id = instance?.id else { return Task {} }
        isPaused = paused
        defaults.set(paused, forKey: Defaults.paused(id))
        lane.switches.set(enabled: isEnabled, paused: paused)
        let engine = lane.engine
        return run {
            if paused { await engine.quiesce() }
            await self.tellRome(paused ? "paused" : "active", lane: lane)
            if !paused { await engine.sync(.manual) }
        }
    }

    /// Sync now: not throttled, and it waits for a sync under way.
    @discardableResult
    func syncNow() -> Task<Void, Never> {
        guard let engine = lane?.engine else { return Task {} }
        return run { await engine.sync(.manual) }
    }

    /// Delete uploaded data: everything this phone sent goes from the open
    /// Rome, its anchors go, and its sync turns off. Other Romes keep theirs.
    /// False when the Rome could not be reached, and nothing changed.
    func deleteUploaded() async -> Bool {
        guard let lane, let id = instance?.id, let target = await target(id), target.instanceId == id, let origin = originStore.id() else { return false }
        // Nothing may reach the Rome after the delete: a sync under way stops
        // first, and the engine is idle before the request goes.
        let before = lane.switches.value
        lane.switches.set(enabled: false, paused: before.paused)
        await lane.engine.quiesce()
        do {
            _ = try await target.backend.deleteOrigin(source: Self.sourceId, origin: origin)
        } catch {
            lane.switches.set(enabled: before.enabled, paused: before.paused)
            return false
        }
        await lane.source.reset()
        let entry = await lane.log.append(SyncLogEntry(seq: 0, time: Date(), trigger: .manual, outcome: .deleted))
        guard self.lane === lane else { return true }
        observers.stop()
        isEnabled = false
        defaults.set(false, forKey: Defaults.enabled(id))
        flag.set(false)
        lane.switches.set(enabled: false, paused: false)
        isPaused = false
        defaults.removeObject(forKey: Defaults.paused(id))
        logged(entry, from: id)
        return true
    }

    /// Sign-out: observers off, background delivery off, every Rome's
    /// anchors and history and the origin id gone, every switch off. The
    /// Romes keep what they have: only Delete uploaded data removes it.
    @discardableResult
    func forgetAccount() -> Task<Void, Never> {
        observers.stop()
        let old = lane
        lane = nil
        instance = nil
        isEnabled = false
        isPaused = false
        showsMigrationNote = false
        flag.set(false)
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Defaults.prefix) { defaults.removeObject(forKey: key) }
        originStore.remove()
        history = []
        activity = SyncActivity()
        let removeAllStores = removeAllStores
        return Task {
            if let old { await old.engine.quiesce() }
            removeAllStores()
        }
    }

    // MARK: Reading

    func reloadHistory() async {
        #if DEBUG
        if isDemo { return }
        #endif
        guard let lane else { return }
        let entries = await lane.log.recent(limit: 500)
        guard self.lane === lane else { return }
        history = entries
    }

    // MARK: Engine

    private func startObservers() {
        observers.start { done in
            Task { @MainActor [weak self] in
                // The Rome open when HealthKit wakes the app, if its switch is on.
                guard let self, let engine = self.lane?.engine, self.isEnabled else {
                    done()
                    return
                }
                let hold = BackgroundHold("health-sync")
                let background = UIApplication.shared.applicationState == .background
                await engine.sync(.observer, budget: background ? SyncEngine.backgroundBudget : nil)
                hold.end()
                done()
            }
        }
    }

    private func tellRome(_ state: String, lane: HealthLane) async {
        guard let target = await target(lane.instanceId), target.instanceId == lane.instanceId, let origin = originStore.id() else { return }
        try? await target.backend.setState(source: Self.sourceId, origin: origin, state: state)
    }

    private func setActivity(_ activity: SyncActivity, from instanceId: String) {
        guard lane?.instanceId == instanceId else { return }
        self.activity = activity
    }

    private func logged(_ entry: SyncLogEntry, from instanceId: String) {
        guard lane?.instanceId == instanceId else { return }
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
    /// Demo data for the snapshot runner: a sync history and a status.
    @ObservationIgnored private var isDemo = false

    func showDemo(_ entries: [SyncLogEntry], enabled: Bool = true, activity: SyncActivity = SyncActivity()) {
        isDemo = true
        if instance == nil { instance = HealthInstance(id: "demo", name: "My Rome", isVisitor: false) }
        isEnabled = enabled
        flag.set(enabled)
        isPaused = false
        showsMigrationNote = false
        history = entries
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
