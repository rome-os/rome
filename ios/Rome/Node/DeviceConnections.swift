import Foundation
import os
import OSLog
import Observation
import SwiftUI

let deviceConnectionsLog = Logger(subsystem: "cc.romeos.mobile", category: "DeviceConnections")

// This phone's device connections, one per capability ("Apple Health ·
// iPhone"), as the open Rome is told of them. Connections know nothing of
// personal data or sync: a connection is what live access needs, and the
// Health page composes it with Health's own Sync.

/// What the phone reports to the Rome (`PUT /api/device-connections`): every
/// capability as a connection, for this device id. Rows the list leaves out
/// are deleted on the Rome.
struct DeviceConnectionReport: Encodable, Sendable, Equatable {
    struct Device: Encodable, Sendable, Equatable {
        /// The rome-node device id: the Cloud device session.
        let id: String
        let name: String
        let platform: String
        /// This install's personal-data origin, the same across sign-ins
        /// while `id` is not.
        var originId: String? = nil
    }

    struct Operation: Encodable, Sendable, Equatable {
        let name: String
        /// `read` or `write`.
        let access: String
        /// The action's usage, in English, for the Agent. Added after the
        /// first report, so every field below is optional on the Rome.
        var description: String? = nil
        /// The JSON schema of its arguments.
        var input: JSONValue? = nil
        var examples: [JSONValue]? = nil
    }

    struct Connection: Encodable, Sendable, Equatable {
        /// The capability's connection id: `apple_health`, `device`.
        let capability: String
        let title: String
        /// The command prefix, such as `health`.
        let prefix: String
        let personal: Bool
        let operations: [Operation]
        /// The personal-data source it syncs into; absent for one that syncs
        /// nothing. The Rome finds the connection by it before the first sync.
        var feeds: String? = nil
        /// `granted`, `denied`, `not_needed` or `unknown`.
        let permission: String
        let live: Bool
    }

    var version = 1
    let device: Device
    let connections: [Connection]
}

/// A connect card's link into the app: `/connections/device/<capability>`.
enum DeviceConnectLink {
    static let prefix = "/connections/device/"

