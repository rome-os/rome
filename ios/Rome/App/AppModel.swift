import Foundation
import SwiftUI
import Observation
import os

/// Holds the current instance session token for requests, safe to read from any thread.
final class TokenBox: Sendable {
    private let state = OSAllocatedUnfairLock<String?>(initialState: nil)

    var token: String? {
        get { state.withLock { $0 } }
        set { state.withLock { $0 = newValue } }
    }
}

/// Everything that belongs to one opened instance.
@MainActor
@Observable
final class Workspace {
    enum ConciergeState: Equatable { case loading, ready, off, failed }

    let backend: RomeBackend
    let instanceName: String
    let host: String
    private(set) var accountLabel: String
    let tasks: TasksStore
    let concierge: TranscriptStore
    private(set) var conciergeState: ConciergeState = .loading
    private(set) var unreadAtOpen = 0
    /// A Chat message to scroll to and highlight, set from the Tasks sheet.
    var focusMessageID: String?

    init(backend: RomeBackend, instanceName: String, host: String, accountLabel: String) {
        self.backend = backend
        self.instanceName = instanceName
        self.host = host
        self.accountLabel = accountLabel
        tasks = TasksStore(backend: backend)
        concierge = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
    }

    func start() async {
        tasks.start()
        Task { if let name = try? await backend.me(), !name.isEmpty { accountLabel = name } }
        await openConcierge()
    }

    func openConcierge() async {
        conciergeState = .loading
        do {
            let info = try await backend.conciergeSession()
            unreadAtOpen = info.unread
            conciergeState = .ready
            concierge.start()
        } catch APIError.conciergeOff {
            conciergeState = .off
        } catch {
            conciergeState = .failed
        }
    }

    func enableConcierge() async {
        conciergeState = .loading
        do {
            try await backend.setConciergeEnabled(true)
            await openConcierge()
        } catch {
            conciergeState = .off
        }
    }

