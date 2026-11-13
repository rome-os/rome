import Foundation
import Observation
import OSLog

let taskListLog = Logger(subsystem: "cc.romeos.mobile", category: "TaskList")

/// One Concierge chat's task list, the Agent page's Tasks tab: what runs for
/// the chat, as the server groups it. It reads again whenever the live socket
/// says something in it changed, and after a reconnect
/// (docs/domains/chats.md#task-list).
@MainActor
@Observable
final class TaskListStore {
    /// The chat's server id.
    let chatId: String
    private(set) var groups: [TaskListGroup] = []
    private(set) var loaded = false
    private(set) var loadFailed = false
    /// Tasks whose Stop was pressed and has not shown its effect yet.
    private(set) var stopping: Set<String> = []
    /// Goes up each time a press fails; the page shows a brief notice.
    private(set) var failures = 0
    private(set) var failure: String?

    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private var tokens: [UUID] = []
    @ObservationIgnored private var reads = 0
    /// The read whose list is shown; 0 before any.
    @ObservationIgnored private var applied = 0

    /// How many ended rows a page holds, as the server pages them.
    nonisolated static let endedPage = 20

    /// Ended pages read with "Show more", after the list's own first page.
    private(set) var olderEnded: [TaskListItem] = []
    /// Where the next older page starts once one was read; nil before any.
    @ObservationIgnored private var olderCursor: String??
    private(set) var loadingMore = false

    /// The Ended group as shown: its first page, then the older pages read
    /// since, each row once.
    var endedItems: [TaskListItem] {
        guard let first = groups.first(where: { $0.key == .ended }) else { return [] }
        let ids = Set(first.items.map(\.id))
        return first.items + olderEnded.filter { !ids.contains($0.id) }
    }

    /// How many ended rows there are in all.
    var endedTotal: Int {
        groups.first(where: { $0.key == .ended })?.total ?? endedItems.count
    }

    /// The cursor of the next page to read, or nil when there is none.
    private var endedCursor: String? {
        if let olderCursor { return olderCursor }
        return groups.first(where: { $0.key == .ended })?.nextCursor
    }

    /// How many ended rows are still to read.
    var endedMore: Int { endedCursor == nil ? 0 : max(endedTotal - endedItems.count, 0) }

