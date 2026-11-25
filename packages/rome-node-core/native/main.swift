import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import Foundation
import Security

let bundleIdentifier = "com.rome.computer-use"

func signedApp() -> Bool {
    guard Bundle.main.bundleIdentifier == bundleIdentifier else { return false }
    let executable = Bundle.main.executableURL.flatMap { canonicalPath($0.path) }
    guard executable != nil, (try? ProcessIdentity.read(getpid()).executable) == executable else { return false }
    var requirement: SecRequirement?
    var code: SecStaticCode?
    var running: SecCode?
    let expression = "anchor apple generic and identifier \"\(bundleIdentifier)\""
    return SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess &&
        SecCodeCopySelf([], &running) == errSecSuccess &&
        running.map { SecCodeCheckValidity($0, [], requirement) == errSecSuccess } == true &&
        SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &code) == errSecSuccess &&
        code.map { SecStaticCodeCheckValidity($0, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess } == true
}

func launch(path: String, desktop: Bool) throws -> Never {
    let state = try StateDirectory(path)
    let host = try ProcessIdentity.read(getppid())
    var input = stat()
    guard fstat(STDIN_FILENO, &input) == 0,
          [S_IFIFO, S_IFSOCK].contains(input.st_mode & S_IFMT),
          fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) == 0 else { throw Failure("authentication_failed") }
    let secret = try readBytes(STDIN_FILENO, count: 32, deadline: .now() + .seconds(5))
    close(STDIN_FILENO)
    let handshake = Handshake(key: SymmetricKey(data: secret), host: host.pid, helper: getpid())
    let admission = Admission()
    signal(SIGUSR1, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let signals = [SIGUSR1, SIGTERM, SIGINT].map { name in
        let source = DispatchSource.makeSignalSource(signal: name, queue: DispatchQueue.global(qos: .userInitiated))
        source.setEventHandler {
            if name == SIGUSR1 { _ = admission.stop() }
            else { admission.terminate() }
        }
        source.resume()
        return source
    }

    let app = desktop ? NSApplication.shared : nil
    app?.setActivationPolicy(.prohibited)
    let center = desktop ? NSWorkspace.shared.notificationCenter : nil
    let notifications = [NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification,
                         NSWorkspace.screensDidSleepNotification].compactMap { name in
        center?.addObserver(forName: name, object: nil, queue: nil) { _ in
            _ = admission.stop("console_unavailable")
        }
    }

    DispatchQueue.global(qos: .userInitiated).async {
        let code: Int32
        do {
            try serve(listener: Listener(state: state), host: host, handshake: handshake,
                      admission: admission, desktop: desktop)
            code = 0
        } catch {
            let reason = (error as? Failure)?.code ?? "internal_error"
            FileHandle.standardError.write(Data("\(reason)\n".utf8))
            code = 1
        }
        signals.forEach { $0.cancel() }
        notifications.forEach { center?.removeObserver($0) }
        exit(code)
    }

    if let app { app.run() }
    dispatchMain()
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    #if SELF_TEST_BUILD
    if arguments == ["--self-test"] {
        try SelfTest.run()
        exit(0)
    }
    if arguments.count == 2, arguments[0] == "--self-test-server" {
        try launch(path: arguments[1], desktop: false)
    }
    throw Failure("desktop_disabled")
    #else
    guard arguments.count == 2, arguments[0] == "--serve" else { throw Failure("invalid_request") }
    guard signedApp() else { throw Failure("desktop_disabled") }
    try launch(path: arguments[1], desktop: true)
    #endif
} catch {
    FileHandle.standardError.write(Data("\((error as? Failure)?.code ?? String(describing: error))\n".utf8))
    exit(1)
}
