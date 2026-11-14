import Foundation
import Testing
@testable import Rome

/// A folder for one test's log, removed after.
final class AuditFolder: @unchecked Sendable {
    let url = FileManager.default.temporaryDirectory.appending(path: "rome-audit-\(UUID().uuidString)")
    var log: URL { url.appending(path: "node-audit.jsonl") }

    init() { try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
    deinit { try? FileManager.default.removeItem(at: url) }

    var text: String { (try? String(contentsOf: log, encoding: .utf8)) ?? "" }
}

/// Keeps the clock a test moves.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ start: Date) { value = start }
    var now: Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

@Suite struct NodeAuditLogTests {
    private let clock = TestClock(HealthFixtures.now)

    private func log(_ folder: AuditFolder) -> NodeAuditLog {
        let clock = clock
        return NodeAuditLog(url: folder.log, now: { clock.now })
    }

    @Test func recordsARequestBeforeItRunsAndHowItEnded() async throws {
        let folder = AuditFolder()
        let audit = log(folder)
        let seq = try #require(await audit.begin(requestId: "r1", from: "inst-1", action: "health.stats", args: parseJSON(#"{"type":"stepCount"}"#)))
        // Before the request runs, its start is already on disk.
        #expect(folder.text.contains(#""action":"health.stats""#))
        #expect(!folder.text.contains(#""event":"end""#))
        clock.advance(2)
        await audit.end(seq, outcome: .ok, errorCode: nil, count: 3, window: ("2026-11-09T00:00:00+08:00", "2026-11-09T18:30:00+08:00"), durationMs: 40)
        let entries = await audit.recent(limit: 50)
        #expect(entries.count == 1)
        let entry = try #require(entries.first)
        #expect(entry.action == "health.stats")
        #expect(entry.from == "inst-1")
        #expect(entry.args == #"{"type":"stepCount"}"#)
        #expect(entry.outcome == .ok)
        #expect(entry.count == 3)
        #expect(entry.windowStart == HealthFixtures.date("2026-11-08T16:00:00Z"))
        #expect(entry.windowEnd == HealthFixtures.date("2026-11-09T10:30:00Z"))
        #expect(entry.durationMs == 40)
        #expect(entry.time == RomeDate.parse(RomeDate.string(HealthFixtures.now)))
        #expect(await audit.status() == .ok)
    }

    @Test func listsNewestFirstAndAtMostTheLimit() async {
        let folder = AuditFolder()
        let audit = log(folder)
        for index in 0..<5 {
            let seq = await audit.begin(requestId: "r\(index)", from: "a", action: "health.samples", args: nil)!
            await audit.end(seq, outcome: index == 2 ? .error : .ok, errorCode: index == 2 ? "invalid_args" : nil, count: nil, window: nil, durationMs: 1)
        }
        let entries = await audit.recent(limit: 3)
        #expect(entries.map(\.seq) == [5, 4, 3])
        #expect(entries.map(\.outcome) == [.ok, .ok, .error])
        #expect(entries.last?.errorCode == "invalid_args")
    }

    @Test func aRequestWithoutAnEndShowsNoOutcome() async throws {
        let folder = AuditFolder()
        let audit = log(folder)
        _ = await audit.begin(requestId: "r1", from: "a", action: "health.stats", args: nil)
        #expect(await audit.recent(limit: 5).first?.outcome == nil)
    }

    @Test func removingAllEmptiesTheLogAndKeepsCounting() async throws {
        let folder = AuditFolder()
        let audit = log(folder)
        let first = try #require(await audit.begin(requestId: "r1", from: "inst-1", action: "health.stats", args: nil))
        await audit.end(first, outcome: .ok, errorCode: nil, count: 1, window: nil, durationMs: 3)
        await audit.removeAll()
        #expect(!FileManager.default.fileExists(atPath: folder.log.path(percentEncoded: false)))
        #expect(await audit.recent(limit: 50).isEmpty)
        #expect(await audit.status() == .ok)
        // The next account's request is written, under a new number: a late end
        // of the old account's request never lands on it.
        let next = try #require(await audit.begin(requestId: "r2", from: "inst-2", action: "health.samples", args: nil))
        #expect(next > first)
        #expect(await audit.recent(limit: 50).map(\.from) == ["inst-2"])
    }