    /// "Show more": the next page of Ended, by the cursor the last page gave.
    func showMoreEnded() {
        guard let cursor = endedCursor, !loadingMore else { return }
        loadingMore = true
        Task {
            defer { loadingMore = false }
            do {
                let page = try await backend.endedTasks(chatId: chatId, endedBefore: cursor)
                let ended = page.groups.first { $0.key == .ended }
                olderEnded += ended?.items ?? []
                olderCursor = .some(ended?.nextCursor)
            } catch {
                taskListLog.error("ended page of \(self.chatId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                fail(String(localized: "Failed to load tasks"))
            }
        }
    }

    init(chatId: String, backend: RomeBackend) {
        self.chatId = chatId
        self.backend = backend
    }

    /// The page opened: listen for changes and read the list now. The read
    /// is the store's own, so no view going away can cancel it. A list read
    /// before shows at once; a tab that failed shows its spinner again while
    /// this read runs, so "Failed to load tasks" only ever follows a read
    /// that failed.
    func open() {
        start()
        if groups.isEmpty, loadFailed {
            loadFailed = false
            loaded = false
        }
        Task { await load() }
    }

    /// Listens for changes, and reads the list the first time.
    func start() {
        guard tokens.isEmpty else { return }
        tokens.append(backend.events.subscribe(LiveTopic.chatTasks(chatId)) { [weak self] event in
            self?.handle(event)
        })
        if !loaded { Task { await load() } }
    }

    func stop() {
        for token in tokens { backend.events.unsubscribe(token) }
        tokens = []
    }

    func load() async {
        reads += 1
        let mine = reads
        taskListLog.notice("read \(mine) of \(self.chatId, privacy: .public)")
        do {
            let list = try await backend.taskList(chatId: chatId)
            // A newer read already put its list up: this older one gives way.
            guard mine > applied else { return }
            applied = mine
            groups = TaskListGroup.ordered(list.groups)
            loadFailed = false
            loaded = true
            // A stop shows its effect once the task reads as ended.
            stopping = stopping.filter { id in task(id).map { !TaskListWords.isEnded($0.task) } ?? false }
        } catch is CancellationError {
            // A read given up on says nothing about the list.
            taskListLog.notice("read \(mine) cancelled")
        } catch {
            taskListLog.error("read \(mine) of \(self.chatId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            // What is shown stays. Only with no list at all, and no other read
            // on its way that could still bring one, does the tab say it failed.
            guard groups.isEmpty, applied == 0, mine == reads else { return }
            loadFailed = true
            loaded = true
        }
    }

    private func handle(_ event: LiveEvent) {
        switch event {
        case .taskListChanged(let id) where id == chatId:
            Task { await load() }
        case .reconnected:
            Task { await load() }
        default:
            break
        }
    }

    func task(_ id: String) -> TaskListItem.Task? {
        for group in groups {
            for case .task(let item) in group.items where item.task.id == id { return item }
        }
        return nil
    }

    /// Stops a task at once: its row shows it stopping until the list reads
    /// it as ended. A failure takes the row back and says so briefly.
    func stopTask(_ id: String) {
        guard stopping.insert(id).inserted else { return }
        Task {
            do {
                try await backend.stopListedTask(chatId: chatId, taskId: id)
                await load()
            } catch {
                stopping.remove(id)
                fail(String(localized: "Failed to stop the task"))
            }
        }
    }

    /// A brief notice on the list.
    func fail(_ text: String) {
        failure = text
        failures += 1
    }
}

/// How the task list words its rows: one line of state, then the time that
/// goes with it. Pure, so the wording is tested without a view.
enum TaskListWords {
    /// "Waiting for your answer · 5 min ago": the parts that are there, joined.
    static func line(_ parts: String?...) -> String {
        parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The four statuses the server derives; without one, the row's own state decides.
    static func status(_ task: ConciergeTask) -> String {
        if let status = task.status, ["needs_you", "active", "later", "ended"].contains(status) { return status }
        switch task.state {
        case .needsUser: return "needs_you"
        case .next, .watching: return "later"
        case .done, .dropped: return "ended"
        case .doing: return "active"
        }
    }

    static func isEnded(_ task: ConciergeTask) -> Bool { status(task) == "ended" }

    /// What a task's line says: what it waits for, that it runs, when it
    /// runs next, or how it ended.
    static func task(_ item: TaskListItem.Task, now: Date, stopping: Bool = false) -> String {
        if stopping { return String(localized: "Stopping…") }
        let task = item.task
        let repeats = item.schedule.map(schedule)
        switch status(task) {
        case "needs_you":
            let what = task.openWait?["kind"]?.string == "approval"
                ? String(localized: "Waiting for your approval")
                : String(localized: "Waiting for your answer")
            return line(what, task.waitingSince.map { time($0, now: now) })
        case "later":
            if let check = item.check, let at = check.at {
                return check.recurring
                    ? line(repeats, time(at, now: now))
                    : String(localized: "Checks \(time(at, now: now))")
            }
            if let repeats { return repeats }
            if let at = task.laterAt { return String(localized: "Checks \(time(at, now: now))") }
            // Not started: its age, so a stale one stands out.
            return String(localized: "Not started · Created \(age(task.createdAt, now: now))")
        case "ended":
            let how: String
            switch task.endReason {
            case "failed": how = String(localized: "Failed")
            case "stopped": how = String(localized: "Stopped")
            case "no_response": how = String(localized: "No response")
            default: how = String(localized: "Done")
            }
            return line(how, time(task.completedAt ?? task.updatedAt, now: now))
        default:
            return line(repeats, String(localized: "Running"))
        }
    }

    static func check(_ item: TaskListItem.Check, now: Date) -> String {
        let when = item.check.at.map { time($0, now: now) }
        if let what = item.check.waitingFor, !what.isEmpty {
            return line(String(localized: "Waiting for \(what)"), when)
        }
        return when.map { String(localized: "Checks \($0)") } ?? ""
    }

    static func follow(_ item: TaskListItem.Follow) -> String {
        let state: String?
        switch item.state {
        case "unavailable": state = String(localized: "Not available")
        case "off": state = String(localized: "Off")
        default: state = nil
        }
        let digest = item.digestTimes.isEmpty ? nil : String(localized: "Digest daily at \(list(item.digestTimes.map(clock)))")
        return line(item.label, state, digest)
    }

    static func routine(_ item: TaskListItem.Routine, now: Date) -> String {
        line(
            trigger(item.trigger),
            item.enabled ? nil : String(localized: "Paused"),
            item.nextRunAt.map { time($0, now: now) },
            item.lastRun?.status == "error" ? String(localized: "Last run failed") : nil
        )
    }

    /// "Daily at 3:47 PM", "Mon, Wed at 9:00 AM".
    static func schedule(_ schedule: TaskListItem.Schedule) -> String {
        let at = clock(schedule.at)
        guard let days = schedule.days, days.count < 7 else { return String(localized: "Daily at \(at)") }
        return String(localized: "\(weekdays(days)) at \(at)")
    }

    /// When a routine fires, as its row says it.
    static func trigger(_ trigger: TaskListItem.Routine.Trigger) -> String {
        switch trigger.type {
        case "manual":
            return String(localized: "Only when run by hand")
        case "event-bus":
            return String(localized: "When \(trigger.eventName ?? "") arrives")
        case "schedule":
            let at = clock(trigger.localTime ?? "")
            if let date = trigger.date {
                return String(localized: "\(day(date)) at \(at)")
            }
            var rule: [String: String] = [:]
            for part in (trigger.rrule ?? "").uppercased().split(separator: ";") {
                let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
                if pair.count == 2 { rule[pair[0]] = pair[1] }
            }
            let interval = rule["INTERVAL"].flatMap(Int.init) ?? 1
            if rule["FREQ"] == "DAILY", interval == 1 { return String(localized: "Daily at \(at)") }
            if rule["FREQ"] == "WEEKLY", interval == 1, let byDay = rule["BYDAY"] {
                let codes = ["MO": "mon", "TU": "tue", "WE": "wed", "TH": "thu", "FR": "fri", "SA": "sat", "SU": "sun"]
                let days = byDay.split(separator: ",").compactMap { codes[String($0)] }
                if days.count == 7 { return String(localized: "Daily at \(at)") }
                return String(localized: "\(weekdays(days)) at \(at)")
            }
            return String(localized: "On a schedule")
        default:
            return String(localized: "On a schedule")
        }
    }

    /// "today", "yesterday", "3 days ago": a not-started task's age, by calendar day.
    static func age(_ createdAt: Double, now: Date, calendar: Calendar = .current) -> String {
        let made = Date(timeIntervalSince1970: createdAt / 1000)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: made), to: calendar.startOfDay(for: now)).day ?? 0
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = RelativeTime.locale
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .full
        return formatter.localizedString(from: DateComponents(day: -max(days, 0)))
    }

    /// A row's menu title: "Created Today 09:12", in the message menu's date style.
    static func created(_ date: Date, now: Date = .now) -> String {
        String(localized: "Created \(RelativeTime.separator(date, now: now))")
    }

    // MARK: Times

    /// "in 17 hr", "2 hr ago", "now": the time as a row says it.
    static func time(_ at: Double, now: Date) -> String {
        let seconds = (at / 1000 - now.timeIntervalSince1970).rounded()
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = RelativeTime.locale
        formatter.unitsStyle = .short
        formatter.dateTimeStyle = .named
        var components = DateComponents()
        if abs(seconds) >= 86_400 { components.day = Int((seconds / 86_400).rounded()) }
        else if abs(seconds) >= 3_600 { components.hour = Int((seconds / 3_600).rounded()) }
        else if abs(seconds) >= 60 { components.minute = Int((seconds / 60).rounded()) }
        else { components.second = 0 }
        // The short style dots its abbreviations ("in 25 min."), which reads as noise in a row.
        return formatter.localizedString(from: components).replacingOccurrences(of: ".", with: "")
    }

    /// "3:47 PM" from a stored `HH:mm`, as the guardian's locale writes it.
    static func clock(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return hhmm }
        var components = DateComponents()
        components.year = 2024
        components.month = 1
        components.day = 1
        components.hour = parts[0]
        components.minute = parts[1]
        guard let date = Calendar(identifier: .gregorian).date(from: components) else { return hhmm }
        let formatter = DateFormatter()
        formatter.locale = RelativeTime.locale
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    /// "Mon, Wed": weekdays by short name, in week order.
    static func weekdays(_ days: [String]) -> String {
        let order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        let formatter = DateFormatter()
        formatter.locale = RelativeTime.locale
        // `shortWeekdaySymbols` starts on Sunday.
        let symbols = formatter.shortWeekdaySymbols ?? []
        let names = order.enumerated().compactMap { index, day -> String? in
            guard days.contains(day), symbols.count == 7 else { return nil }
            return symbols[(index + 1) % 7]
        }
        return list(names)
    }

    private static func day(_ date: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let parsed = parser.date(from: date) else { return date }
        let formatter = DateFormatter()
        formatter.locale = RelativeTime.locale
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter.string(from: parsed)
    }

    private static func list(_ items: [String]) -> String {
        let formatter = ListFormatter()
        formatter.locale = RelativeTime.locale
        return formatter.string(from: items) ?? items.joined(separator: ", ")
    }
}
