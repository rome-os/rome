import Foundation
import SwiftUI
import Observation
import os
import UserNotifications

/// Holds the current instance session token for requests, safe to read from any thread.
final class TokenBox: Sendable {
    private let state = OSAllocatedUnfairLock<String?>(initialState: nil)
    private let name = OSAllocatedUnfairLock<String>(initialState: InstanceSession.guardianCookie)

    var token: String? {
        get { state.withLock { $0 } }
        set { state.withLock { $0 = newValue } }
    }

    /// The cookie the token goes in: `rome_session`, or `rome_visitor` for a visitor.
    var cookieName: String {
        get { name.withLock { $0 } }
        set { name.withLock { $0 = newValue } }
    }

    func use(_ session: InstanceSession) {
        cookieName = session.cookie
        token = session.token
    }
}

/// Decides when coming back to the foreground means the screens may be behind.
/// A trip to the background always does; a moment inactive (a system alert,
/// Notification Center pulled over the app) does once it lasts a second.
struct ForegroundGate {
    static let shortest: TimeInterval = 1
    private var leftAt: Date?
    private var wentBackground = false

    mutating func resignedActive(at date: Date) {
        if leftAt == nil { leftAt = date }
    }

    mutating func enteredBackground(at date: Date) {
        if leftAt == nil { leftAt = date }
        wentBackground = true
    }

    /// In the background since it last came back.
    var isInBackground: Bool { wentBackground }

