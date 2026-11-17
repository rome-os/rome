import BackgroundTasks
import Foundation
import Observation
import os
import UIKit

/// Calendar's Sync with Rome, per Rome, as Apple Health's is: each
/// Rome has its own switch, progress, history and Delete, and only the Rome
/// open now syncs. Calendar has no background delivery, so it syncs when the
/// app comes to the front, after a live change, on Sync now, and from iOS's
/// background app refresh a few times a day. No push wakes it.
@MainActor
@Observable
final class CalendarSync {
    enum Defaults {
        static func enabled(_ instance: String) -> String { "personalData.calendar.sync.\(instance)" }
        static let prefix = "personalData.calendar."
    }

    nonisolated static let sourceId = "apple_calendar"
    /// The background refresh task; Info.plist lists it.
    nonisolated static var refreshTaskId: String { "\(Bundle.main.bundleIdentifier ?? "cc.romeos.mobile").calendar-sync" }
    /// How often iOS is asked to wake the app for a refresh, at the earliest.
    nonisolated static let refreshInterval: TimeInterval = 4 * 3600

    private(set) var instance: HealthInstance?
    private(set) var isEnabled = false
    private(set) var activity = SyncActivity()
    private(set) var history: [SyncLogEntry] = []
    private(set) var deleting: Set<String> = []

    var canSync: Bool { instance.map { !$0.isVisitor && !deleting.contains($0.id) } ?? false }

    var status: HealthSyncStatus {
        HealthSyncStatus.make(
            enabled: isEnabled, activity: activity, newest: history.first(where: { $0.outcome != .deleted }),
            lastGood: history.first { [.ok, .partial, .interrupted].contains($0.outcome) }
        )
    }

    @ObservationIgnored let reader: CalendarReading
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let stores: @Sendable (String) -> HealthStores
    @ObservationIgnored private let target: @Sendable (String) async -> PersonalDataTarget?
    @ObservationIgnored private let originStore: OriginStore
    @ObservationIgnored private let device: DeviceKind
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let pause: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private(set) var lane: CalendarLane?

    init(
        reader: CalendarReading = LiveCalendar(),
        stores: @escaping @Sendable (String) -> HealthStores = CalendarSync.files(for:),
        originStore: OriginStore = .keychain,
        defaults: UserDefaults = .standard,
        device: DeviceKind = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        pause: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        instance: HealthInstance? = nil,
        target: @escaping @Sendable (String) async -> PersonalDataTarget?
    ) {
        self.reader = reader
        self.stores = stores
        self.originStore = originStore
        self.defaults = defaults
        self.device = device
        self.now = now
        self.pause = pause
        self.target = target
        open(instance)
    }

    /// Its own history and progress files beside Health's, in the same Rome's folder.
    nonisolated static func files(for instanceId: String) -> HealthStores {
        let safe = instanceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_."))) ?? instanceId
        let folder = HealthStores.root.appending(path: safe)
        return HealthStores(
            log: SyncLog(url: folder.appending(path: "\(sourceId)-sync-history.jsonl")),
            progress: AnchorStore(url: folder.appending(path: "\(sourceId)-progress.json"))
        )
    }

