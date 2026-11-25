import AppKit
import ApplicationServices
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

@MainActor
func launch(path: String, desktop: Bool, testConsent: ConsentProvider? = nil) throws -> Never {
    let state = try StateDirectory(path)
    // Serialize bootstrap consumption and socket ownership on the pinned directory inode.
    guard flock(state.fd, LOCK_EX | LOCK_NB) == 0 else { throw Failure("state_directory_busy") }
    let (host, key) = try state.consumeBootstrap()
    let handshake = Handshake(key: key, host: host.pid)
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
    let session: DesktopSession?
    let consent: ConsentProvider
    if let app {
        guard app.setActivationPolicy(.accessory) else { throw Failure("console_unavailable") }
        let ui = DesktopSession(admission: admission)
        session = ui
        consent = { peer, canContinue in
            DispatchQueue.main.sync { ui.confirm(peer, canContinue: canContinue) }
        }
    } else {
        session = nil
        consent = testConsent ?? { _, _ in false }
    }

    DispatchQueue.global(qos: .userInitiated).async {
        let code: Int32
        do {
            try serve(listener: Listener(state: state), host: host, handshake: handshake,
                      admission: admission, desktop: session, consent: consent)
            code = 0
        } catch {
            let reason = (error as? Failure)?.code ?? "internal_error"
            FileHandle.standardError.write(Data("\(reason)\n".utf8))
            code = 1
        }
        signals.forEach { $0.cancel() }
        if let session { DispatchQueue.main.sync { session.close() } }
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
    if arguments.count == 3, arguments[0] == "--self-test-server" {
        try MainActor.assumeIsolated {
            try launch(path: arguments[1], desktop: false,
                       testConsent: SelfTest.consentProvider(arguments[2], path: arguments[1]))
        }
    }
    if arguments.count == 2, arguments[0] == "--self-test-exec-peer" {
        try SelfTest.execPeer(arguments[1])
    }
    if arguments.count == 2, arguments[0] == "--self-test-exec-ready", let fd = Int32(arguments[1]) {
        try SelfTest.inheritedSocket(fd)
        exit(0)
    }
    throw Failure("desktop_disabled")
    #else
    guard arguments.count == 2, arguments[0] == "--serve" else { throw Failure("invalid_request") }
    guard signedApp() else { throw Failure("desktop_disabled") }
    try MainActor.assumeIsolated { try launch(path: arguments[1], desktop: true) }
    #endif
} catch {
    FileHandle.standardError.write(Data("\((error as? Failure)?.code ?? String(describing: error))\n".utf8))
    exit(1)
}