    /// The capability a link on `origin` names, or nil for any other link.
    static func capability(in url: URL, origin: URL?) -> String? {
        if let origin, let host = url.host(), host != origin.host() { return nil }
        let path = url.path()
        guard path.hasPrefix(prefix) else { return nil }
        let id = String(path.dropFirst(prefix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !id.isEmpty, !id.contains("/") else { return nil }
        return id
    }
}

/// A card's way into the app's own authorization: for a device connection's
/// link, whether it was connected; nil for any other link, which opens as a page.
@MainActor
final class DeviceConnectAction {
    let run: @MainActor (URL) async -> Bool?

    init(_ run: @escaping @MainActor (URL) async -> Bool?) { self.run = run }
}

extension EnvironmentValues {
    /// Set by the shell; a card drawn anywhere else opens every link as a page.
    @Entry var connectDevice: DeviceConnectAction? = nil
}

/// A card asked to connect a capability: the app shows its authorization,
/// and the card goes on once it is done or declined.
struct DeviceConnectRequest: Identifiable {
    let id = UUID()
    let capability: String
    let finish: @MainActor (Bool) -> Void
}

@MainActor
@Observable
final class DeviceConnections {
    enum Defaults {
        /// A capability that needs an iOS permission was connected here.
        static func connected(_ id: String) -> String { "connections.connected.\(id)" }
    }

    /// A connection's id on the Rome: `<deviceId>:<capability>`.
    nonisolated static func connectionId(device: String?, capability: String) -> String? {
        device.map { "\($0.lowercased()):\(capability)" }
    }

    /// Capabilities that need a permission and went through their authorization.
    private(set) var authorized: [String: Bool]
    /// A card waiting on an authorization.
    private(set) var request: DeviceConnectRequest?

    @ObservationIgnored let node: NodeHost
    @ObservationIgnored private let defaults: UserDefaults
    /// Sends the report to the open Rome; set by the app once it can.
    /// Sends a report; false when it did not reach the Rome, as before the
    /// app is ready or on a failed request. That report is sent again by
    /// `reportIfUnsent` once the app is ready.
    @ObservationIgnored var send: (@MainActor (DeviceConnectionReport) async -> Bool)?
    /// The newest report did not reach the Rome.
    @ObservationIgnored private(set) var unsent = false
    /// The rome-node device id and name, or nil while signed out.
    @ObservationIgnored var device: (@MainActor () -> (id: String, name: String)?)?
    /// This install's personal-data origin id, for the report.
    @ObservationIgnored var originId: (@MainActor () -> String?)?
    @ObservationIgnored private var reporting: Task<Void, Never>?

    init(node: NodeHost, defaults: UserDefaults = .standard) {
        self.node = node
        self.defaults = defaults
        var authorized: [String: Bool] = [:]
        for capability in node.registry.capabilities where capability.needsPermission {
            authorized[capability.id] = defaults.bool(forKey: Defaults.connected(capability.id))
        }
        self.authorized = authorized
        node.onLiveChanged = { [weak self] in self?.report() }
    }

    /// Connected: one that needs a permission went through its authorization;
    /// one that needs none has its Live access on.
    func isConnected(_ capability: any NodeCapability) -> Bool {
        capability.needsPermission ? authorized[capability.id] ?? false : node.liveSwitches[capability.id] ?? false
    }

    /// The authorization's end: marked connected, Live access on, and
    /// reported, which it waits for: a card checks the Rome right after.
    /// The iOS permission is asked before this, by the caller.
    func connect(_ id: String) async {
        guard let capability = node.registry.capability(id: id) else { return }
        if capability.needsPermission {
            authorized[id] = true
            defaults.set(true, forKey: Defaults.connected(id))
        }
        node.permissionsChanged()
        if node.liveSwitches[id] != true { node.setLive(id, on: true) }
        await report().value
    }

    // MARK: Card

    /// Shows the authorization for `capability` and waits until it is done
    /// (true) or declined (false). Nil for a capability this build does not
    /// have: the link then opens as a page.
    func ask(_ capability: String) async -> Bool? {
        guard node.registry.capability(id: capability) != nil else { return nil }
        request?.finish(false)
        return await withCheckedContinuation { continuation in
            var resumed = false
            request = DeviceConnectRequest(capability: capability) { [weak self] done in
                guard !resumed else { return }
                resumed = true
                self?.request = nil
                continuation.resume(returning: done)
            }
        }
    }

    // MARK: Report

    /// Reports every connection, after the reports before it, so the Rome
    /// ends on the newest and a caller that waits knows its own has landed.
    /// The task is the send.
    @discardableResult
    func report() -> Task<Void, Never> {
        let previous = reporting
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, let send = self.send, let device = self.device?() else { return }
            let connections = await self.node.registry.connections()
            let sent = await send(DeviceConnectionReport(device: self.reportedDevice(device), connections: connections))
            self.unsent = !sent
        }
        reporting = task
        return task
    }

    /// Sign-out, before the account ends: reports no connections, so the Rome
    /// keeps none for a device id that is over. Waits at most `limit`, so an
    /// unreachable Rome does not hold the sign-out; the next full report or
    /// the 7-day stale rule covers a report that did not land.
    func reportNone(limit: Duration = .seconds(3)) async {
        let previous = reporting
        guard let send, let device = device?() else { return }
        let report = DeviceConnectionReport(device: reportedDevice(device), connections: [])
        let task = Task { @MainActor in
            await previous?.value
            _ = await send(report)
        }
        reporting = task
        await Self.wait(atMost: limit) { await task.value }
    }

    /// Returns once `work` ends or `limit` passes, whichever is first. The
    /// work goes on after a timeout; only the caller stops waiting for it.
    /// A task group would wait for its slow child, so the first to finish
    /// resumes a continuation instead.
    nonisolated static func wait(atMost limit: Duration, for work: @escaping @Sendable () async -> Void) async {
        let once = OSAllocatedUnfairLock(initialState: false)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let finish: @Sendable () -> Void = {
                let first = once.withLock { done in
                    defer { done = true }
                    return !done
                }
                if first { continuation.resume() }
            }
            Task { await work(); finish() }
            Task { try? await Task.sleep(for: limit); finish() }
        }
    }

    private func reportedDevice(_ device: (id: String, name: String)) -> DeviceConnectionReport.Device {
        .init(id: device.id, name: device.name, platform: "ios", originId: originId?())
    }

    /// Sends the report again when the newest did not land.
    func reportIfUnsent() {
        if unsent { report() }
    }

    /// Sign-out: every connection back to not connected. Live access is the
    /// node's, which forgets it on its own.
    func forgetAccount() {
        for id in authorized.keys {
            defaults.removeObject(forKey: Defaults.connected(id))
            authorized[id] = false
        }
        request?.finish(false)
    }

    #if DEBUG
    /// Demo state for the snapshot runner, kept out of the defaults.
    func showDemo(authorized: [String: Bool]) {
        for id in self.authorized.keys { self.authorized[id] = authorized[id] ?? false }
    }
    #endif
}
