import Foundation
import Testing
@testable import Rome

func parseJSON(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

@Suite struct NodeEnvelopeTests {
    @Test func readsARequest() throws {
        let request = try #require(NodeProtocol.request(in: #"{"id":"r1","from":"inst-1","payload":{"type":"request","action":"health.stats","args":{"types":["stepCount"]}}}"#))
        #expect(request.id == "r1")
        #expect(request.from == "inst-1")
        #expect(request.action == "health.stats")
        #expect(request.args == parseJSON(#"{"types":["stepCount"]}"#))
    }

    @Test func argsAreOptional() throws {
        let request = try #require(NodeProtocol.request(in: #"{"id":"r1","from":"a","payload":{"type":"request","action":"system.info"}}"#))
        #expect(request.args == nil)
    }

    @Test func ignoresWhatIsNotARequest() {
        let texts = [
            "not json",
            #"[1,2]"#,
            #"{"id":"r1","type":"error","code":"target_unavailable"}"#,
            #"{"id":"r1","from":"a","payload":{"type":"response","ok":true,"result":1}}"#,
            #"{"id":"r1","from":"a","payload":"request"}"#,
            #"{"id":"r1","from":"a","payload":{"type":"request"}}"#,
            #"{"id":"r1","from":"a","payload":{"type":"request","action":7}}"#,
            #"{"id":"r1","payload":{"type":"request","action":"system.info"}}"#,
            #"{"from":"a","payload":{"type":"request","action":"system.info"}}"#,
        ]
        for text in texts { #expect(NodeProtocol.request(in: text) == nil, "\(text)") }
    }

    @Test func idsFollowTheGatewaysRules() {
        #expect(NodeProtocol.isValidID("abc-123"))
        #expect(NodeProtocol.isValidID(String(repeating: "a", count: 128)))
        #expect(!NodeProtocol.isValidID(""))
        #expect(!NodeProtocol.isValidID(String(repeating: "a", count: 129)))
        #expect(!NodeProtocol.isValidID("a b"))
        #expect(!NodeProtocol.isValidID("a\nb"))
        #expect(NodeProtocol.request(in: #"{"id":"a b","from":"x","payload":{"type":"request","action":"system.info"}}"#) == nil)
    }

    @Test func repliesWithTheResultToTheSender() throws {
        let request = NodeRequest(id: "r1", from: "inst-1", action: "x", args: nil)
        let text = NodeProtocol.reply(to: request, .ok(.object(["steps": .number(5)]), count: 1))
        #expect(parseJSON(text) == parseJSON(#"{"id":"r1","to":"inst-1","payload":{"type":"response","ok":true,"result":{"steps":5}}}"#))
    }

    @Test func repliesWithTheError() {
        let request = NodeRequest(id: "r2", from: "inst-1", action: "x", args: nil)
        let text = NodeProtocol.reply(to: request, .failed(code: "invalid_args", message: "No."))
        #expect(parseJSON(text) == parseJSON(#"{"id":"r2","to":"inst-1","payload":{"type":"response","ok":false,"error":{"code":"invalid_args","message":"No."}}}"#))
    }
}

@Suite struct GatewayURLTests {
    @Test func acceptsWSS() {
        #expect(GatewayURL.parse("wss://gateway.romeos.cc/ws")?.absoluteString == "wss://gateway.romeos.cc/ws")
        #expect(GatewayURL.parse("wss://gw.example:8443/a/b") != nil)
    }

    @Test func acceptsWSOnlyToThisMac() {
        #expect(GatewayURL.parse("ws://localhost:8787/ws") != nil)
        #expect(GatewayURL.parse("ws://127.0.0.1:8787/ws") != nil)
        #expect(GatewayURL.parse("ws://[::1]:8787/ws") != nil)
        #expect(GatewayURL.parse("ws://gateway.romeos.cc/ws") == nil)
        #expect(GatewayURL.parse("ws://localhost.evil.example/ws") == nil)
        #expect(GatewayURL.parse("ws://192.168.1.5:8787/ws") == nil)
    }

    @Test func refusesCredentialsQueryAndFragment() {
        #expect(GatewayURL.parse("wss://user:pw@gw.example/ws") == nil)
        #expect(GatewayURL.parse("wss://user@gw.example/ws") == nil)
        #expect(GatewayURL.parse("wss://gw.example/ws?token=abc") == nil)
        #expect(GatewayURL.parse("wss://gw.example/ws#frag") == nil)
    }

    @Test func refusesOtherSchemesAndJunk() {
        #expect(GatewayURL.parse("https://gw.example/ws") == nil)
        #expect(GatewayURL.parse("http://localhost/ws") == nil)
        #expect(GatewayURL.parse("wss://") == nil)
        #expect(GatewayURL.parse("") == nil)
        #expect(GatewayURL.parse("gw.example") == nil)
    }
}

@Suite struct NodeBackoffTests {
    @Test func doublesFromOneSecondToAMinute() {
        let delays = (0..<9).map { NodeBackoff.delay(attempt: $0, random: 0.5) }
        #expect(delays == [1, 2, 4, 8, 16, 32, 60, 60, 60])
    }

    @Test func scattersByAQuarterEitherWay() {
        #expect(NodeBackoff.delay(attempt: 2, random: 0) == 3)
        #expect(abs(NodeBackoff.delay(attempt: 2, random: 0.999999) - 5) < 0.001)
        #expect(NodeBackoff.delay(attempt: 20, random: 0.5) == 60)
    }

    @Test func revokedAndReplacedStopTheRest() {
        #expect(NodeClose.decision(for: 4001) == .stop(.revoked))
        #expect(NodeClose.decision(for: 4002) == .stop(.superseded))
        for code in [1000, 1001, 1006, 1008, 1009, 4003, 4004, nil] as [Int?] {
            #expect(NodeClose.decision(for: code) == .reconnect, "\(String(describing: code))")
        }
    }
}
