import XCTest

/// Leg B of the voice input rules on iOS. It drives the Debug app on a simulator against the
/// stand-in instance, through the accessibility contract: the control is "Start voice input"
/// when idle, "Stop voice input" with the selected trait while listening, and "Finishing voice
/// input" while the last words arrive. The notice is its own element. Each test names the rule
/// it scores, so the verifier's report can say which leg scored which rule. Unless a test says
/// otherwise it plays a four-minute hum, so only the test's own stop ends listening.
///
/// Rule 1's 0.5 s is timed inside the app, since XCUITest waits for the app to go idle around
/// every tap (1 to 13 s on a CI runner). The app marks each start with a `StartListening`
/// signpost interval, from the tap arriving to the field drawing listening; each test measures
/// it over five starts, and the CI job fails when any interval in the result bundle is over
/// 0.5 s.
/// A stop is not timed here: its tap shows finishing at once, and idle comes when the instance
/// sends the last words, so the suite checks only that each stop shows finishing or idle.
///
/// The stand-in instance comes from the CI job through `TEST_RUNNER_ROME_LOCAL_ORIGIN`,
/// `TEST_RUNNER_ROME_LOCAL_USER` and `TEST_RUNNER_ROME_LOCAL_PASSWORD`. Without them every test
/// skips and says so.
final class VoiceInputTests: XCTestCase {
    /// Starts and stops per field; every one must show its change.
    static let repeats = 5
    /// How long a change may take to show once XCUITest's tap has returned.
    static let settleSeconds: TimeInterval = 10
    /// Whether the instance has answered once in this test run.
    @MainActor static var instanceAnswered = false

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: Rule 1

    /// Rule 1 in the Chat, the field the app opens on.
    @MainActor
    func testRule1TheChat() throws {
        let app = try launch()
        try checkStartsAndStops(app, field: "the Chat")
    }

    /// Rule 1 in a topic chat.
    @MainActor
    func testRule1ATopicChat() throws {
        let app = try launch()
        app.buttons["Open navigation"].tap()
        let existing = app.buttons.matching(identifier: "topic-chat").firstMatch
        if existing.waitForExistence(timeout: 3) {
            existing.tap()
        } else {
            app.buttons["New topic chat"].tap()
        }
        try checkStartsAndStops(app, field: "a topic chat")
    }

    /// Rule 1 in a task chat. Needs a task on the instance.
    @MainActor
    func testRule1ATaskChat() throws {
        let app = try launch()
        let cards = app.buttons.matching(identifier: "task-card")
        guard cards.firstMatch.waitForExistence(timeout: 10) else {
            printScreen(app, "no task card")
            throw XCTSkip("the instance has no task, so no task chat to open")
        }
        // The card holds a smaller button under the same identifier that stops the task, so
        // open the card by its left side, away from that button.
        let card = cards.allElementsBoundByIndex.max(by: { $0.frame.width < $1.frame.width }) ?? cards.firstMatch
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
        try checkStartsAndStops(app, field: "a task chat")
    }

    /// Rule 1 in a thread under a Concierge message. Needs a task on the instance.
    @MainActor
    func testRule1AThread() throws {
        let app = try launch()
        let thread = app.buttons["thread-label"].firstMatch
        guard thread.waitForExistence(timeout: 10) else {
            printScreen(app, "no thread label")
            throw XCTSkip("the instance has no task's thread to open")
        }
        thread.tap()
        try checkStartsAndStops(app, field: "a thread")
    }

    // MARK: Rules 2 and 3

