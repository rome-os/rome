import Foundation
import Testing
@testable import Rome

/// Runs against a Rome on this machine when `ROME_LOCAL_ORIGIN`, `ROME_LOCAL_USER`
/// and `ROME_LOCAL_PASSWORD` are set (pass them as `TEST_RUNNER_…` to xcodebuild).
/// It signs in with a local test guardian, reads every surface the app reads,
/// and sends one message to the Concierge to see its reply arrive on the socket.
enum LocalRome {
    static var environment: [String: String] { ProcessInfo.processInfo.environment }
    static var configured: Bool {
        environment["ROME_LOCAL_ORIGIN"] != nil && environment["ROME_LOCAL_USER"] != nil && environment["ROME_LOCAL_PASSWORD"] != nil
    }
}

@MainActor
@Suite(.serialized, .enabled(if: LocalRome.configured))
struct LiveIntegrationTests {
    nonisolated static var environment: [String: String] { LocalRome.environment }

    private func backend() async throws -> LiveBackend {
        let origin = URL(string: Self.environment["ROME_LOCAL_ORIGIN"]!)!
        var request = URLRequest(url: origin.appending(path: "api/auth/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([
            "userId": Self.environment["ROME_LOCAL_USER"]!,
            "password": Self.environment["ROME_LOCAL_PASSWORD"]!,
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let (_, response) = try await URLSession(configuration: configuration).data(for: request)
        let cookie = try #require((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Set-Cookie"))
        let token = try #require(cookie.components(separatedBy: ";").first?.components(separatedBy: "rome_session=").last)
        let box = TokenBox()
        box.token = token
        return LiveBackend(client: APIClient(origin: origin, token: { box.token }))
    }

    @Test func readsEverySurface() async throws {
        let backend = try await backend()
        let concierge = try await backend.conciergeSession()
        #expect(concierge.id == "concierge")
        _ = try await backend.messages(sessionId: concierge.id, before: nil, limit: 20)
        _ = try await backend.tasks()
        _ = try await backend.sessions()
        _ = try await backend.activeTurns(sessionId: concierge.id)
        let tools = try await backend.aiTools()
        #expect(tools.claude != nil || tools.codex != nil)
        _ = try await backend.routines()
        #expect(try await backend.me() != nil)
        _ = try await backend.search("hello")
    }

    @Test(.timeLimit(.minutes(4))) func conciergeReplyArrivesOnTheSocket() async throws {
        let backend = try await backend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.start()
        try await waitUntil(seconds: 15) { store.loaded }
        let before = store.messages.filter { !$0.isUser && !$0.isTrace }.count

        #expect(store.send("这是一条来自 iOS 集成测试的消息。请只回复两个字：收到。"))
        try await waitUntil(seconds: 30) { store.pending.isEmpty }
        try await waitUntil(seconds: 200) {
            store.messages.filter { !$0.isUser && !$0.isTrace }.count > before && !store.running
        }
        store.stop()
    }

    private func waitUntil(seconds: Double, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline {
                Issue.record("Timed out after \(seconds)s")
                return
            }
            try await Task.sleep(for: .milliseconds(250))
        }
    }
}
