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

func requireAccessoryPolicy(current: () -> NSApplication.ActivationPolicy,
                            set: (NSApplication.ActivationPolicy) -> Bool) throws {
    guard current() != .accessory else { return }
    _ = set(.accessory)
    guard current() == .accessory else { throw Failure("console_unavailable") }
}

@MainActor
func launch(path: String, desktop: Bool, store: any TrustedKeyStore, testConsent: ConsentProvider? = nil) throws -> Never {
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
        source.setEventHandler { @Sendable in
            if name == SIGUSR1 { admission.terminate("local_stop") }
            else { admission.terminate() }
        }
        source.resume()
        return source
    }

    let app = desktop ? NSApplication.shared : nil
    let session: DesktopSession?
    let consent: ConsentProvider
    if let app {
        try requireAccessoryPolicy(current: app.activationPolicy, set: app.setActivationPolicy)
        let ui = DesktopSession(admission: admission, store: store)
        app.delegate = ui
        session = ui
        consent = { prompt, canContinue in
            try DispatchQueue.main.sync { try ui.confirm(prompt, canContinue: canContinue) }
        }
    } else {
        session = nil
        consent = testConsent ?? { _, _ in .deny }
    }

    DispatchQueue.global(qos: .userInitiated).async {
        let code: Int32
        do {
            try serve(listener: Listener(state: state), host: host, handshake: handshake,
                      admission: admission, desktop: session, store: store, consent: consent)
            code = 0
        } catch {
            let reason = (error as? Failure)?.code ?? "internal_error"
            FileHandle.standardError.write(Data("\(reason)\n".utf8))
            code = 1
        }
        signals.forEach { $0.cancel() }
        if let session { DispatchQueue.main.async { session.finish(code) } }
        else { exit(code) }
    }

    if let app { withExtendedLifetime(session) { app.run() } }
    dispatchMain()
}

func manageKeys(_ arguments: [String], store: any TrustedKeyStore) throws -> Data? {
    switch arguments.first {
    case "--list-keys" where arguments.count == 1:
        return try JSONSerialization.data(withJSONObject: store.list().map(\.summary), options: [.sortedKeys])
    case "--revoke-keys" where arguments.count == 1:
        try store.revokeAll()
    case "--revoke-key" where arguments.count == 2:
        try store.revoke(fingerprint: arguments[1])
    default:
        throw Failure("invalid_request")
    }
    return nil
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    #if SELF_TEST_BUILD
    if arguments == ["--self-test"] {
        try SelfTest.run()
        exit(0)
    }
    if arguments.count == 2, arguments[0] == "--self-test-handoff" {
        try SelfTest().cachedScreenHandoff(arguments[1])
        print("handoff cleanup complete")
        exit(0)
    }
    if arguments.count == 3, arguments[0] == "--self-test-server" {
        try MainActor.assumeIsolated {
            try launch(path: arguments[1], desktop: false, store: MemoryKeychainItems().store,
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
    let setup = try (arguments.isEmpty || arguments.first == "--setup-permissions")
        ? PermissionSetupRequest(arguments, preferred: Locale.preferredLanguages) : nil
    if arguments == ["--check-permissions"] { alarm(2) }
    guard signedApp() else { throw Failure("desktop_disabled") }
    if let setup {
        try MainActor.assumeIsolated { try runPermissionSetup(setup) }
        exit(0)
    }
    if arguments == ["--check-permissions"] {
        let output = try JSONSerialization.data(withJSONObject: [
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
        ])
        try FileHandle.standardOutput.write(contentsOf: output)
        exit(0)
    }
    if arguments.count == 3, arguments[0] == "--execute-approved", let parent = pid_t(arguments[2]), parent > 0 {
        try MainActor.assumeIsolated { try runApprovedExecution(path: arguments[1], parent: parent) }
    }
    let store = KeychainTrustedKeyStore()
    if arguments.count == 2, arguments[0] == "--serve" {
        try MainActor.assumeIsolated { try launch(path: arguments[1], desktop: true, store: store) }
    }
    if var output = try manageKeys(arguments, store: store) {
        output.append(0x0a)
        try FileHandle.standardOutput.write(contentsOf: output)
    }
    #endif
} catch {
    FileHandle.standardError.write(Data("\((error as? Failure)?.code ?? String(describing: error))\n".utf8))
    exit(1)
}
