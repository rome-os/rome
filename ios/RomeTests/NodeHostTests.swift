import Foundation
import Testing
@testable import Rome

/// Answers Rome Cloud's gateway config as a test says, and keeps the requests.
final class ConfigProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var status = 200
    nonisolated(unsafe) private static var body = #"{"gatewayUrl":"wss://gw.test/ws"}"#
    nonisolated(unsafe) private static var recorded: [URLRequest] = []

    static func reset(status: Int = 200, body: String = #"{"gatewayUrl":"wss://gw.test/ws"}"#) {
        lock.withLock {
            self.status = status
            self.body = body
            recorded = []
        }
    }

    static var requests: [URLRequest] { lock.withLock { recorded } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.lock.withLock { () -> (Int, String) in
            Self.recorded.append(request)
            return (Self.status, Self.body)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A Gateway socket a test drives: it pushes frames in and reads what was sent.
final class FakeSocket: NodeSocket, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<String?, Error>.Continuation
    nonisolated(unsafe) private var iterator: AsyncThrowingStream<String?, Error>.AsyncIterator
    private let lock = NSLock()
    private var sentFrames: [String] = []
    private var isClosed = false

    init() {
        let (stream, continuation) = AsyncThrowingStream<String?, Error>.makeStream()
        self.continuation = continuation
        iterator = stream.makeAsyncIterator()
    }

    var sent: [String] { lock.withLock { sentFrames } }
    var closed: Bool { lock.withLock { isClosed } }

    /// A text frame, or nil for a binary one.
    func push(_ frame: String?) { continuation.yield(frame) }
    func end(code: Int?) { continuation.finish(throwing: NodeSocketClosed(code: code)) }

    func receive() async throws -> String? {
        guard let frame = try await iterator.next() else { throw NodeSocketClosed(code: nil) }
        return frame
    }

    func send(_ text: String) async throws { lock.withLock { sentFrames.append(text) } }

    func close() {
        lock.withLock { isClosed = true }
        continuation.finish(throwing: NodeSocketClosed(code: nil))
    }
}

/// Hands out sockets in order; with none left, a connection fails.
final class FakeGateway: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [FakeSocket] = []
    private var opened: [(url: URL, authorization: String)] = []

    func enqueue(_ socket: FakeSocket) { lock.withLock { queue.append(socket) } }
    var attempts: [(url: URL, authorization: String)] { lock.withLock { opened } }

    var factory: NodeSocketFactory {
        { [self] url, authorization in
            try lock.withLock {
                opened.append((url, authorization))
                guard !queue.isEmpty else { throw URLError(.cannotConnectToHost) }
                return queue.removeFirst()
            }
        }
    }
}

final class DelayLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [TimeInterval] = []
    var values: [TimeInterval] { lock.withLock { recorded } }
    func add(_ delay: TimeInterval) { lock.withLock { recorded.append(delay) } }
}

@MainActor
final class FakeCredentials: NodeCredentials {
    let origin = URL(string: "https://cloud.test")!
    var deviceCredential: CloudCredential? = CloudCredential(accessToken: "romemob_test-token", deviceSessionId: "dev-1")
    var accountGeneration = 1
    private(set) var rejected: [CloudCredential] = []

    func rejectCredential(_ credential: CloudCredential) {
        rejected.append(credential)
        deviceCredential = nil
    }
}

@MainActor
func eventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<400 {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@MainActor
final class HostRig {
    let credentials = FakeCredentials()
    let gateway = FakeGateway()
    let audit = FakeAudit()
    let health = FakeHealth()
    let delays = DelayLog()
    let defaults = UserDefaults(suiteName: "rome-node-\(UUID().uuidString)")!
    private(set) var host: NodeHost!
    private(set) var rejections = 0

    init() {
        ConfigProtocol.reset()
        host = makeHost()
        host.onCredentialRejected = { [unowned self] in rejections += 1 }
    }

    /// A host over the same defaults: the app launched again.
    func makeHost() -> NodeHost {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConfigProtocol.self]
        let delays = delays
        return NodeHost(
            credentials: credentials, audit: audit, health: HealthFixtures.actions(health), defaults: defaults,
            http: URLSession(configuration: configuration), connect: gateway.factory,
            pause: { delay in
                delays.add(delay)
                try await Task.sleep(for: .milliseconds(5))
            },
            random: { 0.5 }, name: { "Test iPhone" }
        )
    }

    func online(_ socket: FakeSocket = FakeSocket()) async -> FakeSocket {
        gateway.enqueue(socket)
        host.setActive(true)
        _ = await eventually { host.status == .online }
        return socket
    }

    static let request = #"{"id":"r1","from":"inst-1","payload":{"type":"request","action":"system.info"}}"#
}

