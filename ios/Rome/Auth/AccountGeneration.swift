import Foundation

/// Counts the Rome Cloud accounts this phone has been signed in to in this
/// run. It goes up on sign-out and whenever the credential is replaced, so
/// work begun under one account can tell that it no longer belongs.
///
/// `ifCurrent` and `end` share one lock: a write that passed the check has
/// landed before `end` returns, so a wipe after `end` always comes after it.
final class AccountGeneration: Sendable {
    private let lock = NSLock()
    nonisolated(unsafe) private var value = 0

    init() {}

    var current: Int { lock.withLock { value } }

    /// The account in use now, for work that must not outlive it.
    func stamp() -> AccountStamp { AccountStamp(generation: self, value: current) }

    /// The account ended; work stamped before this is turned away.
    func end() { lock.withLock { value += 1 } }

    /// Runs `work` while `stamped` is still the account in use. Returns whether it ran.
    @discardableResult
    func ifCurrent(_ stamped: Int, _ work: () -> Void) -> Bool {
        lock.withLock {
            guard value == stamped else { return false }
            work()
            return true
        }
    }
}

/// The account some work belongs to. `unchecked` belongs to none (demo data,
/// a Rome on this Mac, tests) and is always current.
struct AccountStamp: Sendable {
    let generation: AccountGeneration?
    let value: Int

    static let unchecked = AccountStamp(generation: nil, value: 0)

    var isCurrent: Bool { generation.map { $0.current == value } ?? true }

    /// Runs `work` only while this account is in use; a later sign-out or
    /// sign-in turns it into a no-op.
    @discardableResult
    func ifCurrent(_ work: () -> Void) -> Bool {
        guard let generation else { work(); return true }
        return generation.ifCurrent(value, work)
    }
}
