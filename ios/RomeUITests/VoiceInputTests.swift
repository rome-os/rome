import XCTest

/// Leg B of the voice input rules on iOS. It drives the Debug app on a simulator against the
/// stand-in instance, through the accessibility contract: the control is "Start voice input"
/// when idle, "Stop voice input" with the selected trait while listening, and "Finishing voice
/// input" while the last words arrive. The notice is its own element. Each test names the rule
/// it scores, so the verifier's report can say which leg scored which rule.
///
/// Rule 1's 0.5 s is timed inside the app, since XCUITest waits for the app to go idle around
/// every tap (1 to 13 s on a CI runner). The app marks each start with a `StartListening`
/// signpost interval, from the tap arriving to the field drawing listening; each test measures
/// it over five starts, and the CI job fails when any interval in the result bundle is over
/// 0.5 s.
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
        let card = app.buttons["task-card"].firstMatch
        guard card.waitForExistence(timeout: 10) else {
            printScreen(app, "no task card")
            throw XCTSkip("the instance has no task, so no task chat to open")
        }
        card.tap()
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
        control.tap()
        let words = NSPredicate(format: "value != nil AND value != ''")
        let shown = expectation(for: words, evaluatedWith: field)
        wait(for: [shown], timeout: 15)
        // The recording may end, and listening with it, before the guardian stops.
        if control.label == "Stop voice input" { control.tap() }
        XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 30), "the control never returned to idle")
        XCTAssertFalse((field.value as? String ?? "").isEmpty, "the words were gone after listening stopped")
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
            XCTAssertTrue(notice.waitForExistence(timeout: 5), "\(item.language): no notice within 5 s")
            XCTAssertTrue(item.says(notice.label), "\(item.language): the notice says \"\(notice.label)\"; wanted \(item.wanted)")
            let typed = "typed after refusing \(item.language) \(Int(Date().timeIntervalSince1970))"
            let field = onScreen(app.textViews, "message-field")
            field.tap()
            field.typeText(typed)
            XCTAssertEqual(field.value as? String, typed, "\(item.language): a key was lost after the notice")
            onScreen(app.buttons, "send").tap()
            XCTAssertTrue(app.staticTexts[typed].waitForExistence(timeout: 10), "\(item.language): the typed message was not sent")
            app.terminate()
        }
    }

    // MARK: Helpers

    /// Starts and stops `repeats` times in the open field: one tap shows listening, with the
    /// selected trait, and one tap shows finishing or idle. Each start's `StartListening`
    /// interval is measured; the CI job holds every one to rule 1's 0.5 s.
    @MainActor
    private func checkStartsAndStops(_ app: XCUIApplication, field: String) throws {
        let control = onScreen(app.buttons, "voice-input")
        try requireControl(app, control, "\(field) has no voice control")
        XCTAssertTrue(onScreen(app.textViews, "message-field").exists, "\(field) has no message field")
        let options = XCTMeasureOptions()
        options.iterationCount = Self.repeats
        options.invocationOptions = [.manuallyStop]
        var index = 0
        let startListening = XCTOSSignpostMetric(
            subsystem: "cc.romeos.voice-input", category: "VoiceInput", name: "StartListening")
        measure(metrics: [startListening], options: options) {
            index += 1
            XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 30), "\(field): not idle before start \(index)")
            XCTAssertTrue(tapUntil(control, ["Stop voice input"]), "\(field): start \(index) never showed listening")
            stopMeasuring()
            XCTAssertTrue(control.isSelected, "\(field): listening has no selected trait")
            XCTAssertTrue(
                tapUntil(control, ["Finishing voice input", "Start voice input"]),
                "\(field): stop \(index) never showed finishing or idle")
        }
    }


    /// Taps `control` and returns whether its label becomes one of `labels` within
    /// `settleSeconds` of the tap returning.
    @MainActor
    private func tapUntil(_ control: XCUIElement, _ labels: [String]) -> Bool {
        control.tap()
        let predicate = NSPredicate(format: "label IN %@", labels)
        let shown = XCTNSPredicateExpectation(predicate: predicate, object: control)
        return XCTWaiter().wait(for: [shown], timeout: Self.settleSeconds) == .completed
    }

    /// The element with `identifier` the guardian can touch: a pushed chat leaves the Chat's
    /// field under it, so there can be more than one.
    @MainActor
    private func onScreen(_ query: XCUIElementQuery, _ identifier: String) -> XCUIElement {
        let matches = query.matching(identifier: identifier)
        return matches.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? matches.firstMatch
    }

    /// Launches the app signed in to the stand-in instance, playing `recording` (a WAV in this
    /// bundle) as the microphone, or with the microphone as `microphone` says.
    @MainActor
    private func launch(recording: String = "speech", microphone: String? = nil, language: String = "en") throws -> XCUIApplication {
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
        } else {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: recording, withExtension: "wav"),
                                    "\(recording).wav is missing from the test bundle")
            app.launchArguments += ["-RomeVoiceInputRecording", url.path]
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
        var answered = false
        let done = expectation(description: "the instance answers")
        URLSession.shared.dataTask(with: url) { _, response, _ in
            answered = response != nil
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        if !answered {
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

private struct InstanceUnreachable: Error {}
private struct ControlMissing: Error {}
