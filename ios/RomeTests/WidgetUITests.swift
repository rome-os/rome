import Foundation
import Testing
@testable import Rome

/// A card an app described as data: parsed from its `widget` part and read
/// from its data model as the dashboard reads it.
@Suite struct WidgetUITests {
    private let model: JSONValue = .object([
        "today": .object([
            "calories": .number(1240),
            "meals": .array([.object(["name": .string("Oatmeal")]), .object(["name": .string("Ramen")])]),
            "a/b": .string("slash"),
        ]),
    ])

    @Test func aDescribedWidgetIsDrawnHereAndAComponentWidgetOpensTheWeb() {
        let parsed = MessagePart.parse(#"""
        [{"type":"widget","toolUseId":"w1","appId":"meals","text":"Today","ui":{"components":[{"id":"root","component":"Text","text":"Hi"}]},"bind":{"/today":"days/1"}},
         {"type":"widget","toolUseId":"w2","appId":"meals","text":"Today","componentId":"today"}]
        """#)
        guard case .widgetUI(let card) = parsed.first else { Issue.record("not drawn natively"); return }
        #expect(card.appId == "meals")
        #expect(card.bind == ["/today": "days/1"])
        #expect(card.components["root"]?.kind == .text)
        #expect(parsed.last == .webOnly(.app("meals")))
    }

    @Test func aWidgetWithoutARootIsNotDrawn() {
        let parsed = MessagePart.parse(#"[{"type":"widget","toolUseId":"w","appId":"a","text":"t","ui":{"components":[{"id":"x","component":"Text","text":"a"}]}}]"#)
        #expect(parsed == [.webOnly(.app("a"))])
    }

    @Test func pathsReadTheModelAndListItemsReadTheirOwnItem() {
        #expect(WidgetData.text(.object(["path": .string("/today/calories")]), in: model, scope: "") == 1240.formatted())
        #expect(WidgetData.text(.string("plain"), in: model, scope: "") == "plain")
        #expect(WidgetData.text(.object(["path": .string("/today/a~1b")]), in: model, scope: "") == "slash")

        let list = WidgetComponent(id: "l", kind: .list, props: .object([
            "children": .object(["componentId": .string("meal"), "path": .string("/today/meals")]),
        ]))
        let kids = list.children(in: model, scope: "")
        #expect(kids.map(\.scope) == ["/today/meals/0", "/today/meals/1"])
        #expect(WidgetData.text(.object(["path": .string("name")]), in: model, scope: kids[1].scope) == "Ramen")
    }

    @Test func aButtonPostsItsContextWithItsPathsRead() {
        let context = WidgetData.context(.object(["kcal": .object(["path": .string("/today/calories")]), "date": .string("2026-11-11")]), in: model, scope: "")
        #expect(context == .object(["kcal": .number(1240), "date": .string("2026-11-11")]))
    }

    @Test func aCardReachesOnlyItsOwnApp() {
        #expect(WidgetData.isAppPath("days/2026-11-11"))
        for path in ["/api/system", "../connector/x", "a/./b", "https://evil.example", "a?b=1", "", "%2e%2e/%2e%2e/settings", "..\\..\\settings", "a//b", "publish", "manifest/x"] {
            #expect(!WidgetData.isAppPath(path))
        }
    }

    @MainActor @Test func theDemoMealCardParses() {
        guard case .widgetUI(let card) = MessagePart.parse(JSONValue.array([DemoBackend.mealCard]).prettyText).first else { Issue.record("demo card did not parse"); return }
        #expect(card.components.count == 12)
    }

    @MainActor @Test func aQuestionCardDescribedAsDataIsDrawnFromItsDescription() {
        guard case .question(let part) = MessagePart.parse(JSONValue.array([DemoBackend.dinnerQuestion]).prettyText).first else {
            Issue.record("not a question card"); return
        }
        #expect(part.questions.count == 2)
        let card = part.ui
        #expect(card?.components["q0-pick"]?.kind == .choicePicker)
        #expect(card?.components["q0-own"]?.kind == .textField)
        #expect(card?.data["answers"]?.array?.count == 2)
    }

    @Test func inputsWriteIntoTheModelAndChecksReadIt() {
        let start: JSONValue = .object(["answers": .array([.object(["values": .array([]), "text": .string("")])])])
        let required: JSONValue = .object(["call": .string("required"), "args": .object(["value": .object(["path": .string("/answers/0/values")])])])
        let either: JSONValue = .object(["call": .string("or"), "args": .object(["values": .array([
            required,
            .object(["call": .string("required"), "args": .object(["value": .object(["path": .string("/answers/0/text")])])]),
        ])])])
        #expect(!WidgetData.passes(either, in: start, scope: ""))
        let typed = WidgetData.storing(.string("Spicy"), at: "/answers/0/text", in: start)
        #expect(WidgetData.passes(either, in: typed, scope: ""))
        #expect(!WidgetData.passes(required, in: typed, scope: ""))
        let picked = WidgetData.storing(.array([.string("Warm")]), at: "/answers/0/values", in: start)
        #expect(WidgetData.passes(required, in: picked, scope: ""))
        #expect(WidgetData.storing(.string("x"), at: "/answers/5/text", in: start) == start)
    }

    @Test func romeStringsAreTranslatedByTheReader() {
        #expect(WidgetData.text(.object(["string": .string("send")]), in: .null, scope: "") == String(localized: "Send"))
    }

    @Test func theLastOfAPickAndTypedTextWins() {
        let start: JSONValue = .object(["answers": .array([.object(["values": .array([]), "text": .string("")])])])
        let typed = WidgetData.editing(.string("Friendly"), at: "/answers/0/text", clears: .object(["path": .string("/answers/0/values")]), scope: "", in: start)
        let picked = WidgetData.editing(.array([.string("Plain")]), at: "/answers/0/values", clears: .object(["path": .string("/answers/0/text")]), scope: "", in: typed)
        #expect(picked == .object(["answers": .array([.object(["values": .array([.string("Plain")]), "text": .string("")])])]))
        let retyped = WidgetData.editing(.string("Calm"), at: "/answers/0/text", clears: .object(["path": .string("/answers/0/values")]), scope: "", in: picked)
        #expect(retyped == .object(["answers": .array([.object(["values": .array([]), "text": .string("Calm")])])]))
    }

    @Test func onlyHttpsImagesLoad() {
        #expect(WidgetData.httpsURL("https://example.com/a.png") != nil)
        for url in ["/api/settings", "http://example.com/a.png", "photo.png", "https://"] {
            #expect(WidgetData.httpsURL(url) == nil)
        }
    }

    @Test func aCardsAppIdCannotLeaveTheAppsAPI() {
        #expect(WidgetData.appAPIPath(appId: "meal-planner", path: "water") == "/api/apps/meal-planner/water")
        for appId in ["..", "../settings", "a/b", "%2e%2e", ""] {
            #expect(WidgetData.appAPIPath(appId: appId, path: "water") == nil)
        }
    }
}