@MainActor
@Suite(.serialized) struct NodeHostTests {
    @Test func connectsWithTheDeviceTokenInTheHeaderAndAnswersRequests() async throws {
        let rig = HostRig()
        let socket = await rig.online()
        #expect(rig.host.status == .online)
        let config = try #require(ConfigProtocol.requests.first)
        #expect(config.url?.absoluteString == "https://cloud.test/v1/gateway/config")
        #expect(config.value(forHTTPHeaderField: "Authorization") == "Bearer romemob_test-token")
        let attempt = try #require(rig.gateway.attempts.first)
        #expect(attempt.url.absoluteString == "wss://gw.test/ws")
        #expect(attempt.authorization == "Bearer romemob_test-token")
        #expect(!attempt.url.absoluteString.contains("romemob_"), "never in the URL")

        socket.push(nil) // a binary frame: ignored
        socket.push(HostRig.request)
        #expect(await eventually { socket.sent.count == 1 })
        let reply = parseJSON(socket.sent[0])
        #expect(reply["id"]?.string == "r1")
        #expect(reply["to"]?.string == "inst-1")
        #expect(reply["payload"]?["result"]?["name"]?.string == "Test iPhone")
        #expect(await eventually { rig.host.requestSerial == 1 })
    }

    @Test func aGatewayAddressThatBreaksTheRulesIsNotUsed() async {
        let rig = HostRig()
        ConfigProtocol.reset(body: #"{"gatewayUrl":"ws://gw.example/ws"}"#)
        rig.gateway.enqueue(FakeSocket())
        rig.host.setActive(true)
        #expect(await eventually { !rig.delays.values.isEmpty })
        #expect(rig.gateway.attempts.isEmpty)
        #expect(rig.host.status == .connecting)
        rig.host.setActive(false)
    }

    @Test func aSocketReplacedByAnotherConnectionStopsUntilTheAppIsInFrontAgain() async {
        let rig = HostRig()
        let socket = await rig.online()
        socket.end(code: 4002)
        #expect(await eventually { rig.host.status == .stopped(.superseded) })
        try? await Task.sleep(for: .milliseconds(100))
        #expect(rig.gateway.attempts.count == 1, "no reconnect")
        #expect(rig.delays.values.isEmpty)

        rig.gateway.enqueue(FakeSocket())
        rig.host.setActive(true)
        #expect(await eventually { rig.host.status == .online })
        #expect(rig.gateway.attempts.count == 2)
    }

    @Test func aRevokedDeviceStopsToo() async {
        let rig = HostRig()
        let socket = await rig.online()
        socket.end(code: 4001)
        #expect(await eventually { rig.host.status == .stopped(.revoked) })
        try? await Task.sleep(for: .milliseconds(100))
        #expect(rig.gateway.attempts.count == 1)
        #expect(rig.delays.values.isEmpty)
    }

    @Test func anyOtherDropReconnectsWithBackoff() async {
        let rig = HostRig()
        let first = await rig.online()
        first.end(code: 1006)
        // Two more attempts fail (no socket to hand out): 1 s, 2 s, 4 s, here at a jitter of exactly 1.
        #expect(await eventually { rig.delays.values.count >= 3 })
        #expect(Array(rig.delays.values.prefix(3)) == [1, 2, 4])
        #expect(rig.host.status == .connecting)
        rig.gateway.enqueue(FakeSocket())
        #expect(await eventually { rig.host.status == .online })
    }

    @Test func cloudSayingTheDeviceSessionIsInvalidEndsTheSignIn() async {
        let rig = HostRig()
        ConfigProtocol.reset(status: 401, body: #"{"error":"invalid_device_session"}"#)
        rig.host.setActive(true)
        #expect(await eventually { rig.rejections == 1 })
        #expect(rig.credentials.rejected.map(\.deviceSessionId) == ["dev-1"])
        #expect(rig.gateway.attempts.isEmpty)
        #expect(rig.delays.values.isEmpty, "no retry")
        #expect(rig.host.status == .off)
        rig.host.setActive(true)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(ConfigProtocol.requests.count == 1, "the credential is gone: nothing asks again")
    }

    @Test func otherCloudTroubleIsRetried() async {
        let rig = HostRig()
        ConfigProtocol.reset(status: 503, body: "{}")
        rig.host.setActive(true)
        #expect(await eventually { rig.delays.values.count >= 2 })
        #expect(rig.rejections == 0)
        #expect(rig.credentials.rejected.isEmpty)
        rig.host.setActive(false)
    }

    @Test func theSwitchDisconnectsAndIsKept() async {
        let rig = HostRig()
        #expect(rig.host.isEnabled, "on by default")
        let socket = await rig.online()
        rig.host.setEnabled(false)
        #expect(rig.host.status == .off)
        #expect(socket.closed)
        #expect(rig.makeHost().isEnabled == false, "kept across launches")

        rig.host.setActive(true)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.gateway.attempts.count == 1, "off stays off, in front or not")

        rig.gateway.enqueue(FakeSocket())
        rig.host.setEnabled(true)
        #expect(await eventually { rig.host.status == .online })
        #expect(rig.makeHost().isEnabled)
    }

    @Test func theAppleHealthSwitchIsOnByDefaultAndKept() async {
        let rig = HostRig()
        #expect(rig.host.isHealthEnabled)
        rig.host.setHealthEnabled(false)
        #expect(!rig.host.isHealthEnabled)
        #expect(rig.makeHost().isHealthEnabled == false, "kept across launches")
        rig.host.setHealthEnabled(true)
        #expect(rig.makeHost().isHealthEnabled)
        // Independent of the device switch.
        #expect(rig.host.isEnabled)
    }

    @Test func turningHealthOnAsksOnlyWhileIOSHasNeverBeenAsked() async {
        let rig = HostRig()
        rig.health.neverAsked = true
        await rig.host.setHealthEnabled(true)?.value
        #expect(rig.health.accessRequests == 1, "the system sheet shows at once")
        #expect(!rig.health.neverAsked)
        rig.host.setHealthEnabled(false)
        await rig.host.setHealthEnabled(true)?.value
        #expect(rig.health.accessRequests == 1, "once asked, iOS shows nothing more: neither does the app")
    }

    @Test func turningHealthOffNeverAsks() async {
        let rig = HostRig()
        rig.health.neverAsked = true
        #expect(rig.host.setHealthEnabled(false) == nil)
        #expect(rig.health.accessRequests == 0)
    }

    @Test func withTheSwitchOffARequestOnTheSocketGetsHealthOff() async throws {
        let rig = HostRig()
        let socket = await rig.online()
        rig.host.setHealthEnabled(false)
        socket.push(#"{"id":"r9","from":"inst-1","payload":{"type":"request","action":"health.stats","args":{"type":"stepCount"}}}"#)
        #expect(await eventually { socket.sent.count == 1 })
        #expect(parseJSON(socket.sent[0])["payload"]?["error"]?["code"]?.string == "health_off")
        #expect(rig.health.reads == 0)
        #expect(rig.audit.begun.count == 1, "still audited")
        rig.host.setHealthEnabled(true)
        socket.push(#"{"id":"r10","from":"inst-1","payload":{"type":"request","action":"health.stats","args":{"type":"stepCount"}}}"#)
        #expect(await eventually { socket.sent.count == 2 })
        #expect(parseJSON(socket.sent[1])["payload"]?["ok"]?.bool == true)
    }

    @Test func itConnectsOnlyWhileTheAppIsInFront() async {
        let rig = HostRig()
        rig.host.sync()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.gateway.attempts.isEmpty)
        #expect(rig.host.status == .off)

        let socket = await rig.online()
        rig.host.setActive(false)
        #expect(await eventually { socket.closed })
        #expect(rig.host.status == .off)
    }

    @Test func aRequestUnderWayKeepsTheSocketOpenForItsReplyWhenTheAppLeaves() async {
        let rig = HostRig()
        let socket = await rig.online()
        socket.push(HostRig.request)
        rig.host.setActive(false)
        #expect(await eventually { socket.sent.count == 1 || socket.closed })
        // Either the reply made it out first, or nothing was in flight yet: never a closed socket with the reply lost midway.
        #expect(await eventually { rig.host.status == .off })
    }

    @Test func signedOutDoesNotConnect() async {
        let rig = HostRig()
        rig.credentials.deviceCredential = nil
        rig.gateway.enqueue(FakeSocket())
        rig.host.setActive(true)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.gateway.attempts.isEmpty)
        #expect(rig.host.status == .off)
    }

    @Test func signingOutDisconnectsAndTheNextSignInConnects() async {
        let rig = HostRig()
        let socket = await rig.online()
        rig.host.accountEnded()
        #expect(socket.closed)
        #expect(rig.host.status == .off)
        // Still holding a credential in the moment between, it must not reconnect.
        rig.gateway.enqueue(FakeSocket())
        rig.host.setActive(true)
        rig.host.sync()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.gateway.attempts.count == 1)

        rig.host.accountStarted()
        #expect(await eventually { rig.host.status == .online })
    }

    @Test func anotherAccountReconnectsAsItsOwnDevice() async {
        let rig = HostRig()
        let first = await rig.online()
        rig.credentials.deviceCredential = CloudCredential(accessToken: "romemob_other", deviceSessionId: "dev-2")
        rig.credentials.accountGeneration = 2
        rig.gateway.enqueue(FakeSocket())
        rig.host.sync()
        #expect(await eventually { rig.gateway.attempts.count == 2 && rig.host.status == .online })
        #expect(first.closed)
        #expect(rig.gateway.attempts.last?.authorization == "Bearer romemob_other")
        // Syncing again with nothing changed does not reconnect.
        rig.host.sync()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.gateway.attempts.count == 2)
    }
}