    func stop() {
        tasks.stop()
        concierge.stop()
        backend.events.pause()
    }
}

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case signedOut
        case signingIn
        case connecting(host: String)
        case stopped(instanceName: String)
        case noInstance
        case ready
    }

    private enum Defaults {
        static let lastInstance = "lastInstanceID"
        static let hintShown = "autoOpenHintShown"
    }

    private(set) var phase: Phase = .launching
    private(set) var workspace: Workspace?
    private(set) var instances: [CloudInstance] = []
    private(set) var currentInstanceID: String?
    private(set) var signInError: String?
    private(set) var sessionExpired = false
    /// Shown once after the app picked an instance among several on its own.
    var autoOpenHint: String?
    /// Goes up when a tapped push asks the shell to show Chat.
    private(set) var conciergeRequest = 0
    /// A tapped push waiting for an instance to open.
    private var pendingPush: PushTarget?

    let cloud: CloudAuth
    let push: PushCenter
    /// Keeps the open instance on its latest release.
    let update = InstanceUpdater()
    static let updateCheckHold: Duration = .seconds(1)

    /// The open instance's Web dashboard.
    var webURL: URL? {
        instances.first { $0.id == currentInstanceID }.flatMap { URL(string: $0.origin) }
    }
    private let token = TokenBox()
    private var refreshing = false

    init() {
        let cloud = CloudAuth(origin: CloudAuth.configuredOrigin)
        self.cloud = cloud
        push = PushCenter(registry: cloud)
    }

    // MARK: Launch

    func launch(skipSnapshot: Bool = false) async {
        #if DEBUG
        if SnapshotRunner.directory != nil, !skipSnapshot {
            await SnapshotRunner.run(model: self)
            return
        }
        #endif
        Task { await push.launch() }
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["ROME_DEMO"] == "1" {
            openDemo()
            return
        }
        if environment["ROME_DEMO"] == "update" {
            openDemo(.updateRequired)
            return
        }
        if let origin = environment["ROME_LOCAL_ORIGIN"],
           let user = environment["ROME_LOCAL_USER"],
           let password = environment["ROME_LOCAL_PASSWORD"] {
            await openLocal(origin: origin, user: user, password: password)
            return
        }
        #endif
        if cloud.hasCredential {
            // A tap that launched the app opens its instance first.
            await openInstance(preferring: pendingPush?.instanceId, showHint: false)
        } else {
            phase = .signedOut
        }
    }

    // MARK: Cloud sign-in

    func beginSignIn() -> CloudSignInRequest {
        signInError = nil
        phase = .signingIn
        return cloud.beginSignIn()
    }

    func finishSignIn(_ request: CloudSignInRequest, callback: Result<URL, Error>) async {
        switch callback {
        case .failure:
            // The guardian closed the sheet: back to the button, no error.
            phase = .signedOut
        case .success(let url):
            do {
                try await cloud.completeSignIn(request, callback: url)
                await openInstance(preferring: nil, showHint: true)
            } catch {
                signInError = (error as? LocalizedError)?.errorDescription ?? String(localized: "Sign-in did not finish")
                phase = .signedOut
            }
        }
    }

    /// Picks and opens an instance. The one this device opened last wins, then
    /// the only running one, then the first running one.
    func openInstance(preferring id: String?, showHint: Bool) async {
        do {
            let list = try await cloud.listInstances()
            instances = list
            let running = list.filter(\.isRunning)
            let remembered = UserDefaults.standard.string(forKey: Defaults.lastInstance)
            let chosen = running.first { $0.id == id } ?? running.first { $0.id == remembered } ?? running.first
            guard let chosen else {
                if let stopped = list.first(where: { $0.id == (id ?? remembered) }) ?? list.first {
                    phase = .stopped(instanceName: stopped.name)
                } else {
                    phase = .noInstance
                }
                return
            }
            let pickedAmongMany = running.count > 1 && id == nil && remembered == nil
            await connect(to: chosen)
            if showHint, pickedAmongMany, !UserDefaults.standard.bool(forKey: Defaults.hintShown) {
                UserDefaults.standard.set(true, forKey: Defaults.hintShown)
                autoOpenHint = String(localized: "Opened “\(chosen.name)”. Switch instances in Settings.")
            }
        } catch AuthError.cloudUnauthorized {
            phase = .signedOut
        } catch {
            if workspace == nil {
                signInError = (error as? LocalizedError)?.errorDescription
                phase = .signedOut
            }
        }
    }

    /// `keepUpdate`: reaching the instance an upgrade waits on, which keeps the
    /// update page up. Any other connect starts over, so a page left from the
    /// last instance never covers this one.
    private func connect(to instance: CloudInstance, keepUpdate: Bool = false) async {
        if !keepUpdate { update.reset() }
        phase = .connecting(host: instance.host)
        do {
            let session = try await cloud.session(for: instance)
            token.token = session.token
            UserDefaults.standard.set(instance.id, forKey: Defaults.lastInstance)
            currentInstanceID = instance.id
            // Signed in to Rome Cloud: this launch's token, if it has one yet.
            Task { await push.upload() }
            let client = APIClient(origin: URL(string: instance.origin)!, token: { [token] in token.token }) { [weak self] in
                Task { @MainActor in self?.handleUnauthorized() }
            }
            await open(Workspace(
                backend: LiveBackend(client: client),
                instanceName: instance.name,
                host: instance.host,
                accountLabel: instance.name
            ))
        } catch AuthError.instanceNotReady {
            phase = .stopped(instanceName: instance.name)
            // Mid-upgrade the instance is down for a while: keep the update page
            // waiting and open it again once Rome Cloud reports it running.
            _ = update.waitWithoutInstance(instanceID: instance.id) { [weak self] in
                await self?.reconnectWhenRunning(instance.id)
            }
        } catch AuthError.cloudUnauthorized {
            phase = .signedOut
        } catch {
            signInError = (error as? LocalizedError)?.errorDescription
            phase = .signedOut
        }
    }

    private func reconnectWhenRunning(_ id: String) async {
        guard let list = try? await cloud.listInstances() else { return }
        instances = list
        if let instance = list.first(where: { $0.id == id }), instance.isRunning {
            await connect(to: instance, keepUpdate: true)
        }
    }

    func switchInstance(to instance: CloudInstance) async {
        guard instance.id != currentInstanceID else { return }
        update.reset()
        workspace?.stop()
        workspace = nil
        await connect(to: instance)
    }

    func refreshInstances() async {
        if let list = try? await cloud.listInstances() { instances = list }
    }

    func retry() async {
        await openInstance(preferring: nil, showHint: false)
    }

    func signOut() async {
        update.reset()
        workspace?.stop()
        workspace = nil
        token.token = nil
        pendingPush = nil
        await push.signOut { await cloud.signOut() }
        UserDefaults.standard.removeObject(forKey: Defaults.lastInstance)
        instances = []
        currentInstanceID = nil
        sessionExpired = false
        phase = .signedOut
    }

    // MARK: Session expiry

    private func handleUnauthorized() {
        guard !refreshing, let id = currentInstanceID, let instance = instances.first(where: { $0.id == id }) else {
            if currentInstanceID != nil { sessionExpired = true }
            return
        }
        refreshing = true
        Task {
            defer { refreshing = false }
            do {
                let session = try await cloud.session(for: instance, forceRefresh: true)
                token.token = session.token
                sessionExpired = false
            } catch {
                sessionExpired = true
            }
        }
    }

    func reauthenticate() async {
        sessionExpired = false
        workspace?.stop()
        workspace = nil
        await openInstance(preferring: currentInstanceID, showHint: false)
    }

    private func open(_ workspace: Workspace) async {
        self.workspace = workspace
        // Its own task: the poll that reports the finish is cancelled when the
        // reopened workspace attaches, and would cancel the reopen with it.
        update.onFinished = { [weak self] in Task { await self?.reopenAfterUpgrade() } }
        if let id = currentInstanceID {
            Task { await update.attach(backend: workspace.backend, instanceID: id) }
            // Hold the loading state briefly for the check, so a Rome that is
            // behind goes straight to the update page instead of showing Chat
            // first. A slow check does not hold the app: the page covers Chat
            // when the answer comes.
            await update.waitForFirstAnswer(upTo: Self.updateCheckHold)
        }
        phase = .ready
        if pendingPush != nil {
            await routePendingPush()
            // The push was for another instance, now open in its place.
            guard self.workspace === workspace else { return }
        }
        await workspace.start()
    }

    // MARK: Pushes

    /// A tapped push: its instance, then its Concierge. It waits while no
    /// instance is open, through a cold launch or a sign-in.
    func openFromPush(_ target: PushTarget) async {
        pendingPush = target
        await routePendingPush()
    }

    private func routePendingPush() async {
        guard let target = pendingPush, phase == .ready, workspace != nil else { return }
        pendingPush = nil
        if target.instanceId != currentInstanceID, !instances.contains(where: { $0.id == target.instanceId }) {
            await refreshInstances()
        }
        switch PushRoute.decide(target, currentInstanceID: currentInstanceID, instances: instances) {
        case .switchTo(let instance):
            // The same path as the instances page; the new shell opens on Chat.
            await switchInstance(to: instance)
        case .openConcierge:
            conciergeRequest += 1
            // The push is news the chat may not hold yet: the socket can still
            // be reconnecting, or never paused if the tap came over the open app.
            workspace?.concierge.resync()
        }
    }

    /// The instance restarted on its new release: open it fresh, so the chat,
    /// the tasks and the live socket all come from the new process.
    private func reopenAfterUpgrade() async {
        guard let old = workspace else { return }
        old.stop()
        old.backend.events.resume()
        // A 401 from a restarting instance is not an expired session.
        sessionExpired = false
        await open(Workspace(backend: old.backend, instanceName: old.instanceName, host: old.host, accountLabel: old.accountLabel))
    }

    // MARK: Debug paths

    #if DEBUG
    /// A screen change requested by the snapshot runner.
    var debugCommand: DebugCommand?
    /// Text size the snapshot runner forces, to check large Dynamic Type.
    var dynamicTypeOverride: DynamicTypeSize?

    func debugSetPhase(_ phase: Phase) {
        workspace?.stop()
        workspace = nil
        self.phase = phase
    }

    func openDemo(_ variant: DemoBackend.Variant = .full) {
        update.reset()
        workspace?.stop()
        let backend = DemoBackend(variant: variant)
        instances = DemoBackend.instances
        currentInstanceID = DemoBackend.instances.first?.id
        Task {
            await open(Workspace(backend: backend, instanceName: String(localized: "My Rome"), host: "me.romeos.cc", accountLabel: "lin@example.com"))
        }
    }

    /// Signs in to a Rome running on this Mac with a local test guardian.
    private func openLocal(origin: String, user: String, password: String) async {
        guard let url = URL(string: origin) else { return }
        phase = .connecting(host: url.host() ?? origin)
        var request = URLRequest(url: url.appending(path: "api/auth/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["userId": user, "password": password])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        guard let (_, response) = try? await URLSession(configuration: configuration).data(for: request),
              let http = response as? HTTPURLResponse,
              let cookie = http.value(forHTTPHeaderField: "Set-Cookie"),
              let value = cookie.components(separatedBy: ";").first?.components(separatedBy: "rome_session=").last
        else {
            signInError = String(localized: "Could not reach the local Rome")
            phase = .signedOut
            return
        }
        token.token = value
        let local = CloudInstance(id: "local", name: String(localized: "Local Rome"), slug: "local", origin: origin, status: "running")
        instances = [local]
        currentInstanceID = local.id
        let client = APIClient(origin: url, token: { [token] in token.token })
        await open(Workspace(backend: LiveBackend(client: client), instanceName: String(localized: "Local Rome"), host: url.host() ?? origin, accountLabel: user))
    }
    #endif
}