    /// Rules 2 and 3, as far as the simulator goes: words show while the recording plays, and
    /// the field keeps them once listening stops. How fast and how right is leg A's to score.
    @MainActor
    func testRules2And3WordsShowWhileSpeakingAndStay() throws {
        let app = try launch(recording: "speech")
        let control = onScreen(app.buttons, "voice-input")
        let field = onScreen(app.textViews, "message-field")
        try requireControl(app, control, "the Chat has no voice control")
        // A draft an earlier test left would pass both checks without a word heard.
        emptyTheField(app, "rules 2 and 3")
        let empty = fieldText(field)
        control.tap()
        let shown = expectation(for: NSPredicate(format: "value != nil AND value != %@", empty), evaluatedWith: field)
        wait(for: [shown], timeout: 15)
        // The recording may end, and listening with it, before the guardian stops.
        if control.label == "Stop voice input" { control.tap() }
        XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 30), "the control never returned to idle")
        XCTAssertNotEqual(fieldText(field), empty, "the words were gone after listening stopped")
    }

    // MARK: Rule 8

    /// Rule 8 with the microphone refused, in English and Chinese: the control stays, a tap
    /// shows the notice saying how to allow it, and typing still sends.
    @MainActor
    func testRule8RefusedMicrophoneLeavesTypingWorking() throws {
        let cases: [(language: String, start: String, says: (String) -> Bool, wanted: String)] = [
            ("en", "Start voice input", { $0.localizedCaseInsensitiveContains("microphone") && $0.contains("Settings") },
             "a notice naming the microphone and Settings"),
            ("zh-Hans", "开始语音输入", { $0.contains("允许") }, "Chinese text that says to allow (允许) the microphone"),
        ]
        for item in cases {
            let app = try launch(microphone: "denied", language: item.language)
            let control = onScreen(app.buttons, "voice-input")
            try requireControl(app, control, "\(item.language): no voice control when refused")
            XCTAssertEqual(control.label, item.start, "\(item.language): the control is not named in this language")
            control.tap()
            let notice = app.descendants(matching: .any)["voice-input-notice"]
            if !notice.waitForExistence(timeout: 5) {
                printScreen(app, "\(item.language): no notice within 5 s")
                XCTFail("\(item.language): no notice within 5 s")
                return
            }
            XCTAssertTrue(item.says(notice.label), "\(item.language): the notice says \"\(notice.label)\"; wanted \(item.wanted)")
            let stays = onScreen(app.buttons, "voice-input")
            XCTAssertTrue(stays.exists && stays.label == item.start, "\(item.language): the control did not stay after the refusal")
            let typed = "typed after refusing \(item.language) \(Int(Date().timeIntervalSince1970))"
            let field = onScreen(app.textViews, "message-field")
            // A draft an earlier test left in this chat is kept across launches, as it should be,
            // and the tap may put the cursor anywhere in it: check the typed words, not the whole field.
            field.tap()
            field.typeText(typed)
            XCTAssertTrue((field.value as? String ?? "").contains(typed), "\(item.language): a key was lost after the notice")
            onScreen(app.buttons, "send").tap()
            let sent = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", typed)).firstMatch
            XCTAssertTrue(sent.waitForExistence(timeout: 10), "\(item.language): the typed message was not sent")
            app.terminate()
        }
    }

    // MARK: Rule 7

    /// A kill ends the app with no chance to save, so the words checked must be in the saved
    /// draft first: the field hands shown words to the draft once a second, and the draft
    /// writes 300 ms after its last change.
    static func waitForTheDraft() { Thread.sleep(forTimeInterval: 2) }

    /// Rule 7 when the guardian opens another chat and comes back.
    @MainActor
    func testRule7LeavingTheChatKeepsTheWords() throws {
        let app = try launch(recording: Self.hum)
        try checkWordsKept(app, stop: "leaving the chat", notice: "Listening stopped when you left this chat") {
            touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Open navigation"))).tap()
            let other = app.buttons.matching(identifier: "topic-chat").firstMatch
            if other.waitForExistence(timeout: 3) { other.tap() } else { app.buttons["New topic chat"].tap() }
            _ = onScreen(app.textViews, "message-field").waitForExistence(timeout: 10)
            touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Open navigation"))).tap()
            touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Chat"))).tap()
            return app
        }
    }

    /// Rule 7 when the app goes to the background and the guardian comes back.
    @MainActor
    func testRule7TheBackgroundKeepsTheWords() throws {
        let app = try launch(recording: Self.hum)
        try checkWordsKept(app, stop: "the background", notice: "Listening stopped when Rome went to the background") {
            XCUIDevice.shared.press(.home)
            Thread.sleep(forTimeInterval: 3)
            app.activate()
            return app
        }
    }

    /// Rule 7 when the app is ended and opened again, iOS's nearest thing to a reload: the words
    /// come back from the kept draft, and the notice goes away on the next edit without taking
    /// the typed character with it.
    @MainActor
    func testRule7RelaunchingKeepsTheWords() throws {
        let first = try launch(recording: Self.hum)
        let app = try checkWordsKept(first, stop: "a relaunch", notice: "Listening stopped when Rome closed") {
            Self.waitForTheDraft()
            first.terminate()
            return try launch(recording: Self.hum)
        }
        let field = onScreen(app.textViews, "message-field")
        let before = fieldText(field)
        field.tap()
        field.typeText("Z")
        let after = fieldText(field)
        XCTAssertEqual(after.count, before.count + 1, "the edit after the notice changed \(after.count - before.count) characters; wanted 1")
        XCTAssertTrue(after.contains("Z"), "the typed character was lost after the notice")
        let notice = app.descendants(matching: .any)["voice-input-notice"]
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: notice)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 5), .completed, "the notice stayed after the next edit")
    }

    /// Rule 7's notices in Chinese, for the stops whose Chinese the contract gives: the
    /// background, then a relaunch.
    @MainActor
    func testRule7NoticesInChinese() throws {
        let first = try launch(recording: Self.hum, language: "zh-Hans")
        try checkWordsKept(first, stop: "zh-Hans: the background", notice: "Rome 进入后台时已停止收听", language: "zh-Hans") {
            XCUIDevice.shared.press(.home)
            Thread.sleep(forTimeInterval: 3)
            first.activate()
            return first
        }
        try checkWordsKept(first, stop: "zh-Hans: a relaunch", notice: "Rome 关闭时已停止收听", language: "zh-Hans") {
            Self.waitForTheDraft()
            first.terminate()
            return try launch(recording: Self.hum, language: "zh-Hans")
        }
    }

    /// Rule 7 when the transcriber fails partway: the stand-in instance ends the session with
    /// an error, and listening stops by itself.
    @MainActor
    func testRule7ATranscriberErrorKeepsTheWords() throws {
        let app = try launch(recording: Self.hum)
        // The reason Rome sends when its route to the transcriber drops mid-message.
        try standIn(["error": ["reason": "provider-unavailable", "afterMs": 10000]])
        try checkWordsKept(app, stop: "a transcriber error", notice: "Transcription service unavailable. Listening stopped") {
            let control = onScreen(app.buttons, "voice-input")
            _ = waitForLabel(control, "Start voice input", timeout: 20)
            return app
        }
    }

    /// Rule 7 when the network to Rome is lost: the stand-in instance drops the voice socket
    /// and the events socket partway, and refuses new ones for 5 s.
    @MainActor
    func testRule7LosingTheNetworkKeepsTheWords() throws {
        let app = try launch()
        try standIn(["drop": ["afterMs": 10000, "refuseMs": 5000]])
        try checkWordsKept(app, stop: "losing the network", notice: "Connection to Rome lost. Listening stopped") {
            _ = waitForLabel(onScreen(app.buttons, "voice-input"), "Start voice input", timeout: 20)
            return app
        }
        // The stand-in refuses connections for 5 s after the drop; the next test must not start
        // inside that.
        Thread.sleep(forTimeInterval: 6)
    }

    // MARK: Rule 11

    /// Rule 11 with Rome Cloud refusing voice input, as with its gate off: the Chat has its
    /// message field and no voice control.
    @MainActor
    func testRule11NoVoiceControlWhenRomeCloudRefuses() throws {
        try standIn(["offered": false])
        defer { try? standIn(["offered": true]) }
        let app = try launch()
        XCTAssertTrue(onScreen(app.textViews, "message-field").waitForExistence(timeout: 15), "the Chat has no message field")
        // Give the app the time it takes to ask Rome whether voice input is offered.
        Thread.sleep(forTimeInterval: 5)
        if app.buttons.matching(identifier: "voice-input").count > 0 {
            printScreen(app, "rule 11: refused")
            XCTFail("the Chat shows a voice control while Rome Cloud refuses voice input")
        }
    }

    // MARK: Rule 9

    /// Rule 9: every stop closes the microphone within 1 s. Each of six starts in the Chat ends
    /// with another stop: the guardian's, leaving the chat, the background, a transcriber error,
    /// losing the network, and the guardian's again. The app's `StopListening` interval runs
    /// from the stop to the microphone closed. On the simulator the recording stands in for the
    /// microphone and closes in microseconds, so the CI job checks only that every measured stop
    /// has an interval; the 1 s is scored on a phone (leg C).
    @MainActor
    func testRule9EveryStopClosesTheMicrophone() throws {
        let app = try launch()
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "the Chat has no voice control")
        // A stand-in instance without the network control leaves that stop out, and says so.
        let canDrop = (try? standIn(["drop": NSNull()])) != nil
        if !canDrop { print("rule 9: not run for losing the network: the stand-in instance has no drop control") }
        let stops = ["the guardian's stop", "leaving the chat", "the background", "a transcriber error",
                     canDrop ? "losing the network" : "the guardian's stop", "the guardian's stop"]
        let options = XCTMeasureOptions()
        options.iterationCount = stops.count - 1
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        let stopListening = XCTOSSignpostMetric(
            subsystem: "cc.romeos.voice-input", category: "VoiceInput", name: "StopListening")
        var index = 0
        measure(metrics: [stopListening], options: options) {
            let stop = stops[index % stops.count]
            index += 1
            let control = onScreen(app.buttons, "voice-input")
            XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 30), "not idle before \(stop)")
            if stop == "a transcriber error" {
                try? standIn(["error": ["reason": "provider-unavailable", "afterMs": 12000]])
            } else if stop == "losing the network" {
                try? standIn(["drop": ["afterMs": 12000, "refuseMs": 5000]])
            }
            if !tapUntil(control, NSPredicate(format: "label == %@", "Stop voice input")) {
                printScreen(app, "rule 9: listening never started before \(stop)")
                XCTFail("listening never started before \(stop)")
            }
            startMeasuring()
            switch stop {
            case "leaving the chat":
                touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Open navigation"))).tap()
                let other = app.buttons.matching(identifier: "topic-chat").firstMatch
                if other.waitForExistence(timeout: 3) { other.tap() } else { app.buttons["New topic chat"].tap() }
                _ = onScreen(app.textViews, "message-field").waitForExistence(timeout: 10)
                touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Open navigation"))).tap()
                touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Chat"))).tap()
            case "the background":
                XCUIDevice.shared.press(.home)
                Thread.sleep(forTimeInterval: 3)
                app.activate()
            case "a transcriber error", "losing the network":
                break
            default:
                control.tap()
            }
            let idle = waitForLabel(onScreen(app.buttons, "voice-input"), "Start voice input", timeout: 30)
            stopMeasuring()
            XCTAssertTrue(idle, "listening was still shown 30 s after \(stop)")
            // The stand-in refuses new connections for 5 s after it drops the network.
            if stop == "losing the network" { Thread.sleep(forTimeInterval: 7) }
        }
    }

    // MARK: Rule 4

    /// Rule 4 as far as the app can break it: three minutes of dictation leave the first and the
    /// last sentence of the stand-in's transcript in the field, listening is still on at the end
    /// (nothing stopped it: not the screen dimming, memory or the audio session), and the field
    /// still takes typing. How right the words are is leg A's to score.
    @MainActor
    func testRule4ThreeMinutesStayInTheField() throws {
        let app = try launch()
        // One word every 300 ms, so 600 words take three minutes.
        let first = "The first sentence starts the long message."
        let last = "The last sentence ends the long message."
        let filler = Array(repeating: "and", count: 600 - 14).joined(separator: " ")
        try standIn(["transcript": "\(first) \(filler) \(last)"])
        defer { try? standIn(["transcript": Self.transcript]) }
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "the Chat has no voice control")
        emptyTheField(app, "rule 4")
        let field = onScreen(app.textViews, "message-field")
        XCTAssertTrue(tapUntil(control, NSPredicate(format: "label == %@", "Stop voice input")), "listening never started")
        let heard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", last), object: field)
        let arrived = XCTWaiter().wait(for: [heard], timeout: 240) == .completed
        let stillListening = control.label == "Stop voice input"
        XCTAssertTrue(arrived, "the last sentence never reached the field")
        XCTAssertTrue(stillListening, "listening stopped before the three minutes were over")
        if stillListening {
            XCTAssertTrue(tapUntil(control, NSPredicate(format: "label IN %@", ["Finishing voice input", "Start voice input"])),
                          "listening never stopped")
        }
        let text = fieldText(field)
        XCTAssertTrue(text.contains(first), "the first sentence is not in the field")
        XCTAssertTrue(text.contains(last), "the last sentence is not in the field")
        XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 15), "listening never finished")
        field.tap()
        field.typeText("Z")
        XCTAssertEqual(fieldText(field).count, text.count + 1, "the field did not take one typed character after three minutes")
    }

    // MARK: Rule 10

    /// Rule 10 on the phone: while Rome Cloud serves voice input, Settings names no transcription
    /// provider or host anywhere, and shows no "Voice input" status row.
    @MainActor
    func testRule10TheAppNamesNoProvider() throws {
        let place = try voiceInputPlace()
        let app = try launch()
        touchable(app.buttons.matching(NSPredicate(format: "label == %@", "Open navigation"))).tap()
        let settings = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "settings")).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 10), "the navigation has no settings")
        settings.tap()
        XCTAssertTrue(app.staticTexts["Version"].waitForExistence(timeout: 10), "Settings never opened")
        XCTAssertFalse(app.descendants(matching: .any)["voice-input-place"].exists, "Settings shows a \"Voice input\" status row")
        for name in [place.provider, place.host] {
            let shown = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", name, name))
            if shown.count > 0 {
                printScreen(app, "rule 10: settings")
                XCTFail("Settings names \"\(name)\"")
            }
        }
    }

    /// The provider and host Rome names for voice input, from its own read API.
    @MainActor
    private func voiceInputPlace() throws -> (provider: String, host: String) {
        let origin = try XCTUnwrap(ProcessInfo.processInfo.environment["ROME_LOCAL_ORIGIN"],
                                   "no stand-in instance: set TEST_RUNNER_ROME_LOCAL_ORIGIN")
        let data = try Data(contentsOf: try XCTUnwrap(URL(string: "\(origin)/api/voice-input")))
        let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let place = try XCTUnwrap(answer["place"] as? [String: Any], "GET /api/voice-input names no place: \(answer)")
        return (try XCTUnwrap(place["provider"] as? String), try XCTUnwrap(place["host"] as? String))
    }

    // MARK: Rule 5

    /// Rule 5: spoken words stay in the field for 60 s after listening stops, and only the send
    /// action sends them.
    @MainActor
    func testRule5OnlyTheGuardianSends() throws {
        let app = try launch()
        let phrase = "only you send \(Int(Date().timeIntervalSince1970))"
        try standIn(["transcript": phrase])
        defer { try? standIn(["transcript": Self.transcript]) }
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "the Chat has no voice control")
        emptyTheField(app, "rule 5")
        let field = onScreen(app.textViews, "message-field")
        XCTAssertTrue(tapUntil(control, NSPredicate(format: "label == %@", "Stop voice input")), "listening never started")
        let heard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", phrase), object: field)
        XCTAssertEqual(XCTWaiter().wait(for: [heard], timeout: 30), .completed, "the spoken words never reached the field")
        XCTAssertTrue(tapUntil(control, NSPredicate(format: "label IN %@", ["Finishing voice input", "Start voice input"])),
                      "listening never stopped")
        let sent = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", phrase)).firstMatch
        Thread.sleep(forTimeInterval: 60)
        XCTAssertFalse(sent.exists, "a message with the spoken words appeared without the send action")
        XCTAssertTrue(fieldText(field).contains(phrase), "the spoken words left the field without the send action")
        onScreen(app.buttons, "send").tap()
        XCTAssertTrue(sent.waitForExistence(timeout: 10), "the send action did not send the spoken words")
    }

    // MARK: Rule 6

    /// Rule 6 with text already in the field: the spoken words land at the cursor as typing them
    /// would, with the contract's leading space, and the sent message is the field's text. A
    /// second dictation checks that one undo (Command-Z) removes them.
    @MainActor
    func testRule6SpeakingIsTypingAfterText() throws {
        let app = try launch()
        let spoken = "spoken after typing"
        try standIn(["transcript": spoken])
        defer { try? standIn(["transcript": Self.transcript]) }
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "the Chat has no voice control")
        for undo in [false, true] {
            emptyTheField(app, "rule 6")
            let field = onScreen(app.textViews, "message-field")
            let typed = "Typed \(Int(Date().timeIntervalSince1970))"
            field.tap()
            field.typeText(typed)
            let whole = "\(typed) \(spoken)"
            XCTAssertTrue(tapUntil(control, NSPredicate(format: "label == %@", "Stop voice input")), "listening never started")
            let heard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", spoken), object: field)
            XCTAssertEqual(XCTWaiter().wait(for: [heard], timeout: 30), .completed, "the spoken words never reached the field")
            XCTAssertTrue(tapUntil(control, NSPredicate(format: "label IN %@", ["Finishing voice input", "Start voice input"])),
                          "listening never stopped")
            XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 10), "listening never finished")
            XCTAssertEqual(fieldText(field), whole, "the field is not what typing the words at the cursor gives")
            if undo {
                // XCUITest cannot synthesize the three-finger undo gesture on the runner, so undo
                // comes from the simulator's hardware keyboard, as Command-Z.
                field.typeKey("z", modifierFlags: .command)
                let undone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", typed), object: field)
                if XCTWaiter().wait(for: [undone], timeout: 5) != .completed {
                    printScreen(app, "rule 6: after one undo")
                    XCTFail("one undo left \"\(fieldText(field))\"; wanted \"\(typed)\"")
                }
            } else {
                onScreen(app.buttons, "send").tap()
                let sent = app.staticTexts.matching(NSPredicate(format: "label == %@", whole)).firstMatch
                XCTAssertTrue(sent.waitForExistence(timeout: 10), "the sent message is not \"\(whole)\"")
            }
        }
    }

    // MARK: Helpers

    /// A recording the stand-in instance hears as speech for its whole four minutes, so only the
    /// stop under test ends listening.
    static let hum = "hum"

    /// Starts listening in the Chat, waits for some words, makes `stop` happen, and checks that
    /// the words shown before the stop are in the field afterwards and that the field says why
    /// within 5 s. `stop` returns the app to read from, which is a new one after a relaunch.
    @MainActor
    @discardableResult
    private func checkWordsKept(_ app: XCUIApplication, stop: String, notice expected: String,
                                language: String = "en",
                                _ makeStop: () throws -> XCUIApplication) throws -> XCUIApplication {
        let (start, stopLabel) = language == "en" ? ("Start voice input", "Stop voice input") : ("开始语音输入", "停止语音输入")
        try standIn(["transcript": Self.longTranscript])
        defer { try? standIn(["transcript": Self.transcript]) }
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "\(stop): the Chat has no voice control")
        let field = onScreen(app.textViews, "message-field")
        emptyTheField(app, stop)
        let empty = fieldText(field)
        guard tapUntil(control, NSPredicate(format: "label == %@", stopLabel)) else {
            printScreen(app, "\(stop): listening never started")
            XCTFail("\(stop): listening never started")
            return app
        }
        // Read the field until it holds some words, and keep the last reading before the stop.
        var before = empty
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline, control.label == stopLabel {
            before = fieldText(field)
            if before != empty, words(before).count >= 3 { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertNotEqual(before, empty, "\(stop): no words showed before the stop")
        let back = try makeStop()
        let notice = back.descendants(matching: .any)["voice-input-notice"]
        let noticeShown = notice.waitForExistence(timeout: 5)
        let after = fieldText(onScreen(back.textViews, "message-field"))
        // The word arriving at the stop may be cut, so all but the last word must be kept.
        let kept = words(before).dropLast().joined(separator: " ")
        if !words(after).joined(separator: " ").contains(kept) {
            printScreen(back, "\(stop): words lost")
            XCTFail("\(stop): the field holds \"\(after)\"; before the stop it held \"\(before)\"")
        }
        if !noticeShown {
            printScreen(back, "\(stop): no notice")
            XCTFail("\(stop): the field did not say why listening stopped within 5 s")
        } else {
            XCTAssertEqual(notice.label, expected, "\(stop): the notice says something else")
        }
        if onScreen(back.buttons, "voice-input").label != start {
            XCTFail("\(stop): listening was still shown after the stop")
        }
        return back
    }

    /// Sends a draft an earlier test left, which is how a guardian empties the field: spoken
    /// words go in at the cursor, so a check of them starts from an empty field.
    @MainActor
    private func emptyTheField(_ app: XCUIApplication, _ check: String) {
        let send = onScreen(app.buttons, "send")
        guard send.isEnabled else { return }
        send.tap()
        let emptied = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: send)
        XCTAssertEqual(XCTWaiter().wait(for: [emptied], timeout: 10), .completed, "\(check): the earlier draft did not send")
    }

    /// What the stand-in instance transcribes by default, and a transcript long enough that
    /// words keep arriving until any stop: one word every 300 ms for about a minute.
    static let transcript = "Remind me to call the dentist tomorrow at 9 in the morning."
    static let longTranscript = Array(repeating: transcript, count: 16).joined(separator: " ")

    @MainActor
    private func fieldText(_ field: XCUIElement) -> String {
        field.value as? String ?? ""
    }

    private func words(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// Sets how the stand-in instance's next voice session goes, through its control route. A
    /// control the stand-in does not know is missing from its answer, and the test does not run.
    @MainActor
    private func standIn(_ body: [String: Any]) throws {
        let origin = try XCTUnwrap(ProcessInfo.processInfo.environment["ROME_LOCAL_ORIGIN"])
        var request = URLRequest(url: try XCTUnwrap(URL(string: "\(origin)/__stand-in/voice")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let reply = StandInReply()
        let done = expectation(description: "the stand-in instance takes \(body.keys.sorted())")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            reply.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            reply.data = data
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        let status = reply.status
        let answer = reply.data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        XCTAssertEqual(status, 200, "the stand-in instance refused \(body.keys.sorted())")
        let unknown = body.keys.filter { $0 != "error" && answer[$0] == nil }
        if status == 200, !unknown.isEmpty {
            throw XCTSkip("not run: the stand-in instance has no \(unknown.sorted()) control")
        }
    }

    /// Starts and stops `repeats` times in the open field: one tap shows listening, with the
    /// selected trait, and one tap shows finishing or idle. Each start's `StartListening`
    /// interval is measured; the CI job holds every one to rule 1's 0.5 s.
    @MainActor
    private func checkStartsAndStops(_ app: XCUIApplication, field: String) throws {
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "\(field) has no voice control")
        XCTAssertTrue(onScreen(app.textViews, "message-field").exists, "\(field) has no message field")
        // Each start adds words, so start from an empty field rather than one earlier runs grew.
        emptyTheField(app, field)
        let options = XCTMeasureOptions()
        options.iterationCount = Self.repeats
        options.invocationOptions = [.manuallyStop]
        var index = 0
        let startListening = XCTOSSignpostMetric(
            subsystem: "cc.romeos.voice-input", category: "VoiceInput", name: "StartListening")
        measure(metrics: [startListening], options: options) {
            index += 1
            XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 30), "\(field): not idle before start \(index)")
            let listening = NSPredicate(format: "label == %@ AND selected == true", "Stop voice input")
            if !tapUntil(control, listening) {
                printScreen(app, "\(field): start \(index) never showed listening with the selected trait")
                XCTFail("\(field): start \(index) never showed listening with the selected trait")
            }
            stopMeasuring()
            let stopped = NSPredicate(format: "label IN %@", ["Finishing voice input", "Start voice input"])
            if !tapUntil(control, stopped) {
                printScreen(app, "\(field): stop \(index) never showed finishing or idle")
                XCTFail("\(field): stop \(index) never showed finishing or idle")
            }
        }
    }


    /// Taps `control` and returns whether it matches `predicate` within `settleSeconds` of the
    /// tap returning.
    @MainActor
    private func tapUntil(_ control: XCUIElement, _ predicate: NSPredicate) -> Bool {
        control.tap()
        let shown = XCTNSPredicateExpectation(predicate: predicate, object: control)
        return XCTWaiter().wait(for: [shown], timeout: Self.settleSeconds) == .completed
    }

    /// The element with `identifier` the guardian can touch. A chat that is sliding in sits over
    /// the Chat's field until the push ends, so this waits up to 15 s for one match to be left,
    /// and then the element is found afresh on every use. When two stay, it takes the last
    /// touchable one.
    @MainActor
    private func onScreen(_ query: XCUIElementQuery, _ identifier: String) -> XCUIElement {
        touchable(query.matching(identifier: identifier))
    }

    /// The one of `matches` the guardian can touch, as `onScreen` finds it.
    @MainActor
    private func touchable(_ matches: XCUIElementQuery) -> XCUIElement {
        let deadline = Date().addingTimeInterval(15)
        while matches.count != 1, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
        }
        if matches.count == 1 { return matches.firstMatch }
        let index = matches.allElementsBoundByIndex.lastIndex(where: { $0.isHittable })
        return index.map { matches.element(boundBy: $0) } ?? matches.firstMatch
    }

    /// A generated four-minute hum, 16 kHz mono 16-bit. The stand-in instance hears it as speech,
    /// so its 30 s no-speech end never comes during XCUITest's slow steps.
    private func humFile() throws -> URL {
        let rate: UInt32 = 16000
        let seconds = 240
        let count = Int(rate) * seconds
        // Named by its length, so a file an older run left at another length is never reused.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(Self.hum)-\(seconds)s.wav")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        var data = Data()
        func text(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(36 + UInt32(count * 2)); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        text("data"); u32(UInt32(count * 2))
        var samples = [Int16](repeating: 0, count: count)
        for i in 0..<count { samples[i] = Int16(2000 * sin(2 * Double.pi * 200 * Double(i) / Double(rate))) }
        samples.withUnsafeBytes { data.append(contentsOf: $0) }
        try data.write(to: url)
        return url
    }

    /// Launches the app signed in to the stand-in instance, playing `recording` (a WAV in this
    /// bundle, or the hum) as the microphone, or with the microphone as `microphone` says.
    @MainActor
    private func launch(recording: String = VoiceInputTests.hum, microphone: String? = nil, language: String = "en") throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["ROME_LOCAL_ORIGIN"], let user = env["ROME_LOCAL_USER"],
              let password = env["ROME_LOCAL_PASSWORD"] else {
            throw XCTSkip("no stand-in instance: set TEST_RUNNER_ROME_LOCAL_ORIGIN, _USER and _PASSWORD")
        }
        if !Self.instanceAnswered {
            try assertAnswers(origin)
            Self.instanceAnswered = true
        }
        let app = XCUIApplication()
        app.launchEnvironment["ROME_LOCAL_ORIGIN"] = origin
        app.launchEnvironment["ROME_LOCAL_USER"] = user
        app.launchEnvironment["ROME_LOCAL_PASSWORD"] = password
        app.launchArguments += ["-AppleLanguages", "(\(language))"]
        if let microphone {
            app.launchArguments += ["-RomeVoiceInputMicrophone", microphone]
        } else if recording != Self.hum {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: recording, withExtension: "wav"),
                                    "\(recording).wav is missing from the test bundle")
            app.launchArguments += ["-RomeVoiceInputRecording", url.path]
        } else {
            app.launchArguments += ["-RomeVoiceInputRecording", try humFile().path]
        }
        app.launch()
        return app
    }

    /// Fails the test with `message` when `control` does not show within 15 s, printing what the
    /// screen held instead so the CI log says why.
    @MainActor
    private func requireControl(_ app: XCUIApplication, _ control: XCUIElement, _ message: String) throws {
        if control.waitForExistence(timeout: 15) { return }
        printScreen(app, message)
        XCTFail(message)
        throw ControlMissing()
    }

    @MainActor
    private func printScreen(_ app: XCUIApplication, _ why: String) {
        print("--- \(why); the screen holds:\n\(app.debugDescription)\n---")
    }

    /// Fails the test, rather than letting every check after it fail for another reason, when
    /// the instance the CI job named does not answer.
    @MainActor
    private func assertAnswers(_ origin: String) throws {
        let url = try XCTUnwrap(URL(string: "\(origin)/api/voice-input"), "bad origin \(origin)")
        if (try? Data(contentsOf: url)) == nil {
            XCTFail("the stand-in instance at \(origin) does not answer")
            throw InstanceUnreachable()
        }
    }

    @MainActor
    private func waitForLabel(_ control: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: control)
        return XCTWaiter().wait(for: [shown], timeout: timeout) == .completed
    }
}

/// What the stand-in's control route answered, written once by the request's callback and read
/// after the test's wait for it.
private final class StandInReply: @unchecked Sendable {
    var status = 0
    var data: Data?
}

private struct InstanceUnreachable: Error {}
private struct ControlMissing: Error {}
