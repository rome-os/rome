import ApplicationServices
import Foundation

private final class WindowAXNotificationJournal: @unchecked Sendable {
    private let lock = NSLock()
    private let root: CFTypeRef
    private var onRootDestroyed: (() -> Void)?
    private var stopped = false
    private var destroyed: [CFTypeRef] = []
    private var rootDestroyed = false
    private var resetRequired = false
    private var sequence: UInt64 = 0
    private var notifications: [String: UInt64] = [:]
    private var registrationErrors: [String: UInt64] = [:]
    private var subscriptionState: [String: Any] = [:]
    static let destroyedName = kAXUIElementDestroyedNotification as String
    static let optionalNames = [kAXValueChangedNotification, kAXSelectedTextChangedNotification,
                                kAXTitleChangedNotification, kAXMovedNotification, kAXResizedNotification] as [String]
    private static let names = Set([destroyedName] + optionalNames)

    init(root: CFTypeRef, onRootDestroyed: @escaping () -> Void) {
        self.root = root; self.onRootDestroyed = onRootDestroyed
    }
    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    var requiresFullInvalidation: Bool { lock.lock(); defer { lock.unlock() }; return resetRequired }
    var diagnostics: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return subscriptionState.merging(["stopped": stopped, "changeSequence": sequence,
            "notifications": notifications, "registrationErrors": registrationErrors,
            "pendingDestroyed": destroyed.count, "rootDestroyed": rootDestroyed,
            "requiresFullInvalidation": resetRequired, "absenceDoesNotProveUnchanged": true]) { _, b in b }
    }
    private static func increment(_ value: inout UInt64) { if value < UInt64.max { value += 1 } }

    func receive(_ element: CFTypeRef, name: String) {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        Self.increment(&sequence)
        let key = Self.names.contains(name) ? name : "other"
        var count = notifications[key, default: 0]; Self.increment(&count); notifications[key] = count
        var callback: (() -> Void)?
        if name == Self.destroyedName {
            if !destroyed.contains(where: { CFEqual($0, element) }) {
                if destroyed.count < 256 { destroyed.append(element) } else { resetRequired = true }
            }
            if !rootDestroyed && CFEqual(root, element) { rootDestroyed = true; callback = onRootDestroyed }
        }
        lock.unlock()
        // A callback accepted before stop may finish afterwards. It must not re-enter this lock.
        callback?()
    }
    func drain() -> [CFTypeRef] {
        lock.lock(); defer { lock.unlock() }
        let values = destroyed; destroyed.removeAll(keepingCapacity: true); return values
    }
    func record(error: AXError, operation: String) {
        guard error != .success && error != .notificationAlreadyRegistered else { return }
        lock.lock(); defer { lock.unlock() }
        let key = "\(operation):\(error.rawValue)"
        let bounded = registrationErrors[key] != nil || registrationErrors.count < 32 ? key : "other"
        var count = registrationErrors[bounded, default: 0]; Self.increment(&count); registrationErrors[bounded] = count
    }
    func publish(_ state: [String: Any]) {
        lock.lock(); subscriptionState = state
        if stopped { subscriptionState["subscriptionsBeforeStop"] = state["subscriptions"]; subscriptionState["subscriptions"] = 0 }
        lock.unlock()
    }
    func stop() {
        lock.lock()
        if !stopped { subscriptionState["subscriptionsBeforeStop"] = subscriptionState["subscriptions"] }
        stopped = true; onRootDestroyed = nil; subscriptionState["subscriptions"] = 0
        lock.unlock()
    }
}

// Notifications invalidate cached identities; every observation and dispatch proof still reads fresh AX state.
// The caller verifies process/window identity and serializes update. stop, drain and diagnostics may run concurrently.
final class WindowAXInvalidation: @unchecked Sendable {
    private struct Subscription {
        let element: AXUIElement
        let name: String
        let error: AXError
        var active: Bool { error == .success || error == .notificationAlreadyRegistered }
        var mayBeRegistered: Bool { !WindowAXInvalidation.definitelyUnregistered(error) }
    }
    private let journal: WindowAXNotificationJournal
    private let root: AXUIElement
    private let updateLock = NSLock()
    private let resourceLock = NSLock()
    private var observer: AXObserver?
    private var source: CFRunLoopSource?
    // The serialized update lane owns subscriptions; callbacks never inspect it.
    private var subscriptions: [Subscription] = []

    private static func definitelyUnregistered(_ error: AXError) -> Bool {
        [.notificationUnsupported, .notImplemented, .illegalArgument, .notificationNotRegistered].contains(error)
    }

