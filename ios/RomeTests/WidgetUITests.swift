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
        surface.show(part) { method, path, _ in
            if method == "POST" { posts.value.append(path) }
            return ConnectReply(ok: true, body: body)
        }
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

    @Test func aPressPostsToTheAppAndReadsAgain() async throws {
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
