import A2UICore
import Foundation
import Testing
@testable import Rome

/// The share-location card: Share reads the phone's position and sends it
/// with the event; core decides what the event means.
@MainActor @Suite struct LocationCardTests {
    private final class StubLocator: DeviceLocating {
        let result: Result<SharedPosition, LocationFailure>
        var reads = 0
        init(_ result: Result<SharedPosition, LocationFailure>) { self.result = result }
        func currentPosition() async -> Result<SharedPosition, LocationFailure> {
            reads += 1
            return result
        }
    }

    private func card() throws -> WidgetUIPart {
        let parsed = MessagePart.parse(JSONValue.array([DemoBackend.locationCard("l1", reason: "To find coffee near you")]).prettyText)
        guard case .widgetUI(let part) = parsed.first else { throw CardError.notACard }
        return part
    }

    private enum CardError: Error { case notACard }

    private func surface(_ locator: StubLocator, sent: Box<[JSONValue]>) async throws -> WidgetSurface {
        let surface = WidgetSurface()
        surface.locator = locator
        surface.show(try card(), call: { _, _, _ in throw APIError.notFound }, press: { name, context in
            sent.value.append(.object(["name": .string(name), "context": context]))
            return WidgetEventReply(answered: true)
        })
        await surface.load()
        return surface
    }

    private func press(_ id: String, on surface: WidgetSurface) {
        func find(_ node: Node?) -> Node? {
            guard let node else { return nil }
            if node.id == id { return node }
            for kid in node.children(for: "children") + [node.child(for: "child")].compactMap({ $0 }) {
                if let found = find(kid) { return found }
            }
            return nil
        }
        find(surface.viewModel?.rootNode)?.action(for: "action", userActivation: true)?()
    }

    @Test func theCardIsKnownByItsShareEvent() throws {
        let part = try card()
        #expect(part.waits && part.isDrawable)
        #expect(LocationCard.isLocationCard(part))
        #expect(!LocationCard.isLocationCard(try #require(WidgetUIPart(json: DemoBackend.mealCard))))
    }

    @Test func shareSendsThePositionWithTheEvent() async throws {
        let fix = SharedPosition(latitude: 31.23, longitude: 121.47, accuracy: 18, takenAt: Date(timeIntervalSince1970: 1_800_000_000))
        let locator = StubLocator(.success(fix))
        let sent = Box<[JSONValue]>([])
        let surface = try await surface(locator, sent: sent)
        #expect(locator.reads == 0)
        press("share", on: surface)
        for _ in 0..<50 where sent.value.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.value.first?["name"]?.string == "share-location")
        let context = sent.value.first?["context"]
        #expect(context?["latitude"]?.number == 31.23)
        #expect(context?["longitude"]?.number == 121.47)
        #expect(context?["accuracy"]?.number == 18)
        #expect(context?["timestamp"]?.number == 1_800_000_000_000)
        #expect(surface.sent)
    }

    @Test func aRefusedPositionSendsNothingAndSaysWhy() async throws {
        let sent = Box<[JSONValue]>([])
        let surface = try await surface(StubLocator(.failure(.denied)), sent: sent)
        press("share", on: surface)
        for _ in 0..<50 where !surface.sendFailed { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.value.isEmpty)
        #expect(surface.refusal == LocationCard.failureText(.denied))
        #expect(!surface.sent)
    }

    @Test func notNowSendsNoPosition() async throws {
        let locator = StubLocator(.failure(.unavailable))
        let sent = Box<[JSONValue]>([])
        let surface = try await surface(locator, sent: sent)
        press("decline", on: surface)
        for _ in 0..<50 where sent.value.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.value.first?["name"]?.string == "decline")
        #expect(locator.reads == 0)
    }

    @Test func anAnsweredCardSaysHowItEnded() {
        let shared: JSONValue = .object(["status": .string("shared"), "accuracyMeters": .number(18)])
        #expect(LocationCard.outcome(shared) == String(localized: "Location shared · ±\("18 m")"))
        #expect(LocationCard.outcome(.object(["status": .string("declined"), "dismissed": .bool(true)])) == String(localized: "Not shared"))
        #expect(LocationCard.outcome(.object(["dismissed": .bool(true)])) == String(localized: "Not shared"))
        #expect(LocationCard.accuracyText(25_400) == "25 km")
    }
}