    @Test func numbersGoOnAcrossRestarts() async {
        let folder = AuditFolder()
        _ = await log(folder).begin(requestId: "r1", from: "a", action: "x", args: nil)
        _ = await log(folder).begin(requestId: "r2", from: "a", action: "x", args: nil)
        #expect(await log(folder).recent(limit: 10).map(\.seq) == [2, 1])
    }

    @Test func longArgsAreNotKeptWhole() async {
        let folder = AuditFolder()
        let audit = log(folder)
        let big = JSONValue.object(["note": .string(String(repeating: "x", count: 5000))])
        _ = await audit.begin(requestId: "r1", from: "a", action: "health.stats", args: big)
        #expect(folder.text.count < 1000)
        #expect(await audit.recent(limit: 1).first?.args == #"{"truncated":true}"#)
    }

    @Test func linesOlderThanThirtyDaysAreRemovedWhenTheLogOpens() async throws {
        let folder = AuditFolder()
        let old = RomeDate.string(HealthFixtures.now.addingTimeInterval(-31 * 86_400))
        let recent = RomeDate.string(HealthFixtures.now.addingTimeInterval(-29 * 86_400))
        let lines = [
            #"{"action":"health.stats","event":"start","from":"a","requestId":"r1","seq":1,"time":"\#(old)"}"#,
            #"{"durationMs":5,"event":"end","outcome":"ok","seq":1,"time":"\#(old)"}"#,
            #"{"action":"health.samples","event":"start","from":"a","requestId":"r2","seq":2,"time":"\#(recent)"}"#,
            #"{"durationMs":5,"event":"end","outcome":"ok","seq":2,"time":"\#(recent)"}"#,
        ]
        try (lines.joined(separator: "\n") + "\n").write(to: folder.log, atomically: true, encoding: .utf8)
        let audit = log(folder)
        let entries = await audit.recent(limit: 50)
        #expect(entries.map(\.seq) == [2])
        #expect(!folder.text.contains(old), "pruned on disk, not only hidden")
        // Numbers keep rising past what was pruned.
        #expect(await audit.begin(requestId: "r3", from: "a", action: "x", args: nil) == 3)
        // Two days on, the 29-day-old lines are past thirty days as well.
        clock.advance(2 * 86_400)
        #expect(await log(folder).recent(limit: 50).map(\.seq) == [3])
    }

    @Test func aFolderThatCannotBeMadeMeansUnavailableAndNoRequestIsRecorded() async throws {
        let folder = AuditFolder()
        let blocker = folder.url.appending(path: "file")
        try "x".write(to: blocker, atomically: true, encoding: .utf8)
        let audit = NodeAuditLog(url: blocker.appending(path: "node-audit.jsonl"))
        #expect(await audit.begin(requestId: "r1", from: "a", action: "health.stats", args: nil) == nil)
        guard case .unavailable = await audit.status() else {
            Issue.record("expected unavailable")
            return
        }
    }

    @Test func aWriteThatFailsMeansNoRequestIsRecordedUntilItWorksAgain() async throws {
        let folder = AuditFolder()
        let audit = log(folder)
        #expect(await audit.begin(requestId: "r1", from: "a", action: "x", args: nil) == 1)
        // The log file becomes a folder: nothing can be appended.
        try FileManager.default.removeItem(at: folder.log)
        try FileManager.default.createDirectory(at: folder.log, withIntermediateDirectories: false)
        #expect(await audit.begin(requestId: "r2", from: "a", action: "x", args: nil) == nil)
        guard case .unavailable = await audit.status() else {
            Issue.record("expected unavailable")
            return
        }
        try FileManager.default.removeItem(at: folder.log)
        #expect(await audit.begin(requestId: "r3", from: "a", action: "x", args: nil) == 2)
        #expect(await audit.status() == .ok)
    }

    @Test func stateGoesIntoSystemInfo() {
        #expect(NodeAuditState.ok.json == parseJSON(#"{"state":"ok"}"#))
        let down = NodeAuditState.unavailable("The audit log could not be written.").json
        #expect(down["state"]?.string == "unavailable")
        #expect(down["message"]?.string == "The audit log could not be written.")
    }
}

/// An audit log a test controls.
final class FakeAudit: NodeAuditing, @unchecked Sendable {
    var refuse = false
    // Requests run at once on the executor's threads: every record goes through the lock.
    private let lock = NSLock()
    private var begunRecords: [(from: String, action: String, args: JSONValue?)] = []
    private var endedRecords: [(outcome: NodeOutcome, errorCode: String?, count: Int?, window: (start: String, end: String)?)] = []
    var begun: [(from: String, action: String, args: JSONValue?)] { lock.withLock { begunRecords } }
    var ended: [(outcome: NodeOutcome, errorCode: String?, count: Int?, window: (start: String, end: String)?)] { lock.withLock { endedRecords } }

