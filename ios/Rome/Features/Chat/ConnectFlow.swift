import AuthenticationServices
import Foundation
import UIKit

// A connect card's client side, as the web dashboard's `lib/connect-card.ts`
// runs it: read the Concierge's connector list again, start the service's
// connection from the entry it gives now, send the guardian where they
// connect it, then watch the list until the service works. Every service
// difference comes from the entry.

/// A call on this Rome: whether it answered 2xx, and its JSON body.
struct ConnectReply: Sendable {
    let ok: Bool
    let body: JSONValue
}

/// One service in `GET /api/concierge/connectors`, as a connect card reads it.
struct ConnectorState: Sendable, Equatable {
    let service: String
    /// `working`, `broken`, or nil when not connected.
    let state: String?
    let account: String?
    let connect: MessagePart.ConnectEntry?

    var working: Bool { state == "working" }

    init(service: String, state: String?, account: String? = nil, connect: MessagePart.ConnectEntry? = nil) {
        self.service = service
        self.state = state
        self.account = account
        self.connect = connect
    }

    init?(json value: JSONValue) {
        guard let service = value["service"]?.string else { return nil }
        self.service = service
        state = value["state"]?.string
        account = value["account"]?.string
        connect = value["connect"].flatMap { $0 == .null ? nil : MessagePart.ConnectEntry(json: $0) }
    }
}

/// What a connect card shows.
enum ConnectPhase: Equatable, Sendable {
    case idle
    case connecting
    case connected(account: String?)
    /// A reason to show, or nil for "Not connected yet".
    case failed(String?)
}

/// Where the guardian finishes connecting: a browser over the app.
@MainActor
protocol ConnectBrowser: AnyObject {
    /// Shows `url`, replacing a page already shown.
    func open(_ url: URL)
    func close()
}

/// The web's timings: a check every 2.5 seconds, about two minutes in all.
enum ConnectTiming {
    static let interval: Duration = .milliseconds(2500)
    static let attempts = 48
    static let signInPoll: Duration = .seconds(1)
}

/// Runs one connect, from a card's tap to Connected or a reason.
@MainActor
struct ConnectRunner {
    let backend: RomeBackend
    let browser: ConnectBrowser
    /// The dashboard's page, for an entry that only the dashboard can start.
    let openDashboard: (URL) -> Void
    /// The instance's web origin, for the dashboard and relative links.
    let origin: URL?
    var sleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    var interval = ConnectTiming.interval
    var attempts = ConnectTiming.attempts

    /// Where a connect entry that needs the guardian's own page sends them.
    static let settingsConnectionsPath = "/settings/connections"

    enum Failure: Error, Equatable {
        case reason(String)
    }

    /// Starts connecting `service` and waits until it works. Tells Chat in
    /// `chatId` once it does, so it goes on without the guardian typing.
    func run(service: String, chatId: String?) async -> ConnectPhase {
        defer { browser.close() }
        do {
            guard let fresh = await readConnector(service) else {
                return .failed(String(localized: "Could not check the connection"))
            }
            if fresh.working {
                await tell(chatId, service)
                return .connected(account: fresh.account)
            }
            // The saved entry only draws the card: a sign-in done since must not be undone.
            let connectedAlready = try await start(fresh.connect ?? .dashboard)
            if connectedAlready {
                await tell(chatId, service)
                return .connected(account: await readConnector(service)?.account)
            }
            for _ in 0..<attempts {
                await sleep(interval)
                if Task.isCancelled { return .idle }
                if let now = await readConnector(service), now.working {
                    await tell(chatId, service)
                    return .connected(account: now.account)
                }
            }
            return .failed(nil)
        } catch Failure.reason(let reason) {
            return .failed(reason)
        } catch {
            return .failed(nil)
        }
    }

    /// The connector list's entry for `service` now, or nil when the list cannot be read or has none.
    func readConnector(_ service: String) async -> ConnectorState? {
        guard let list = try? await backend.connectors() else { return nil }
        return list.first { $0.service == service }
    }

