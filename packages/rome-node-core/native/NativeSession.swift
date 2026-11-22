import Foundation
import Darwin

final class NativeWindowOccupancy: @unchecked Sendable {
    struct Record: Codable, Equatable {
        var version = 1
        let sessionId: String
        let windowKey: String
        let terminalCause: String?

        var confirmedReceipt: [String: Any]? {
            guard let terminalCause else { return nil }
            return ["sessionId": sessionId, "scope": "background", "status": terminalCause,
                    "terminalCause": terminalCause, "stopConfirmed": true, "effectVerified": false,
                    "replayAllowed": false, "localFocusCleanupPending": false]
        }
    }

    private let directory: URL
    private let lock = NSLock()

    init(directory: URL) { self.directory = directory }

    static func validSessionId(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil
    }

    private func occupancyPath(_ key: String) -> URL { directory.appendingPathComponent("occupied-" + key) }
    private func bindingPath(_ id: String) -> URL { directory.appendingPathComponent(id + ".binding.json") }
    private func confirmationPath(_ id: String) -> URL { directory.appendingPathComponent(id + ".confirmed.json") }

    private func read(_ path: URL) throws -> Record? {
        let fd = open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw NativeFailure("native_window_record_unavailable") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600, info.st_nlink == 1, info.st_size > 0, info.st_size <= 1024 else {
            throw NativeFailure("invalid_native_window_record")
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        guard let data = try handle.read(upToCount: 1025), data.count == Int(info.st_size),
              let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              Self.validSessionId(record.sessionId),
              record.windowKey.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              record.terminalCause.map({ $0.range(of: "^[a-z][a-z0-9_]{0,99}$", options: .regularExpression) != nil }) ?? true else {
            throw NativeFailure("invalid_native_window_record")
        }
        return record
    }

    private func syncDirectory() throws {
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeFailure("native_window_record_unavailable") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw NativeFailure("native_window_record_unavailable") }
    }