    // MARK: The open Rome

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
            return
        }
        isEnabled = defaults.bool(forKey: Defaults.enabled(instance.id))
        lane = makeLane(instance.id, enabled: isEnabled)
    }

    private func makeLane(_ instanceId: String, enabled: Bool) -> CalendarLane {
        let stores = stores(instanceId)
        let source = CalendarSource(reader: reader, store: stores.progress)
        let switches = SyncSwitchBox(enabled: enabled)
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let deviceName = device.name
        let originStore = originStore
        let target = target
        let engine = SyncEngine(
            source: source,
            target: { await target(instanceId).flatMap { $0.instanceId == instanceId ? $0 : nil } },
            log: stores.log,
            origin: { originStore.id().map { .init(id: $0, name: deviceName, platform: "ios", appVersion: appVersion) } },
            switches: { switches.value },
            // EventKit reads after the first unlock, unlike Health.
            protectedData: { true },
            now: now, pause: pause,
            onActivity: { [weak self] activity in await self?.setActivity(activity, from: instanceId) },
            onLogged: { [weak self] entry in await self?.logged(entry, from: instanceId) }
        )
        return CalendarLane(instanceId: instanceId, engine: engine, source: source, log: stores.log, switches: switches)
    }

    // MARK: Triggers

    func launch() {
        Task { await reloadHistory() }
    }

    /// Back in front: a catch-up, at most every 15 minutes.
    func foreground() {
        guard isEnabled, let engine = lane?.engine else { return }
        run { await engine.sync(.foreground) }
    }

    func instanceOpened() {
        guard isEnabled, let engine = lane?.engine else { return }
        let stuck = status == .needsSignIn
        run {
            if stuck { await engine.signedIn() }
            await engine.sync(stuck ? .manual : .foreground)
        }
    }

    /// After a live change on the phone: the Rome sees it at once, not at the next open.
    func changedLive() {
        guard isEnabled, let engine = lane?.engine else { return }
        run { await engine.sync(.manual) }
    }

    /// iOS's background app refresh: one sync within its budget.
    func backgroundRefresh() async {
        guard isEnabled, let engine = lane?.engine else { return }
        await engine.sync(.observer, budget: SyncEngine.backgroundBudget)
    }

    @discardableResult
    private func run(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            let hold = BackgroundHold("calendar-sync")
            await work()
            hold.end()
        }
    }

    // MARK: Switches

    @discardableResult
    func setEnabled(_ on: Bool) -> Task<Void, Never> {
        guard let lane, let id = instance?.id else { return Task {} }
        if on, deleting.contains(id) { return Task {} }
        isEnabled = on
        defaults.set(on, forKey: Defaults.enabled(id))
        lane.switches.set(enabled: on)
        let engine = lane.engine
        if on {
            Self.scheduleRefresh()
            return run {
                await engine.signedIn()
                await engine.sync(.manual)
                if lane.switches.value.enabled { await self.tellRome("active", lane: lane) }
            }
        }
        return Task {
            await engine.quiesce()
            guard !lane.switches.value.enabled else { return }
            await self.tellRome("paused", lane: lane)
        }
    }

    @discardableResult
    func syncNow() -> Task<Void, Never> {
        guard let engine = lane?.engine else { return Task {} }
        return run { await engine.sync(.manual) }
    }

    /// Everything this phone sent goes from the open Rome, and its sync turns
    /// off. False when the Rome could not be reached, and nothing changed.
    func deleteUploaded() async -> Bool {
        guard let lane, let id = instance?.id, let target = await target(id), target.instanceId == id, let origin = originStore.id() else { return false }
        let before = lane.switches.value
        lane.switches.set(enabled: false)
        defaults.set(false, forKey: Defaults.enabled(id))
        deleting.insert(id)
        isEnabled = false
        defer { deleting.remove(id) }
        await lane.engine.quiesce()
        do {
            _ = try await target.backend.deleteOrigin(source: Self.sourceId, origin: origin)
        } catch {
            lane.switches.set(enabled: before.enabled)
            defaults.set(before.enabled, forKey: Defaults.enabled(id))
            if self.lane === lane, before.enabled { isEnabled = true }
            return false
        }
        defaults.set(false, forKey: Defaults.enabled(id))
        lane.switches.set(enabled: false)
        await lane.source.reset()
        let entry = await lane.log.append(SyncLogEntry(seq: 0, time: Date(), trigger: .manual, outcome: .deleted))
        guard self.lane === lane else { return true }
        isEnabled = false
        logged(entry, from: id)
        return true
    }

    /// Sign-out: every Rome's switch, progress and history gone.
    @discardableResult
    func forgetAccount() -> Task<Void, Never> {
        let old = lane
        lane = nil
        instance = nil
        isEnabled = false
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Defaults.prefix) { defaults.removeObject(forKey: key) }
        history = []
        activity = SyncActivity()
        return Task {
            if let old {
                await old.engine.quiesce()
                await old.source.reset()
                await old.log.removeAll()
            }
        }
    }

    func reloadHistory() async {
        #if DEBUG
        if isDemo { return }
        #endif
        guard let lane else { return }
        let entries = await lane.log.recent(limit: .max)
        guard self.lane === lane else { return }
        history = entries
    }

    private func tellRome(_ state: String, lane: CalendarLane) async {
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
    }

    // MARK: Background refresh

    /// Asks iOS to wake the app for a refresh, no sooner than four hours from
    /// now. iOS decides when, from how the phone is used; a request replaces
    /// the one before.
    nonisolated static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date().addingTimeInterval(refreshInterval)
        do { try BGTaskScheduler.shared.submit(request) } catch {
            // The Simulator and Mac Catalyst have no background refresh.
            personalDataLog.info("calendar refresh not scheduled: \(error.localizedDescription, privacy: .public)")
        }
    }

    #if DEBUG
    @ObservationIgnored private var isDemo = false

    func showDemo(_ entries: [SyncLogEntry], enabled: Bool = true) {
        isDemo = true
        if instance == nil { instance = HealthInstance(id: "demo", name: "My Rome", isVisitor: false) }
        isEnabled = enabled
        history = entries
    }
    #endif
}

/// One Rome's calendar sync: its engine, progress and history.
final class CalendarLane: Sendable {
    let instanceId: String
    let engine: SyncEngine
    let source: CalendarSource
    let log: SyncLogging
    let switches: SyncSwitchBox

    init(instanceId: String, engine: SyncEngine, source: CalendarSource, log: SyncLogging, switches: SyncSwitchBox) {
        self.instanceId = instanceId
        self.engine = engine
        self.source = source
        self.log = log
        self.switches = switches
    }
}