    /// Sends the guardian where they connect. True when the service turns out
    /// connected already.
    private func start(_ entry: MessagePart.ConnectEntry) async throws -> Bool {
        switch entry {
        case .romeOAuth(let url, let available, let reason):
            guard available, let link = Self.webURL(url, origin: origin) else {
                throw Failure.reason(reason ?? String(localized: "Cannot be connected here"))
            }
            browser.open(link)
            return false
        case .composio(let method, let path, let body, let needsLogin, let login):
            if needsLogin {
                guard let login else { throw Failure.reason(String(localized: "This sign-in cannot start here")) }
                try await signIn(method: login.method, path: login.path)
            }
            guard let apiPath = Self.apiPath(path) else {
                throw Failure.reason(String(localized: "This connection cannot start here"))
            }
            let started = try await backend.connectCall(method: method, apiPath: apiPath, body: body)
            if started.body["alreadyConnected"]?.bool == true { return true }
            guard started.ok, let link = Self.linkOf(started.body, origin: origin) else {
                throw Failure.reason(Self.errorOf(started.body, fallback: String(localized: "Connection did not start")))
            }
            browser.open(link)
            return false
        case .dashboard:
            if let origin { openDashboard(origin.appending(path: String(Self.settingsConnectionsPath.dropFirst()))) }
            return false
        }
    }

    /// Signs in to the service's broker first. The sign-in answers a link and a
    /// key; the completion call waits for the guardian to finish, so it is asked
    /// again while it says they have not.
    private func signIn(method: String, path: String) async throws {
        guard let start = Self.apiPath(path) else { throw Failure.reason(String(localized: "This sign-in cannot start here")) }
        let started = try await backend.connectCall(method: method, apiPath: start, body: nil)
        guard started.ok, let link = Self.linkOf(started.body, origin: origin) else {
            throw Failure.reason(Self.errorOf(started.body, fallback: String(localized: "Sign-in did not start")))
        }
        browser.open(link)
        guard let cliKey = started.body["cliKey"]?.string else { return }
        let complete = start.hasSuffix("/start") ? String(start.dropLast("/start".count)) + "/complete" : start
        // As long as the whole wait for the service, as on the web.
        let rounds = Int((Double(attempts) * interval.seconds) / max(ConnectTiming.signInPoll.seconds, 0.001))
        for _ in 0..<max(rounds, 1) {
            if Task.isCancelled { throw CancellationError() }
            let done = try await backend.connectCall(method: "POST", apiPath: complete, body: .object(["cliKey": .string(cliKey)]))
            if done.ok { return }
            guard done.body["error"]?.string == "login_not_authorized" else {
                throw Failure.reason(Self.errorOf(done.body, fallback: String(localized: "Sign-in failed")))
            }
            await sleep(ConnectTiming.signInPoll)
        }
        throw Failure.reason(String(localized: "Sign-in timed out"))
    }

    private func tell(_ chatId: String?, _ service: String) async {
        guard let chatId else { return }
        await backend.notifyServiceConnected(chatId: chatId, service: service)
    }

    // MARK: Rules

    /// A link the card may open: a web address on http or https, never a
    /// script. A relative one is on the instance.
    nonisolated static func webURL(_ value: String?, origin: URL?) -> URL? {
        guard let value, !value.isEmpty else { return nil }
        let url = URL(string: value).flatMap { $0.scheme == nil ? origin.flatMap { origin in URL(string: value, relativeTo: origin)?.absoluteURL } : $0 }
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host() != nil else { return nil }
        return url
    }

    /// A path on this Rome's own API, the only place a card calls.
    nonisolated static func apiPath(_ value: String?) -> String? {
        guard let value, value.hasPrefix("/api/"), !value.contains(".."), !value.contains("//"), !value.contains("\\") else { return nil }
        return value
    }

    /// The link a start call answers: the connector app says `authorizationUrl`, the entry's contract `redirectUrl`.
    nonisolated static func linkOf(_ body: JSONValue, origin: URL?) -> URL? {
        let raw = body["authorizationUrl"]?.string ?? body["redirectUrl"]?.string ?? body["loginUrl"]?.string
        return webURL(raw, origin: origin)
    }

    nonisolated static func errorOf(_ body: JSONValue, fallback: String) -> String {
        if let message = body["message"]?.string, !message.isEmpty { return message }
        return fallback
    }
}

private extension Duration {
    var seconds: Double {
        let parts = components
        return Double(parts.seconds) + Double(parts.attoseconds) / 1e18
    }
}

/// The system's web sign-in sheet over the app. Not ephemeral, so a sign-in
/// the guardian already has in Safari (Google, GitHub) is reused. It never
/// carries the instance's session: only Rome Cloud's or the service's pages.
@MainActor
final class WebSignInBrowser: NSObject, ConnectBrowser, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL) {
        session?.cancel()
        // The flows end on Rome Cloud's or the service's own page, not on a link
        // back to the app: the card watches the connector list and closes this.
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { _, _ in }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        session.start()
    }

    func close() {
        session?.cancel()
        session = nil
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