    init(pid: pid_t, root: AXUIElement, onRootDestroyed: @escaping () -> Void) throws {
        guard pid > 0 else { throw NativeFailure("window_ax_observer_invalid_pid") }
        self.root = root
        journal = WindowAXNotificationJournal(root: root, onRootDestroyed: onRootDestroyed)
        var created: AXObserver?
        let error = AXObserverCreate(pid, { _, element, name, context in
            guard let context else { return }
            let journal = Unmanaged<WindowAXNotificationJournal>.fromOpaque(context).takeUnretainedValue()
            journal.receive(element, name: name as String)
        }, &created)
        guard error == .success, let created else { throw NativeFailure("window_ax_observer_unavailable", details: ["axError": error.rawValue]) }
        let source = AXObserverGetRunLoopSource(created)
        observer = created; self.source = source
        let journal = self.journal
        DispatchQueue.main.async {
            guard !journal.isStopped else { return }
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        }
    }

    var diagnostics: [String: Any] { journal.diagnostics }
    var requiresFullInvalidation: Bool { journal.requiresFullInvalidation }
    func drain() -> [AXUIElement] { journal.drain().map { $0 as! AXUIElement } }

    // Optional unsupported notifications are reported, never promoted to successful subscriptions.
    func update(elements: [AXUIElement], check: () throws -> Void) throws {
        guard updateLock.try() else { throw NativeFailure("window_ax_observer_busy") }
        defer { updateLock.unlock() }
        let began = ProcessInfo.processInfo.systemUptime, deadline = began + 0.09
        try check()
        guard !journal.isStopped else { throw NativeFailure("window_ax_observer_stopped") }
        resourceLock.lock(); let observer = self.observer; resourceLock.unlock()
        guard let observer else { throw NativeFailure("window_ax_observer_stopped") }
        var desired = [root], capped = elements.count > 256
        for element in elements.prefix(256) {
            if !desired.contains(where: { CFEqual($0, element) }) {
                if desired.count < 256 { desired.append(element) } else { capped = true }
            }
        }
        var budgetReached = false, capacityReached = false
        func ready(_ element: AXUIElement) throws -> Bool {
            try check()
            guard !journal.isStopped else { throw NativeFailure("window_ax_observer_stopped") }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0.002 else { budgetReached = true; return false }
            let error = AXUIElementSetMessagingTimeout(element, Float(min(0.008, remaining)))
            journal.record(error: error, operation: "timeout")
            return error == .success
        }
        func remove(_ subscription: Subscription) throws -> Bool {
            guard subscription.mayBeRegistered else { return true }
            guard try ready(subscription.element) else { return false }
            let error = AXObserverRemoveNotification(observer, subscription.element, subscription.name as CFString)
            journal.record(error: error, operation: "remove")
            return error == .success || error == .notificationNotRegistered
        }
        defer {
            journal.publish(["subscriptions": subscriptions.filter(\.active).count, "attemptedPairs": subscriptions.count,
                "unknownRegistrationOutcomes": subscriptions.filter { !$0.active && $0.mayBeRegistered }.count,
                "rootDestroyedSupported": subscriptions.contains { $0.name == WindowAXNotificationJournal.destroyedName && $0.active && CFEqual($0.element, root) },
                "maxSubscriptions": 512, "observedElements": desired.count, "inputElementsCapped": capped,
                "updateElapsedMs": (ProcessInfo.processInfo.systemUptime - began) * 1000,
                "budgetReached": budgetReached, "capacityReached": capacityReached])
        }
        for index in subscriptions.indices.reversed() {
            let entry = subscriptions[index]
            if !desired.contains(where: { CFEqual($0, entry.element) }) {
                guard try remove(entry) else { return }
                subscriptions.remove(at: index)
            }
        }
        func add(_ element: AXUIElement, _ name: String) throws -> Bool {
            // A failed RPC may have registered remotely. Retain its budget and never replay that pair.
            if subscriptions.contains(where: { $0.name == name && CFEqual($0.element, element) }) { return true }
            if subscriptions.count >= 512 {
                capacityReached = true
                guard name == WindowAXNotificationJournal.destroyedName,
                      let index = subscriptions.lastIndex(where: { $0.name != WindowAXNotificationJournal.destroyedName }) else { return false }
                guard try remove(subscriptions[index]) else { return false }
                subscriptions.remove(at: index)
            }
            guard try ready(element) else { return false }
            let error = AXObserverAddNotification(observer, element, name as CFString, Unmanaged.passUnretained(journal).toOpaque())
            subscriptions.append(Subscription(element: element, name: name, error: error))
            journal.record(error: error, operation: "add")
            return true
        }
        for element in desired { guard try add(element, WindowAXNotificationJournal.destroyedName) else { return } }
        for name in [kAXMovedNotification, kAXResizedNotification, kAXTitleChangedNotification] as [String] {
            guard try add(root, name) else { return }
        }
        for element in desired.dropFirst() {
            for name in WindowAXNotificationJournal.optionalNames.prefix(3) { guard try add(element, name) else { return } }
        }
    }