    func status() async -> NodeAuditState { refuse ? .unavailable("down") : .ok }

    func begin(requestId: String, from: String, action: String, args: JSONValue?) async -> Int? {
        guard !refuse else { return nil }
        return lock.withLock {
            begunRecords.append((from, action, args))
            return begunRecords.count
        }
    }

    func end(_ seq: Int, outcome: NodeOutcome, errorCode: String?, count: Int?, window: (start: String, end: String)?, durationMs: Int) async {
        lock.withLock { endedRecords.append((outcome, errorCode, count, window)) }
    }

    func recent(limit: Int) async -> [NodeAuditEntry] { [] }

    private(set) var removals = 0
    func removeAll() async { removals += 1 }
}

@Suite struct NodeExecutorTests {
    private func executor(_ health: FakeHealth, _ audit: NodeAuditing) -> NodeExecutor {
        NodeExecutor(name: { "Ray's iPhone" }, audit: audit, registry: .testing(HealthFixtures.actions(health)))
    }

    private func envelope(_ action: String, _ args: String? = nil) -> String {
        let args = args.map { #","args":\#($0)"# } ?? ""
        return #"{"id":"r1","from":"inst-1","payload":{"type":"request","action":"\#(action)"\#(args)}}"#
    }

    private func reply(_ text: String?) throws -> JSONValue {
        parseJSON(try #require(text))
    }

    @Test func systemInfoDescribesThePhone() async throws {
        let sent = try reply(await executor(FakeHealth(), FakeAudit()).respond(to: envelope("system.info"), session: NodeSession()))
        let result = try #require(sent["payload"]?["result"])
        #expect(sent["to"]?.string == "inst-1")
        #expect(result["name"]?.string == "Ray's iPhone")
        #expect(result["platform"]?.string == "ios")
        #expect(result["actions"]?.array?.compactMap(\.string) == ["system.info", "health.stats", "health.samples", "device.status"])
        #expect(result["audit"] == parseJSON(#"{"state":"ok"}"#))
        let usage = try #require(result["usage"]?.object)
        #expect(Set(usage.keys) == ["system.info", "health.stats", "health.samples", "device.status"])
        #expect(usage["health.stats"]?.string?.contains("stepCount") == true)
        // Binary frames are not offered.
        #expect(result["frameVersion"] == nil)
        #expect(result["transferVersion"] == nil)
    }

    @Test func systemInfoIsNotRecordedButOtherRequestsAre() async throws {
        let audit = FakeAudit()
        let executor = executor(FakeHealth(), audit)
        _ = await executor.respond(to: envelope("system.info"), session: NodeSession())
        #expect(audit.begun.isEmpty)
        _ = await executor.respond(to: envelope("health.stats", #"{"type":"stepCount"}"#), session: NodeSession())
        #expect(audit.begun.count == 1)
        #expect(audit.begun.first?.from == "inst-1")
        #expect(audit.begun.first?.action == "health.stats")
        #expect(audit.begun.first?.args == parseJSON(#"{"type":"stepCount"}"#))
        #expect(audit.ended.first?.outcome == .ok)
        #expect(audit.ended.first?.count == 1)
        // The window the reply named goes into the record.
        #expect(audit.ended.first?.window?.start == "2026-11-09T00:00:00+08:00")
        #expect(audit.ended.first?.window?.end == "2026-11-09T18:30:00+08:00")
    }

    @Test func withAppleHealthOffARequestIsRecordedAndRefused() async throws {
        let audit = FakeAudit()
        let health = FakeHealth()
        var actions = HealthFixtures.actions(health)
        actions.enabled.set(false)
        let executor = NodeExecutor(name: { "iPhone" }, audit: audit, registry: .testing(actions))
        let sent = try reply(await executor.respond(to: envelope("health.stats", #"{"type":"stepCount"}"#), session: NodeSession()))
        #expect(sent["payload"]?["error"]?["code"]?.string == "health_off")
        #expect(audit.begun.count == 1)
        #expect(audit.ended.first?.outcome == .error)
        #expect(audit.ended.first?.errorCode == "health_off")
        #expect(health.reads == 0 && health.accessRequests == 0)
        // system.info still lists the actions, so an agent can explain.
        let info = try reply(await executor.respond(to: envelope("system.info"), session: NodeSession()))
        #expect(info["payload"]?["result"]?["actions"]?.array?.count == 4)
    }

    @Test func aRequestTheLogCannotRecordDoesNotRun() async throws {
        let audit = FakeAudit()
        audit.refuse = true
        let health = FakeHealth()
        let sent = try reply(await executor(health, audit).respond(to: envelope("health.stats", #"{"type":"stepCount"}"#), session: NodeSession()))
        #expect(sent["payload"]?["ok"]?.bool == false)
        #expect(sent["payload"]?["error"]?["code"]?.string == "audit_unavailable")
        #expect(health.accessRequests == 0 && health.reads == 0, "nothing ran, not even the Health permission sheet")
        // system.info still answers, and says why.
        let info = try reply(await executor(health, audit).respond(to: envelope("system.info"), session: NodeSession()))
        #expect(info["payload"]?["ok"]?.bool == true)
        #expect(info["payload"]?["result"]?["audit"]?["state"]?.string == "unavailable")
    }

    @Test func unknownActionsAreRecordedAndAnswered() async throws {
        let audit = FakeAudit()
        let sent = try reply(await executor(FakeHealth(), audit).respond(to: envelope("exec", #"{"command":"ls"}"#), session: NodeSession()))
        #expect(sent["payload"]?["error"]?["code"]?.string == "unsupported_action")
        #expect(audit.begun.first?.action == "exec")
        #expect(audit.ended.first?.outcome == .error)
        #expect(audit.ended.first?.errorCode == "unsupported_action")
    }

    @Test func errorsAreRecordedWithTheirCode() async throws {
        let audit = FakeAudit()
        let sent = try reply(await executor(FakeHealth(), audit).respond(to: envelope("health.stats", #"{"type":"bloodType"}"#), session: NodeSession()))
        #expect(sent["payload"]?["error"]?["code"]?.string == "unsupported_type")
        #expect(audit.ended.first?.errorCode == "unsupported_type")
    }

    @Test func aRequestCutOffByTheConnectionIsRecordedAsInterrupted() async throws {
        let audit = FakeAudit()
        let session = NodeSession()
        session.end()
        _ = await executor(FakeHealth(), audit).respond(to: envelope("health.stats", #"{"type":"stepCount"}"#), session: session)
        #expect(audit.ended.first?.outcome == .interrupted)
    }

    @Test func nothingIsAnsweredForWhatIsNotARequest() async {
        #expect(await executor(FakeHealth(), FakeAudit()).respond(to: #"{"id":"r1","type":"error","code":"target_unavailable"}"#, session: NodeSession()) == nil)
    }

    @Test func healthValuesNeverReachTheLog() async throws {
        let folder = AuditFolder()
        let health = FakeHealth()
        health.quantities["stepCount"] = [123_456]
        health.sampleStore = [HealthFixtures.sample("secret-sample-id", "2026-11-09T10:00:00Z", value: 98_765)]
        let audit = NodeAuditLog(url: folder.log)
        let executor = NodeExecutor(name: { "iPhone" }, audit: audit, registry: .testing(HealthFixtures.actions(health)))
        let stats = try reply(await executor.respond(to: envelope("health.stats", #"{"type":"stepCount"}"#), session: NodeSession()))
        let samples = try reply(await executor.respond(to: envelope("health.samples", #"{"type":"heartRate"}"#), session: NodeSession()))
        // The caller got the values...
        #expect(stats["payload"]?["result"]?["results"]?.array?.first?["value"]?.number == 123_456)
        #expect(samples["payload"]?["result"]?["samples"]?.array?.first?["value"]?.number == 98_765)
        // ...the log has the counts.
        #expect(!folder.text.contains("123456") && !folder.text.contains("98765") && !folder.text.contains("secret-sample-id"))
        let entries = await audit.recent(limit: 10)
        #expect(entries.map(\.count) == [1, 1])
    }
}
