import Foundation
import Observation
import OSLog
import SwiftUI

private let taskLinkLog = Logger(subsystem: "cc.romeos.mobile", category: "TaskLinks")

/// What the task links of one Concierge chat show: each task chat's live name
/// and status (docs/domains/chats.md#task-link). The chat's messages register
/// the task chats they name; one read answers for all of them, and the chat's
/// `tasks_changed` events read it again, so a chip moves as its task chat runs.
@MainActor
@Observable
final class TaskLinkStore {
    /// The chat's server id.
    let chatId: String
    /// The task chats read so far, by id.
    private(set) var info: [String: TaskLinkInfo] = [:]
    /// Every id a read was asked about: one not in `info` after that is none
    /// of this chat's, and its link reads as plain text.
    private(set) var asked: Set<String> = []

    @ObservationIgnored private let backend: RomeBackend
    @ObservationIgnored private var wanted: Set<String> = []
    @ObservationIgnored private var tokens: [UUID] = []
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var readAgain = false

    init(chatId: String, backend: RomeBackend) {
        self.chatId = chatId
        self.backend = backend
    }

    /// A message names these task chats: they are read now, and again whenever
    /// the chat's tasks change.
    func register(_ ids: Set<String>) {
        guard !ids.isSubset(of: wanted) else { return }
        wanted.formUnion(ids)
        start()
        read()
    }

    /// Listens for changes, once.
    private func start() {
        guard tokens.isEmpty else { return }
        tokens.append(backend.events.subscribe(LiveTopic.chatTasks(chatId)) { [weak self] _ in
            self?.read()
        })
    }

    func stop() {
        for token in tokens { backend.events.unsubscribe(token) }
        tokens = []
    }

    /// Reads every wanted id; a read asked for while one runs follows it.
    private func read() {
        guard !reading else {
            readAgain = true
            return
        }
        reading = true
        Task {
            repeat {
                readAgain = false
                let ids = wanted
                do {
                    let response = try await backend.taskLinks(chatId: chatId, ids: ids.sorted())
                    for id in ids { info[id] = nil }
                    for found in response.tasks { info[found.id] = found }
                    asked.formUnion(ids)
                } catch {
                    taskLinkLog.error("task links of \(self.chatId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                }
            } while readAgain
            reading = false
        }
    }
}

extension EnvironmentValues {
    /// The task links of the Concierge chat on screen. Nil elsewhere, where a
    /// task link reads as its text.
    @Entry var taskLinks: TaskLinkStore? = nil
}