    private func create(_ record: Record, at path: URL) throws -> Bool {
        let pending = directory.appendingPathComponent(".window-" + UUID().uuidString)
        let fd = open(pending.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeFailure("native_window_record_unavailable") }
        defer { close(fd); _ = unlink(pending.path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        try handle.write(contentsOf: JSONEncoder().encode(record))
        guard fsync(fd) == 0 else { throw NativeFailure("native_window_record_unavailable") }
        if renamex_np(pending.path, path.path, UInt32(RENAME_EXCL)) != 0 {
            if errno == EEXIST { return false }
            throw NativeFailure("native_window_record_unavailable")
        }
        try syncDirectory()
        return true
    }

    func confirmation(_ id: String) throws -> Record? {
        try lock.withLock { try readConfirmation(id) }
    }

    private func readConfirmation(_ id: String) throws -> Record? {
        guard Self.validSessionId(id) else { throw NativeFailure("invalid_session") }
        guard let record = try read(confirmationPath(id)) else { return nil }
        guard record.sessionId == id, record.terminalCause != nil else { throw NativeFailure("invalid_native_window_record") }
        return record
    }

    func history(_ id: String) throws -> [String: Any]? {
        try lock.withLock {
            if let proof = try readConfirmation(id) { return proof.confirmedReceipt }
            guard let binding = try read(bindingPath(id)) else { return nil }
            guard binding.sessionId == id, binding.terminalCause == nil else {
                throw NativeFailure("invalid_native_window_record")
            }
            return ["sessionId": id, "status": "stop_pending", "stopConfirmed": false]
        }
    }

    // The helper's service lock and input lane serialize modifications for this directory.
    func claim(_ key: String, sessionId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard try readConfirmation(sessionId) == nil else { throw NativeFailure("session_id_used") }
        let path = occupancyPath(key)
        if let occupied = try read(path) {
            guard occupied.windowKey == key, occupied.terminalCause == nil else { throw NativeFailure("invalid_native_window_record") }
            guard try readConfirmation(occupied.sessionId)?.windowKey == key else {
                throw NativeFailure("window_stop_unconfirmed", details: ["stopConfirmed": false])
            }
            guard unlink(path.path) == 0 else { throw NativeFailure("native_window_record_unavailable") }
        }
        let binding = Record(sessionId: sessionId, windowKey: key, terminalCause: nil)
        guard try create(binding, at: bindingPath(sessionId)) else { throw NativeFailure("session_id_used") }
        guard try create(binding, at: path) else {
            throw NativeFailure("window_stop_unconfirmed", details: ["stopConfirmed": false])
        }
    }

    func confirm(_ key: String, sessionId: String, cause: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let record = Record(sessionId: sessionId, windowKey: key, terminalCause: cause)
        if try !create(record, at: confirmationPath(sessionId)) {
            guard try readConfirmation(sessionId) == record else { throw NativeFailure("invalid_native_window_record") }
            try syncDirectory()
        }
        let path = occupancyPath(key)
        if try read(path)?.sessionId == sessionId {
            guard unlink(path.path) == 0 else { throw NativeFailure("native_window_record_unavailable") }
            try syncDirectory()
        }
    }
}

// The lock serializes terminal causes and dispatch counters. Cancellation never takes the input lane.
final class NativeSessionStop: @unchecked Sendable {
    let id: String
    let path: URL
    private let lock = NSLock()
    private var cause: String?
    private var stoppedAt: Double?
    private var diagnostic: [String: Any] = [:]
    private var count = 0
    private var actionID: String?

    init(id: String, directory: URL) {
        self.id = id
        path = directory.appendingPathComponent(id + ".json")
    }

    var terminal: String? { lock.lock(); defer { lock.unlock() }; return cause }
    var terminalTime: Double? { lock.lock(); defer { lock.unlock() }; return stoppedAt }
    var terminalDiagnostic: [String: Any] { lock.lock(); defer { lock.unlock() }; return diagnostic }
    var eventsPosted: Int { lock.lock(); defer { lock.unlock() }; return count }
    func recordEvent() { lock.lock(); count += 1; lock.unlock() }
    func actionContext(_ id: String?) { lock.lock(); actionID = id; lock.unlock() }

    @discardableResult func stop(_ reason: String, diagnostic details: [String: Any] = [:]) -> String {
        lock.lock()
        defer { lock.unlock() }
        if let cause { return cause }
        let file = open(path.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
        let at = Date().timeIntervalSince1970
        if file >= 0 {
            var details = details
            details["eventsPosted"] = count
            if let actionID { details["actionId"] = actionID }
            let record: [String: Any] = ["sessionId": id, "terminalCause": reason, "at": at, "diagnostic": details]
            let data = (try? JSONSerialization.data(withJSONObject: record)) ?? Data()
            let written = data.withUnsafeBytes { Darwin.write(file, $0.baseAddress, data.count) }
            let saved = written == data.count && fsync(file) == 0
            close(file)
            let directory = open(path.deletingLastPathComponent().path, O_RDONLY)
            let durable = directory >= 0 && fsync(directory) == 0
            if directory >= 0 { close(directory) }
            cause = saved && durable ? reason : "unknown"
            stoppedAt = at
            diagnostic = details
        } else {
            let fd = open(path.path, O_RDONLY | O_NOFOLLOW)
            defer { if fd >= 0 { close(fd) } }
            var info = stat()
            var bytes = [UInt8](repeating: 0, count: 8192)
            let safe = fd >= 0 && fstat(fd, &info) == 0 && info.st_uid == getuid()
                && info.st_mode & S_IFMT == S_IFREG && info.st_mode & 0o777 == 0o600
                && info.st_size > 0 && info.st_size <= bytes.count
            let received = safe ? read(fd, &bytes, bytes.count) : -1
            let record = received > 0 ? try? JSONSerialization.jsonObject(with: Data(bytes.prefix(received))) as? [String: Any] : nil
            cause = record?["sessionId"] as? String == id ? (record?["terminalCause"] as? String ?? "unknown") : "unknown"
            stoppedAt = record?["at"] as? Double ?? at
            diagnostic = record?["diagnostic"] as? [String: Any] ?? [:]
        }
        return cause!
    }
}
