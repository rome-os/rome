import Foundation
import Testing
@testable import Rome

/// Records each request and answers 200.
final class OriginRecorder: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { recorded } }
    static func reset() { lock.withLock { recorded = [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.withLock { Self.recorded.append(request) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// The instance takes a change on its guarded routes (approvals,
/// connections) only from its own origin, which a native request never sends.
@Suite(.serialized) struct RequestOriginTests {
    @Test func everyInstanceRequestSendsTheInstancesOrigin() async throws {
        OriginRecorder.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OriginRecorder.self]
        let client = APIClient(origin: URL(string: "http://127.0.0.1:4141")!, token: { "t" }, configuration: configuration)
        _ = try await client.post("/approvals/a-1/approve", json: .object([:]))
        _ = try await client.getData("/apps")
        _ = try await client.exchange(method: "POST", apiPath: "/api/connections/x", json: nil)
        let requests = OriginRecorder.requests
        #expect(requests.count == 3)
        #expect(requests.first?.httpMethod == "POST")
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:4141" })
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == "rome_session=t" })
    }

    @Test func aStoreAppsCardCallKeepsItsScopedIdAsOneSegment() async throws {
        OriginRecorder.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OriginRecorder.self]
        let client = APIClient(origin: URL(string: "http://127.0.0.1:4141")!, token: { "t" }, configuration: configuration)
        let path = try #require(WidgetPaths.appAPIPath(appId: "@alice/meals", path: "water"))
        _ = try await client.exchange(method: "POST", apiPath: path, json: .object([:]))
        #expect(OriginRecorder.requests.first?.url?.absoluteString == "http://127.0.0.1:4141/api/apps/@alice%2Fmeals/water")
    }
}