    func stop() {
        journal.stop()
        resourceLock.lock()
        let observer = self.observer, source = self.source
        self.observer = nil; self.source = nil
        resourceLock.unlock()
        guard let source else { return }
        CFRunLoopSourceInvalidate(source)
        let journal = self.journal
        // The retained box survives any callback already running on the main run loop.
        DispatchQueue.main.async {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            withExtendedLifetime((observer, journal)) {}
        }
    }
    deinit { stop() }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var assertions = 0
        func check(_ value: Bool) throws {
            guard value else { throw NativeFailure("window_ax_invalidation_self_check_failed", details: ["assertion": assertions + 1]) }
            assertions += 1
        }
        let root = "root" as CFString, child = "child" as CFString
        try check(definitelyUnregistered(.notificationUnsupported) && definitelyUnregistered(.notImplemented))
        try check(!definitelyUnregistered(.cannotComplete) && !definitelyUnregistered(.failure))
        try check(!definitelyUnregistered(.success) && !definitelyUnregistered(.notificationAlreadyRegistered))
        var callbacks = 0
        let journal = WindowAXNotificationJournal(root: root, onRootDestroyed: { callbacks += 1 })
        try check(journal.drain().isEmpty && !journal.requiresFullInvalidation)
        journal.receive(child, name: kAXValueChangedNotification)
        try check(journal.drain().isEmpty && journal.diagnostics["changeSequence"] as? UInt64 == 1)
        journal.receive(child, name: WindowAXNotificationJournal.destroyedName)
        journal.receive("child" as CFString, name: WindowAXNotificationJournal.destroyedName)
        let removed = journal.drain()
        try check(removed.count == 1 && CFEqual(removed[0], child) && callbacks == 0)
        try check(journal.drain().isEmpty)
        journal.receive(root, name: WindowAXNotificationJournal.destroyedName)
        journal.receive(root, name: WindowAXNotificationJournal.destroyedName)
        try check(callbacks == 1 && journal.drain().count == 1)
        for index in 0..<257 { journal.receive("item-\(index)" as CFString, name: WindowAXNotificationJournal.destroyedName) }
        try check(journal.requiresFullInvalidation && journal.drain().count == 256)
        try check(journal.requiresFullInvalidation)
        for index in 0..<100 { journal.receive(child, name: "unknown-\(index)") }
        try check((journal.diagnostics["notifications"] as? [String: UInt64])?["other"] == 100)
        journal.record(error: .success, operation: "add")
        journal.record(error: .notificationAlreadyRegistered, operation: "add")
        try check((journal.diagnostics["registrationErrors"] as? [String: UInt64])?.isEmpty == true)
        for index in 0..<100 { journal.record(error: .failure, operation: "test-\(index)") }
        try check((journal.diagnostics["registrationErrors"] as? [String: UInt64])?.count == 33)
        let before = journal.diagnostics["changeSequence"] as? UInt64
        journal.publish(["subscriptions": 7])
        journal.stop(); journal.stop()
        journal.receive(root, name: WindowAXNotificationJournal.destroyedName)
        try check(journal.isStopped && journal.drain().isEmpty && callbacks == 1)
        try check(journal.diagnostics["changeSequence"] as? UInt64 == before)
        try check(journal.diagnostics["subscriptions"] as? Int == 0 && journal.diagnostics["subscriptionsBeforeStop"] as? Int == 7)
        journal.publish(["subscriptions": 9])
        try check(journal.diagnostics["subscriptions"] as? Int == 0)
        let concurrent = WindowAXNotificationJournal(root: root, onRootDestroyed: {})
        DispatchQueue.concurrentPerform(iterations: 1024) { index in
            concurrent.receive("parallel-\(index % 4)" as CFString, name: WindowAXNotificationJournal.destroyedName)
        }
        try check(concurrent.drain().count == 4 && concurrent.diagnostics["changeSequence"] as? UInt64 == 1024)
        var reentrant: WindowAXNotificationJournal?
        reentrant = WindowAXNotificationJournal(root: root, onRootDestroyed: { reentrant?.stop() })
        reentrant?.receive(root, name: WindowAXNotificationJournal.destroyedName)
        try check(reentrant?.isStopped == true && reentrant?.drain().count == 1)
        let racing = WindowAXNotificationJournal(root: root, onRootDestroyed: {})
        DispatchQueue.concurrentPerform(iterations: 1024) { index in
            if index.isMultiple(of: 16) { racing.stop() }
            racing.receive(child, name: WindowAXNotificationJournal.destroyedName)
        }
        let raceSequence = racing.diagnostics["changeSequence"] as? UInt64
        racing.receive(child, name: kAXValueChangedNotification)
        try check(racing.isStopped && racing.drain().count <= 1 && racing.diagnostics["changeSequence"] as? UInt64 == raceSequence)
        return assertions
    }
    #endif
}