    /// True when the screens should refetch.
    mutating func becameActive(at date: Date) -> Bool {
        defer {
            leftAt = nil
            wentBackground = false
        }
        guard let leftAt else { return false }
        return wentBackground || date.timeIntervalSince(leftAt) >= Self.shortest
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
    /// The Rome Cloud picture of who is signed in, when they have one.
    private(set) var avatarURL: URL?
    let tasks: TasksStore
    private(set) var concierge: TranscriptStore
    /// The topic chats, for the drawer.
    let topics: TopicChatsStore
    /// Each opened topic chat's transcript, kept while the instance is open so
    /// coming back to a chat does not load it from the top again.
    @ObservationIgnored private var topicStores: [String: TranscriptStore] = [:]
    /// Goes up per topic chat when it must show its newest rows: a tapped push.
    private(set) var topicLatest: [String: Int] = [:]
    private(set) var conciergeState: ConciergeState = .loading
    private(set) var unreadAtOpen = 0
    /// This person's main chat on the server: the guardian's is `concierge`, a
    /// visitor's its own id. The app names the main chat `conciergeChatID` in
    /// its screens; everything sent to the server uses this id.
    private(set) var mainChatServerID: String?
    /// Whose session this is. Apps, the update page, AI tool usage, approvals
    /// and the instance's own settings are the guardian's; a visitor never sees
    /// them. Unknown (not read yet, or unreadable) is treated as the guardian,
    /// so a slow network never hides the owner's controls.
    enum Role: Equatable { case unknown, guardian, visitor }
    private(set) var role: Role = .unknown
    /// Apps shows for the guardian only, once that is known.
    var isGuardian: Bool { role == .guardian }
    var isVisitor: Bool { role == .visitor }

    /// Reads who this session is from `/auth/me`.
    func readRole() async {
        do {
            let identity = try await backend.me()
            role = identity?.isGuardian == true ? .guardian : .visitor
            if let identity {
                accountLabel = identity.name
                avatarURL = identity.avatarURL
            }
        } catch {
            role = .unknown
        }
    }
    /// A Chat message to scroll to and highlight, set from the Tasks sheet.
    var focusMessageID: String?
    /// A prompt for the main Chat's composer, unsent; Chat takes it once its
    /// draft is restored, and clears it.
    var composerPrefill: String?
    /// Goes up when Chat must show its newest rows: a tapped push.
    private(set) var latestRequest = 0

    func showLatest() {
        latestRequest += 1
        concierge.resync()
    }

    /// What the guardian left in each chat's composer, on this phone.
    let drafts: DraftStore
    /// The newest messages of the main Chat and topic chats, on this phone.
    let transcripts: TranscriptCache

    init(backend: RomeBackend, instanceName: String, host: String, accountLabel: String, drafts: DraftStore? = nil) {
        self.backend = backend
        self.instanceName = instanceName
        self.host = host
        self.accountLabel = accountLabel
        self.drafts = drafts ?? DraftStore(instance: host)
        // Beside the drafts: a test's drafts in a temporary folder bring their transcripts along.
        transcripts = TranscriptCache(root: self.drafts.root.deletingLastPathComponent().appending(path: "Transcripts", directoryHint: .isDirectory), instance: self.drafts.instance)
        tasks = TasksStore(backend: backend)
        // The main chat's id from last time, else the guardian's until the
        // server names this person's. Its kept rows show before any fetch.
        let mainId = transcripts.mainChat() ?? conciergeChatID
        let main = TranscriptStore(sessionId: mainId, kind: .concierge, backend: backend)
        main.drafts = ChatDrafts(store: self.drafts, chat: mainId)
        main.cache = transcripts
        main.showCached()
        if main.loaded { conciergeState = .ready }
        concierge = main
        topics = TopicChatsStore(backend: backend)
    }

    func topicStore(_ chatId: String) -> TranscriptStore {
        if let store = topicStores[chatId] { return store }
        let store = TranscriptStore(sessionId: chatId, kind: .concierge, backend: backend)
        store.drafts = ChatDrafts(store: drafts, chat: chatId)
        store.cache = transcripts
        store.showCached()
        topicStores[chatId] = store
        return store
    }

    /// Starts a topic chat, then sends it its first message, in that order.
    /// Nothing exists on the server before this. Returns the new chat's id, or
    /// nil when the chat could not be started.
    /// Each opened task chat's transcript, kept like the topic chats': a
    /// failed send keeps its bubble and Retry when the guardian comes back.
    @ObservationIgnored private var taskStores: [String: TranscriptStore] = [:]

    /// A message of the guardian's is still on its way, in any chat.
    var isSending: Bool {
        ([concierge] + Array(topicStores.values) + Array(taskStores.values))
            .contains { store in store.pending.contains { $0.state == .sending } }
    }

    func taskStore(_ chatId: String) -> TranscriptStore {
        if let store = taskStores[chatId] { return store }
        let store = TranscriptStore(sessionId: chatId, kind: .task, backend: backend)
        store.drafts = ChatDrafts(store: drafts, chat: chatId)
        taskStores[chatId] = store
        return store
    }

    /// Starts a topic chat, then sends it its first message, in that order.
    /// Until the chat exists, the message is kept under the blank chat's
    /// draft key: a failed start or a kill does not lose it.
    func startTopicChat(firstMessage text: String, images: [ComposerImage] = [], blankKey: String? = nil, fromComposer: Bool = false) async -> String? {
        let startId = "start-\(UUID().uuidString)"
        if let blankKey { drafts.sending(chat: blankKey, inputId: startId, text: text, photos: images, fromComposer: fromComposer) }
        guard let chat = try? await backend.startTopicChat() else {
            // Back into the blank chat's draft: its composer shows it, or,
            // if the guardian has left, the next blank chat does.
            if let blankKey { drafts.takeBack(chat: blankKey, inputId: startId) }
            return nil
        }
        topics.add(chat)
        let store = topicStore(chat.id)
        store.beginEmpty()
        store.start()
        // The send keeps it under the new chat first, then the blank slot goes.
        store.send(text, images: images)
        if let blankKey {
            drafts.delivered(chat: blankKey, inputId: startId)
            drafts.discard(chat: blankKey)
        }
        return chat.id
    }

    /// Renames a topic chat. Returns whether the server took it.
    @discardableResult
    func renameTopic(_ chatId: String, to name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, (try? await backend.renameChat(chatId, to: trimmed)) != nil else { return false }
        topics.rename(chatId, to: trimmed)
        return true
    }

    /// Archives a topic chat and drops it from the drawer. Returns whether the
    /// server took it.
    @discardableResult
    func archiveTopic(_ chatId: String) async -> Bool {
        guard (try? await backend.archiveChat(chatId)) != nil else { return false }
        topics.remove(chatId)
        topicStores.removeValue(forKey: chatId)?.stop()
        return true
    }

    /// A tapped push for a topic chat: its newest rows, fetched again.
    func showLatest(inTopic chatId: String) {
        topicLatest[chatId, default: 0] += 1
        topicStore(chatId).resync()
    }

    func start() async {
        drafts.discardBlankChats()
        tasks.start()
        topics.start()
        if role == .unknown { Task { await readRole() } }
        await openConcierge()
    }

    /// Kept rows from last time stay on screen while this runs, and when the
    /// instance cannot be reached: the store fetches again when it is back.
    func openConcierge() async {
        if !concierge.loaded { conciergeState = .loading }
        do {
            let info = try await backend.conciergeSession()
            unreadAtOpen = info.unread
            mainChatServerID = info.id
            useMainChat(info.id)
            transcripts.setMainChat(info.id)
            conciergeState = .ready
            concierge.start()
        } catch APIError.conciergeOff {
            conciergeState = .off
        } catch {
            if concierge.loaded {
                conciergeState = .ready
                concierge.start()
            } else {
                conciergeState = .failed
            }
        }
    }

    /// A visitor's main chat is not `concierge`: its transcript, sends, live
    /// topic and drafts go by its own id. What this phone kept as `concierge`
    /// before moves with it, so no draft is lost. Nothing has loaded yet: the
    /// store starts once the id is known.
    private func useMainChat(_ id: String) {
        guard !id.isEmpty, id != concierge.sessionId else { return }
        concierge.stop()
        drafts.move(chat: concierge.sessionId, to: id)
        let store = TranscriptStore(sessionId: id, kind: .concierge, backend: backend)
        store.drafts = ChatDrafts(store: drafts, chat: id)
        store.cache = transcripts
        store.showCached()
        concierge = store
    }

    /// The id this person's main chat goes by, here and on the server.
    func isMainChat(_ id: String) -> Bool {
        id == conciergeChatID || id == mainChatServerID || id == concierge.sessionId
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

    /// The guardian's apps as last read, kept for this instance while the app
    /// runs: Apps shows it at once when opened again, and links in chat text
    /// look apps up in it. Nil until the first read.
    private(set) var appsCache: [InstalledApp]?
    var apps: [InstalledApp] { appsCache ?? [] }

    /// Keeps the apps list; an unchanged list leaves it as it is.
    func shelve(_ apps: [InstalledApp]) async {
        if appsCache != apps { appsCache = apps }
    }

    func stop() {
        tasks.stop()
        concierge.stop()
        topics.stop()
        for store in topicStores.values { store.stop() }
        for store in taskStores.values { store.stop() }
        backend.events.pause()
        transcripts.flush()
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

        /// Launching or opening an instance: the opening screen shows.
        var isOpening: Bool {
            switch self {
            case .launching, .connecting: return true
            default: return false
            }
        }
    }

    private enum Defaults {
        static let lastInstance = "lastInstanceID"
        /// The instance last opened, as Rome Cloud listed it: opened again
        /// when Rome Cloud cannot be reached at launch.
        static let lastInstanceRecord = "lastInstanceRecord"
        static let hintShown = "autoOpenHintShown"
    }

    private(set) var phase: Phase = .launching
    private(set) var workspace: Workspace? {
        // Pictures belong to the workspace that loaded them.
        didSet { if workspace !== oldValue { StoredImageCache.reset() } }
    }
    private(set) var instances: [CloudInstance] = []
    private(set) var currentInstanceID: String?
    private(set) var signInError: String?
    /// The instance to sign in to once from a browser before the phone can,
    /// set with its error.
    private(set) var browserSignIn: URL?
    private(set) var sessionExpired = false
    /// Shown once after the app picked an instance among several on its own.
    var autoOpenHint: String?
    /// Goes up when a tapped push asks the shell to show Chat.
    private(set) var chatRequest = ChatRequest(serial: 0, topicId: nil)
    /// A tapped push waiting for an instance to open.
    private var pendingPush: PushTarget?

    let cloud: CloudAuth
    let push: PushCenter
    /// Light, dark or automatic, for the whole app; kept across sign-out.
    let appearance = AppearanceSetting()
    /// Keeps the open instance on its latest release.
    let update = InstanceUpdater()
    static let updateCheckHold: Duration = .seconds(1)

    /// The open instance's Web dashboard.
    var webURL: URL? {
        instances.first { $0.id == currentInstanceID }.flatMap { URL(string: $0.origin) }
    }
    private let token = TokenBox()
    private let languageSync = LanguageSync()
    private var refreshing = false
    private var foreground = ForegroundGate()

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
        if environment["ROME_DEMO"] == "many-apps" {
            openDemo(.manyApps)
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
        browserSignIn = nil
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
            take(list)
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
            guard workspace == nil else { return }
            // Offline: the last instance opens with its stored session, so its
            // kept chats show. Without one, sign-in says what went wrong.
            if error as? AuthError == .network, let last = Self.rememberedInstance() {
                instances = [last]
                await connect(to: last)
                return
            }
            signInError = (error as? LocalizedError)?.errorDescription
            phase = .signedOut
        }
    }

    private static func rememberedInstance() -> CloudInstance? {
        guard let data = UserDefaults.standard.data(forKey: Defaults.lastInstanceRecord),
              let instance = try? JSONDecoder().decode(CloudInstance.self, from: data),
              instance.id == UserDefaults.standard.string(forKey: Defaults.lastInstance)
        else { return nil }
        return instance
    }

    /// `keepUpdate`: reaching the instance an upgrade waits on, which keeps the
    /// update page up. Any other connect starts over, so a page left from the
    /// last instance never covers this one.
    private func connect(to instance: CloudInstance, keepUpdate: Bool = false) async {
        if !keepUpdate { update.reset() }
        phase = .connecting(host: instance.host)
        do {
            let session = try await cloud.session(for: instance)
            token.use(session)
            UserDefaults.standard.set(instance.id, forKey: Defaults.lastInstance)
            UserDefaults.standard.set(try? JSONEncoder().encode(instance), forKey: Defaults.lastInstanceRecord)
            currentInstanceID = instance.id
            // Signed in to Rome Cloud: this launch's token, if it has one yet.
            Task { await push.upload() }
            let client = APIClient(origin: URL(string: instance.origin)!, token: { [token] in token.token }, cookieName: { [token] in token.cookieName }) { [weak self] in
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
        } catch AuthError.accessRevoked {
            await lostAccess(to: instance)
        } catch {
            signInError = (error as? LocalizedError)?.errorDescription
            browserSignIn = error as? AuthError == .notOwner ? URL(string: instance.origin) : nil
            phase = .signedOut
        }
    }

    /// Taken off a Rome's allow-list: it leaves the list, and another running
    /// Rome opens with the reason said once; with none, the reason stays.
    private func lostAccess(to instance: CloudInstance) async {
        let reason = AuthError.accessRevoked.errorDescription
        instances.removeAll { $0.id == instance.id }
        if UserDefaults.standard.string(forKey: Defaults.lastInstance) == instance.id {
            UserDefaults.standard.removeObject(forKey: Defaults.lastInstance)
        }
        currentInstanceID = nil
        if let next = instances.first(where: \.isRunning) {
            autoOpenHint = reason
            await connect(to: next)
        } else {
            signInError = reason
            phase = .noInstance
        }
    }

    private func reconnectWhenRunning(_ id: String) async {
        guard let list = try? await cloud.listInstances() else { return }
        take(list)
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
        if let list = try? await cloud.listInstances() { take(list) }
    }

    /// Rome Cloud's list of the account's instances. Drafts of an instance
    /// that is gone go with it.
    private func take(_ list: [CloudInstance]) {
        instances = list
        DraftStore.removeInstances(keeping: Set(list.map(\.host)))
        TranscriptCache.removeInstances(keeping: Set(list.map(\.host)))
    }

    func retry() async {
        signInError = nil
        browserSignIn = nil
        await openInstance(preferring: nil, showHint: false)
    }

    /// The instance open now, as Rome Cloud lists it.
    var currentInstance: CloudInstance? { instances.first { $0.id == currentInstanceID } }

    func signOut() async {
        update.reset()
        workspace?.stop()
        workspace = nil
        token.token = nil
        pendingPush = nil
        await push.signOut { await cloud.signOut() }
        DraftStore.removeAll()
        TranscriptCache.removeAll()
        ImageDiskCache.shared.removeAll()
        UserDefaults.standard.removeObject(forKey: Defaults.lastInstance)
        UserDefaults.standard.removeObject(forKey: Defaults.lastInstanceRecord)
        instances = []
        currentInstanceID = nil
        sessionExpired = false
        browserSignIn = nil
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
                // A visitor's session runs the visitor sign-in again, the guardian's the owner's.
                let session = try await cloud.session(for: instance, forceRefresh: true)
                token.use(session)
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
        syncLanguage()
        // Its own task: the poll that reports the finish is cancelled when the
        // reopened workspace attaches, and would cancel the reopen with it.
        update.onFinished = { [weak self] in Task { await self?.reopenAfterUpgrade() } }
        // Updating the instance is the guardian's call: a visitor never sees the page.
        await workspace.readRole()
        if let id = currentInstanceID, !workspace.isVisitor {
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

    // MARK: Foreground

    func appWillResignActive() {
        foreground.resignedActive(at: .now)
    }

    func appDidEnterBackground() {
        foreground.enteredBackground(at: .now)
        // Drafts are written before the app may be killed.
        if let drafts = workspace?.drafts { Task { await drafts.flush() } }
        workspace?.transcripts.flush()
        sayGoodbye()
    }

    /// Closes the live socket as the app leaves, so the server stops counting
    /// this phone as watching and the reply is pushed. A message still
    /// sending keeps it open until it is through, for at most a few seconds.
    private func sayGoodbye() {
        guard let workspace else { return }
        guard workspace.isSending else {
            workspace.backend.events.pause()
            return
        }
        let hold = BackgroundHold("send-before-goodbye")
        Task { [weak self] in
            for _ in 0..<40 where workspace.isSending {
                try? await Task.sleep(for: .milliseconds(250))
            }
            // Back in front meanwhile: the socket stays.
            if self?.foreground.isInBackground == true { workspace.backend.events.pause() }
            hold.end()
        }
    }

    /// The chat in front of the guardian, by its store's id; nil when a sheet,
    /// the drawer or another page covers it. A push for it shows no banner,
    /// and opening it clears its delivered notifications.
    @ObservationIgnored private var screenChat = ScreenChat()

    /// A view puts its chat in front, for pushes.
    func show(_ chat: String?, by owner: UUID) {
        screenChat.show(chat, by: owner)
        visibleChat = screenChat.chat
    }

    /// A view leaves; a newer view's chat stays.
    func hide(by owner: UUID) {
        screenChat.hide(by: owner)
        visibleChat = screenChat.chat
    }

    private(set) var visibleChat: String? {
        didSet {
            guard visibleChat != oldValue else { return }
            workspace?.backend.events.watch(PushPresentation.serverChat(visibleChat, mainServerID: workspace?.mainChatServerID))
            if let visibleChat { clearDelivered(for: visibleChat) }
        }
    }

    /// Holds the watch again, as the server names the chat now: the main
    /// chat's own id arrives after Chat first shows.
    func rewatch() {
        workspace?.backend.events.watch(PushPresentation.serverChat(visibleChat, mainServerID: workspace?.mainChatServerID))
    }

    /// Whether a push that arrives while the app is open shows its banner.
    func presentsInForeground(_ userInfo: [AnyHashable: Any]) -> Bool {
        PushPresentation.shows(PushTarget(userInfo: userInfo), visibleChat: visibleChat, instanceID: currentInstanceID, mainServerID: workspace?.mainChatServerID)
    }

    private func clearDelivered(for chat: String) {
        let instance = currentInstanceID
        let main = workspace?.mainChatServerID
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered
                .filter { PushPresentation.belongs($0.request.content.userInfo, to: chat, instanceID: instance, mainServerID: main) }
                .map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// Back in front: what the screens show may be behind, whether or not the
    /// app was suspended, so they refetch and the socket starts over.
    func appDidBecomeActive() {
        appearance.apply()
        // Back in front on a chat counts as opening it: its delivered pushes go.
        if let visibleChat { clearDelivered(for: visibleChat) }
        syncLanguage()
        // Notifications turned on in the Settings app register this phone.
        Task { await push.launch() }
        if foreground.becameActive(at: .now) {
            workspace?.backend.events.resume()
        }
    }

    /// The app's language as iOS resolved it, sent to the instance when the
    /// guardian changed it since last time.
    private func syncLanguage() {
        guard let workspace else { return }
        let backend = workspace.backend
        let current = LanguageSync.code(Bundle.main.preferredLocalizations.first)
        Task {
            await languageSync.check(host: workspace.host, current: current, isGuardian: { await backend.isGuardian() }) { code in
                try await backend.setGuardianLanguage(code)
            }
        }
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
            // The same path as the instances page. The push waits again, so
            // the opened instance shows its chat.
            pendingPush = target
            await switchInstance(to: instance)
        case .openConcierge:
            let topic = await topicChat(for: target)
            chatRequest = ChatRequest(serial: chatRequest.serial + 1, topicId: topic)
            // The push is news the chat may not hold yet: the socket can still
            // be reconnecting, or never paused if the tap came over the open app.
            if let topic { workspace?.showLatest(inTopic: topic) } else { workspace?.showLatest() }
        }
    }

    /// The topic chat a push names, when this account has it; otherwise the
    /// main chat (nil). A chat started since the list was read is fetched.
    private func topicChat(for target: PushTarget) async -> String? {
        guard let workspace, let chatId = target.chatId, chatId != conciergeChatID else { return nil }
        var topics = workspace.topics.chats
        if !topics.contains(where: { $0.id == chatId }), let all = try? await workspace.backend.conciergeChats() {
            topics = TopicChatsStore.topics(in: all)
        }
        return PushRoute.topicChat(for: target, topics: topics)
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
            await open(Workspace(backend: backend, instanceName: String(localized: "My Rome"), host: "me.romeos.cc", accountLabel: "lin@example.com", drafts: DraftStore(instance: DraftStore.demoInstance)))
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
        let reply = try? await URLSession(configuration: configuration).data(for: request)
        let drafts = DraftStore(instance: DraftStore.localInstance(url.host() ?? origin))
        if let http = reply?.1 as? HTTPURLResponse,
           let cookie = http.value(forHTTPHeaderField: "Set-Cookie"),
           let value = cookie.components(separatedBy: ";").first?.components(separatedBy: "rome_session=").last {
            token.token = value
        } else if reply == nil, TranscriptCache(instance: drafts.instance).mainChat() != nil {
            // Unreachable, as the cloud path is offline: open on the kept chats.
            token.token = nil
        } else {
            signInError = String(localized: "Could not reach the local Rome")
            phase = .signedOut
            return
        }
        let local = CloudInstance(id: "local", name: String(localized: "Local Rome"), slug: "local", origin: origin, status: "running")
        instances = [local]
        currentInstanceID = local.id
        let client = APIClient(origin: url, token: { [token] in token.token })
        await open(Workspace(backend: LiveBackend(client: client), instanceName: String(localized: "Local Rome"), host: url.host() ?? origin, accountLabel: user, drafts: drafts))
    }
    #endif
}
