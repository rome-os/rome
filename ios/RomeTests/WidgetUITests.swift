import A2UICore
import Foundation
import Testing
@testable import Rome

/// A card an app described as data: parsed from its `widget` part, checked
/// again on read, and drawn through Google's A2UI engine as the dashboard's.
@MainActor @Suite struct WidgetUITests {
    private func card(_ ui: String, bind: String = "{}", appId: String = "meals") -> WidgetUIPart? {
        let json = #"[{"type":"widget","toolUseId":"w","appId":"\#(appId)","text":"t","ui":{"components":\#(ui)},"bind":\#(bind)}]"#
        guard case .widgetUI(let part) = MessagePart.parse(json).first else { return nil }
        return part
    }

    /// A surface for `part` whose reads return `body`; `posts` records each press.
    private func surface(_ part: WidgetUIPart, body: Rome.JSONValue, posts: Box<[String]> = Box([])) async -> WidgetSurface {
        let surface = WidgetSurface()
        surface.show(part, call: { _, _, _ in ConnectReply(ok: true, body: body) }, press: { name, _ in
            posts.value.append(name)
            return WidgetEventReply()
        })
        await surface.load()
        return surface
    }

    @Test func aDescribedWidgetIsDrawnHereAndAComponentWidgetOpensTheWeb() {
        let parsed = MessagePart.parse(#"""
        [{"type":"widget","toolUseId":"w1","appId":"meals","text":"Today","ui":{"components":[{"id":"root","component":"Text","text":"Hi"}]},"bind":{"/today":"days/1"}},
         {"type":"widget","toolUseId":"w2","appId":"meals","text":"Today","componentId":"today"}]
        """#)
        guard case .widgetUI(let card) = parsed.first else { Issue.record("not drawn natively"); return }
        #expect(card.appId == "meals")
        #expect(card.bind == ["/today": "days/1"])
        #expect(parsed.last == .webOnly(.app("meals")))
    }

    @Test func aWidgetWithoutARootIsNotDrawn() {
        let parsed = MessagePart.parse(#"[{"type":"widget","toolUseId":"w","appId":"a","text":"t","ui":{"components":[{"id":"x","component":"Text","text":"a"}]}}]"#)
        #expect(parsed == [.webOnly(.app("a"))])
    }

    @Test func aStoredCardIsCheckedAgainBeforeItCallsItsApp() async throws {
        let text = #"[{"id":"root","component":"Text","text":"a"}]"#
        let post = #"[{"id":"root","component":"Button","child":"l","action":{"event":{"name":"../../settings"}}},{"id":"l","component":"Text","text":"Go"}]"#
        #expect(try #require(card(text, bind: #"{"/a":"days/1"}"#)).isDrawable)
        #expect(try #require(card(text, bind: #"{"/a":"../../settings"}"#)).isDrawable == false)
        #expect(try #require(card(post)).isDrawable == false)
        #expect(try #require(card(text, appId: "..")).isDrawable == false)
        let refused = await surface(try #require(card(post)), body: .object([:]))
        #expect(refused.undrawable)
    }

    @Test func theEngineFillsTheCardFromItsBindings() async throws {
        let part = try #require(card(#"""
        [{"id":"root","component":"Column","children":["kcal","meals"]},
         {"id":"kcal","component":"Stat","label":"Calories","value":{"path":"/today/calories"}},
         {"id":"meals","component":"List","children":{"componentId":"meal","path":"/today/meals"}},
         {"id":"meal","component":"Text","text":{"path":"name"}}]
        """#, bind: #"{"/today":"days/today"}"#))
        let model = await surface(part, body: .object([
            "calories": .number(1240),
            "meals": .array([.object(["name": .string("Oatmeal")]), .object(["name": .string("Ramen")])]),
        ]))
        let root = try #require(model.viewModel?.rootNode)
        let kids = root.children(for: "children")
        #expect(kids.first?.double(for: "value") == 1240)
        let meals = try #require(kids.last).children(for: "children")
        #expect(meals.map { $0.string(for: "text") } == ["Oatmeal", "Ramen"])
    }

    @Test func aListOfPlainValuesReadsEachItem() async throws {
        let part = try #require(card(#"""
        [{"id":"root","component":"List","children":{"componentId":"item","path":"/items"}},
         {"id":"item","component":"Text","text":{"path":""}}]
        """#, bind: #"{"/items":"tags"}"#))
        let model = await surface(part, body: .array([.string("spicy"), .string("seafood")]))
        let items = try #require(model.viewModel?.rootNode).children(for: "children")
        #expect(items.map { $0.string(for: "text") } == ["spicy", "seafood"])
    }

    @Test func aPressGoesToCore() async throws {
        let part = try #require(card(#"""
        [{"id":"root","component":"Button","child":"l","action":{"event":{"name":"water","context":{"cups":1}}}},
         {"id":"l","component":"Text","text":"Water"}]
        """#))
        let posts = Box<[String]>([])
        let model = await surface(part, body: .object([:]), posts: posts)
        let button = try #require(model.viewModel?.rootNode)
        button.action(for: "action", userActivation: true)?()
        for _ in 0..<50 where posts.value.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(posts.value == ["water"])
    }

    @Test func aCardReachesOnlyItsOwnApp() {
        #expect(WidgetPaths.isAppPath("days/2026-11-11"))
        for path in ["/api/system", "../connector/x", "a/./b", "https://evil.example", "a?b=1", "", "%2e%2e/%2e%2e/settings", "..\\..\\settings", "a//b"] {
            #expect(!WidgetPaths.isAppPath(path))
        }
    }

    @Test func theDemoMealCardParses() {
        guard case .widgetUI(let card) = MessagePart.parse(JSONValue.array([DemoBackend.mealCard]).prettyText).first else { Issue.record("demo card did not parse"); return }
        #expect(card.components.count == 12)
        #expect(card.isDrawable)
    }

    // MARK: A card the agent waits on

    private func questionCard() throws -> WidgetUIPart {
        guard case .question(let part) = MessagePart.parse(JSONValue.array([DemoBackend.dinnerQuestion]).prettyText).first else {
            throw CardError.notAQuestion
        }
        return try #require(part.ui)
    }

    private enum CardError: Error { case notAQuestion }

    /// The question card on the engine; `answers` records what it sends.
    private func waitingSurface(_ part: WidgetUIPart, answered: JSONValue? = nil, answers: Box<[JSONValue]> = Box([])) async -> WidgetSurface {
        let surface = WidgetSurface()
        surface.answered = answered != nil
        surface.show(part, call: { _, _, _ in throw APIError.notFound }, press: { name, context in
            answers.value.append(.object(["name": .string(name), "context": context]))
            // Core answered the agent waiting on the card.
            return WidgetEventReply(answered: true)
        })
        surface.showAnswered(answered)
        await surface.load()
        return surface
    }

    private func find(_ id: String, in node: Node?) -> Node? {
        guard let node else { return nil }
        if node.id == id { return node }
        for kid in node.children(for: "children") + [node.child(for: "child")].compactMap({ $0 }) {
            if let found = find(id, in: kid) { return found }
        }
        return nil
    }

    @Test func aQuestionCardDescribedAsDataIsDrawnFromItsDescription() throws {
        let card = try questionCard()
        #expect(card.waits)
        #expect(card.isDrawable)
        #expect(card.data["answers"]?.array?.count == 2)
    }

    @Test func sendWaitsForAnAnswerAndSpacesAreNone() async throws {
        let surface = await waitingSurface(try questionCard())
        let root = surface.viewModel?.rootNode
        #expect(find("send", in: root)?.isValid == false)
        surface.viewModel?.dataModel.set("/answers/0/text", value: .string("   "))
        #expect(find("send", in: surface.viewModel?.rootNode)?.isValid == false)
        surface.viewModel?.dataModel.set("/answers/0/text", value: .string("Soup"))
        #expect(find("send", in: surface.viewModel?.rootNode)?.isValid == true)
    }

    @Test func romeStringsAreTranslatedByTheReader() async throws {
        let surface = await waitingSurface(try questionCard())
        #expect(find("send-label", in: surface.viewModel?.rootNode)?.string(for: "text") == String(localized: "Send"))
    }

    @Test func anInputEmptiesWhatItClears() async throws {
        let surface = await waitingSurface(try questionCard())
        #expect(surface.clears.targets["q0-pick"] == "/answers/0/text")
        surface.viewModel?.dataModel.set("/answers/0/text", value: .string("Soup"))
        surface.clears.clear("/answers/0/text", false)
        #expect(surface.viewModel?.dataModel.get("/answers/0/text")?.stringValue == "")
    }

    @Test func sendAnswersTheInteractionWithTheCardsAnswers() async throws {
        let answers = Box<[JSONValue]>([])
        let surface = await waitingSurface(try questionCard(), answers: answers)
        surface.viewModel?.dataModel.set("/answers/0/values", value: .array([.string("高蛋白")]))
        find("send", in: surface.viewModel?.rootNode)?.action(for: "action", userActivation: true)?()
        for _ in 0..<50 where answers.value.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(answers.value.first?["name"]?.string == "send")
        #expect(answers.value.first?["context"]?["answers"]?.array?.first?["values"] == .array([.string("高蛋白")]))
        // Core took it: the card is sent, and takes no second press.
        #expect(surface.sent)
    }

    @Test func anAppsCardTheAgentWaitsOnIsDrawnHere() {
        let parsed = MessagePart.parse(#"""
        [{"type":"pending_interaction","toolUseId":"tu-c","appId":"connector","render":{"kind":"inline","ui":{"components":[{"id":"root","component":"Text","text":"Connect Gmail"}]},"bind":{"/s":"status"}}}]
        """#)
        guard case .widgetUI(let card) = parsed.first else { Issue.record("not drawn natively"); return }
        #expect(card.waits && card.appId == "connector" && card.bind == ["/s": "status"])
    }

    @Test func aReplyThatDoesNotAnswerOpensItsLinkAndLeavesTheCardUsable() async throws {
        let surface = WidgetSurface()
        let opened = Box<[URL]>([])
        let connect = try #require(WidgetUIPart(interaction: JSONValue.object([
            "type": .string("pending_interaction"), "toolUseId": .string("tu-c"), "appId": .string("connector"),
            "render": .object(["kind": .string("inline"), "ui": .object(["components": .array([
                .object(["id": .string("root"), "component": .string("Button"), "child": .string("l"),
                         "action": .object(["event": .object(["name": .string("connect")])])]),
                .object(["id": .string("l"), "component": .string("Text"), "text": .string("Connect")]),
            ])])]),
        ])))
        surface.show(connect, call: { _, _, _ in ConnectReply(ok: true, body: .object([:])) }, press: { _, _ in
            WidgetEventReply(open: URL(string: "https://auth.example.com/go"))
        }, open: { opened.value.append($0) })
        await surface.load()
        surface.viewModel?.rootNode?.action(for: "action", userActivation: true)?()
        for _ in 0..<50 where opened.value.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(opened.value == [URL(string: "https://auth.example.com/go")!])
        #expect(!surface.sent)
    }

    @Test func aCardCoreDidNotTakeStaysUsable() async throws {
        let surface = WidgetSurface()
        let tries = Box(0)
        surface.show(try questionCard(), call: { _, _, _ in throw APIError.notFound }, press: { _, _ in
            tries.value += 1
            throw APIError.network
        })
        await surface.load()
        find("dismiss", in: surface.viewModel?.rootNode)?.action(for: "action", userActivation: true)?()
        for _ in 0..<50 where !surface.failed { try await Task.sleep(for: .milliseconds(10)) }
        #expect(surface.failed && !surface.sent)
        find("dismiss", in: surface.viewModel?.rootNode)?.action(for: "action", userActivation: true)?()
        for _ in 0..<50 where tries.value < 2 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(tries.value == 2)
    }

    @Test func anAnsweredCardShowsWhatWasSentAndTakesNoPress() async throws {
        let sent: JSONValue = .array([.object(["values": .array([.string("清淡一点")]), "text": .string("")]), .object(["values": .array([]), "text": .string("")])])
        let answers = Box<[JSONValue]>([])
        let surface = await waitingSurface(try questionCard(), answered: .object(["answers": sent, "card": sent]), answers: answers)
        #expect(surface.viewModel?.dataModel.get("/answers/0/values/0")?.stringValue == "清淡一点")
        find("dismiss", in: surface.viewModel?.rootNode)?.action(for: "action", userActivation: true)?()
        try await Task.sleep(for: .milliseconds(100))
        #expect(answers.value.isEmpty)
    }

    @Test func aWidgetsIdIsTheIdOfTheMessageThatHoldsIt() {
        let held = { (part: JSONValue, id: String) in
            ChatMessage(id: id, sessionId: "topic-meals", role: "assistant", content: JSONValue.array([part]).prettyText, createdAt: RomeDate.string(.now))
        }
        let rows = TranscriptBuilder.rows(messages: [held(DemoBackend.mealCard, "m-meal"), held(DemoBackend.dinnerQuestion, "m-dinner")], pending: [], answers: [:], options: .init())
        let ids = rows.compactMap { row -> String? in
            switch row {
            case .widgetUI(_, let part, _): part.widgetId
            case .question(_, let part, _, _): part.ui?.widgetId
            default: nil
            }
        }
        #expect(ids == ["m-meal", "m-dinner"])
    }

    @Test func onlyHttpsImagesLoad() {
        #expect(WidgetPaths.httpsURL("https://example.com/a.png") != nil)
        for url in ["/api/settings", "http://example.com/a.png", "photo.png", "https://"] {
            #expect(WidgetPaths.httpsURL(url) == nil)
        }
    }

    @Test func aStoreAppsScopedIdIsOnePathSegment() {
        #expect(WidgetPaths.appAPIPath(appId: "meal-planner", path: "water") == "/api/apps/meal-planner/water")
        #expect(WidgetPaths.appAPIPath(appId: "@alice/meals", path: "days/today") == "/api/apps/@alice%2Fmeals/days/today")
        #expect(WidgetPaths.appAPIPath(appId: "..", path: "water") == nil)
    }
}

/// A value a closure can change and a test can read.
final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
