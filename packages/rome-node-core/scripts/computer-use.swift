import Darwin
import Foundation
import Security

let files = FileManager.default
let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let repository = package.deletingLastPathComponent().deletingLastPathComponent()
let native = package.appendingPathComponent("native", isDirectory: true)
let appName = "Rome Computer Use.app"
let executableName = "RomeComputerUse"
let bundleID = "com.rome.computer-use"
let testKey = "RomeComputerUseSelfTest"

struct BuildError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func run(_ path: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw BuildError("\(path) failed (\(process.terminationStatus))") }
}

func infoPlist(_ app: URL) -> URL { app.appendingPathComponent("Contents/Info.plist") }
func executable(_ app: URL) -> URL { app.appendingPathComponent("Contents/MacOS/\(executableName)") }
func bundleIcon(_ app: URL) -> URL { app.appendingPathComponent("Contents/Resources/icon.icns") }

func validateIcon(_ url: URL) throws {
    var info = stat()
    guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 8,
          let handle = try? FileHandle(forReadingFrom: url) else { throw BuildError("Missing Rome icon at \(url.path).") }
    defer { try? handle.close() }
    guard handle.readData(ofLength: 4) == Data("icns".utf8) else { throw BuildError("Invalid Rome icon at \(url.path).") }
}

func plist(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    guard let info = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any]
    else { throw BuildError("The app lacks a valid Info.plist.") }
    return info
}

func isDirectory(_ url: URL) -> Bool {
    var info = stat()
    return lstat(url.path, &info) == 0 && info.st_mode & S_IFMT == S_IFDIR
}

func validate(_ app: URL, signed: Bool = false, release: Bool = false) throws {
    let infoPath = infoPlist(app)
    let binary = executable(app)
    var plistInfo = stat(), binaryInfo = stat()
    guard app.lastPathComponent == appName,
          isDirectory(app), isDirectory(infoPath.deletingLastPathComponent()),
          isDirectory(binary.deletingLastPathComponent()),
          lstat(infoPath.path, &plistInfo) == 0, plistInfo.st_mode & S_IFMT == S_IFREG,
          lstat(binary.path, &binaryInfo) == 0, binaryInfo.st_mode & S_IFMT == S_IFREG,
          binaryInfo.st_mode & 0o111 != 0, binaryInfo.st_size >= 32 else {
        throw BuildError("The arm64 helper app or its executable is missing.")
    }
    let handle = try FileHandle(forReadingFrom: binary)
    defer { try? handle.close() }
    guard handle.readData(ofLength: 8) == Data([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]) else {
        throw BuildError("The helper executable must be an arm64 Mach-O.")
    }
    let info = try plist(infoPath)
    guard info["CFBundleIdentifier"] as? String == bundleID,
          info["CFBundleExecutable"] as? String == executableName,
          info["CFBundlePackageType"] as? String == "APPL" else {
        throw BuildError("The helper bundle identity is incorrect.")
    }
    guard info["CFBundleIconFile"] as? String == "icon", isDirectory(bundleIcon(app).deletingLastPathComponent()) else {
        throw BuildError("The helper bundle has no Rome icon.")
    }
    try validateIcon(bundleIcon(app))
    if signed || release {
        guard info[testKey] as? Bool == false else { throw BuildError("A compile-only helper cannot be released or installed.") }
        let developerID = " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
        let expression = "anchor apple generic and identifier \"\(bundleID)\"" + (release ? developerID : "")
        var requirement: SecRequirement?
        var code: SecStaticCode?
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
              SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
            throw BuildError(release ? "The release helper needs a valid Developer ID Application signature." :
                "The helper needs a valid Apple-issued signature.")
        }
    }
    if release { try run("/usr/bin/xcrun", ["stapler", "validate", app.path]) }
}

func isCanonical(_ path: String) -> Bool {
    guard let resolved = realpath(path, nil) else { return false }
    defer { free(resolved) }
    return path == String(cString: resolved)
}

func createOutputDirectory(_ url: URL) throws {
    var info = stat()
    if lstat(url.path, &info) == 0 {
        guard info.st_mode & S_IFMT == S_IFDIR, isCanonical(url.path) else {
            throw BuildError("Unsafe output directory.")
        }
        return
    }
    guard errno == ENOENT, url.path != "/" else { throw BuildError("Unsafe output directory.") }
    try createOutputDirectory(url.deletingLastPathComponent())
    if mkdir(url.path, 0o700) != 0, errno != EEXIST { throw BuildError("Cannot create output directory.") }
}

func temporaryDirectory(_ path: String, failure: String) throws -> URL {
    var template = Array(path.utf8CString)
    return try template.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress, let temporary = mkdtemp(base) else { throw BuildError(failure) }
        return URL(fileURLWithPath: String(cString: temporary), isDirectory: true)
    }
}

func withPublication(_ output: URL, _ stageApp: (URL) throws -> Void) throws {
    guard output.lastPathComponent == appName else { throw BuildError("Expected output named \(appName).") }
    let parent = output.deletingLastPathComponent()
    try createOutputDirectory(parent)
    guard isCanonical(parent.path) else { throw BuildError("Unsafe output directory.") }
    let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directory >= 0 else { throw BuildError("Unsafe output directory.") }
    defer { close(directory) }
    var pinned = stat()
    guard fstat(directory, &pinned) == 0, pinned.st_uid == getuid(), pinned.st_mode & 0o022 == 0 else {
        throw BuildError("Unsafe output directory.")
    }

    let lockName = ".rome-computer-use.lock"
    let lock = openat(directory, lockName, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw BuildError("Unsafe build lock.") }
    defer { close(lock) }
    var lockInfo = stat()
    guard fstat(lock, &lockInfo) == 0, lockInfo.st_mode & (S_IFMT | 0o7777) == S_IFREG | 0o600,
          lockInfo.st_uid == getuid(), lockInfo.st_nlink == 1 else { throw BuildError("Unsafe build lock.") }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw BuildError("Another helper build or install owns the output lock.") }

    let stage = try temporaryDirectory(parent.appendingPathComponent(".rome-computer-use.XXXXXX").path,
                                       failure: "Cannot stage the helper.")
    defer { try? files.removeItem(at: stage) }
    let candidate = stage.appendingPathComponent(appName, isDirectory: true)
    try stageApp(candidate)

    var live = stat(), liveLock = stat()
    guard lstat(parent.path, &live) == 0, live.st_dev == pinned.st_dev, live.st_ino == pinned.st_ino,
          live.st_uid == getuid(), live.st_mode & 0o022 == 0, isCanonical(parent.path),
          fstatat(directory, lockName, &liveLock, AT_SYMLINK_NOFOLLOW) == 0,
          liveLock.st_ino == lockInfo.st_ino, liveLock.st_dev == lockInfo.st_dev else {
        throw BuildError("The output directory or its build lock changed.")
    }
    let stageFD = openat(directory, stage.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard stageFD >= 0 else { throw BuildError("The staging directory changed.") }
    defer { close(stageFD) }
    var candidateInfo = stat()
    guard fstatat(stageFD, appName, &candidateInfo, AT_SYMLINK_NOFOLLOW) == 0,
          candidateInfo.st_mode & (S_IFMT | 0o022) == S_IFDIR, candidateInfo.st_uid == getuid() else {
        throw BuildError("The staged helper is unsafe.")
    }

    var existing = stat()
    let flag: UInt32
    if fstatat(directory, appName, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
        guard existing.st_uid == getuid(), existing.st_mode & (S_IFMT | 0o022) == S_IFDIR else {
            throw BuildError("The existing output is unsafe.")
        }
        flag = UInt32(RENAME_SWAP)
    } else {
        guard errno == ENOENT else { throw BuildError("Cannot inspect existing output.") }
        flag = UInt32(RENAME_EXCL)
    }
    guard renameatx_np(stageFD, appName, directory, appName, flag) == 0 else {
        throw BuildError("Cannot publish the app atomically (errno \(errno)).")
    }
}

func applicationIdentifier(in profile: [String: Any]) throws -> String {
    let failure = BuildError("The macOS provisioning profile must authorize \(bundleID).")
    guard let platforms = profile["Platform"] as? [String], platforms.contains("OSX"),
          let entitlements = profile["Entitlements"] as? [String: Any],
          let appID = entitlements["com.apple.application-identifier"] as? String,
          let separator = appID.firstIndex(of: "."), separator != appID.startIndex else { throw failure }
    let app = appID[appID.index(after: separator)...]
    guard app == bundleID || app == "*" else { throw failure }
    return appID[...separator] + bundleID
}

func build(_ output: URL, selfTest: Bool, identity: String?, profile: String?, iconPath: String?) throws {
    guard selfTest ? identity == nil && profile == nil : identity != nil && identity != "-" && identity != "" else {
        throw BuildError("Choose either --self-test-build or an Apple code-signing --identity.")
    }
    let icon = iconPath.map { URL(fileURLWithPath: $0) } ??
        repository.appendingPathComponent("packages/desktop/build/icon.icns")
    try validateIcon(icon)
    try withPublication(output) { app in
        try files.createDirectory(at: executable(app).deletingLastPathComponent(), withIntermediateDirectories: true)
        try files.createDirectory(at: bundleIcon(app).deletingLastPathComponent(), withIntermediateDirectories: true)
        try files.copyItem(at: icon, to: bundleIcon(app))
        var info = try plist(native.appendingPathComponent("Info.plist"))
        info[testKey] = selfTest
        let metadata = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try metadata.write(to: infoPlist(app), options: .atomic)

        let sources = try files.contentsOfDirectory(at: native, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }.map(\.path).sorted()
        var args = ["swiftc", "-O", "-swift-version", "5", "-target", "arm64-apple-macosx14.0"]
        if selfTest { args += ["-D", "SELF_TEST_BUILD"] }
        try run("/usr/bin/xcrun", args + sources + ["-o", executable(app).path])
        if let identity {
            var signing = ["--force", "--options", "runtime", "--timestamp", "--sign", identity]
            if let profile {
                let embedded = app.appendingPathComponent("Contents/embedded.provisionprofile")
                try files.copyItem(at: URL(fileURLWithPath: profile), to: embedded)
                let stage = app.deletingLastPathComponent()
                let decoded = stage.appendingPathComponent("profile.plist")
                try run("/usr/bin/security", ["cms", "-D", "-i", embedded.path, "-o", decoded.path])
                let key = "com.apple.application-identifier"
                let appID = try applicationIdentifier(in: plist(decoded))
                let path = stage.appendingPathComponent("entitlements.plist")
                let data = try PropertyListSerialization.data(fromPropertyList: [key: appID], format: .xml, options: 0)
                try data.write(to: path)
                signing += ["--entitlements", path.path]
            }
            try run("/usr/bin/codesign", signing + [app.path])
        }
        try validate(app, signed: !selfTest)
    }
}

func test(_ app: URL) throws {
    try validate(app)
    try run(executable(app).path, ["--self-test"])
    func rejects(_ message: String, _ action: () throws -> Void) throws {
        do { try action() }
        catch let error as BuildError where error.description == message { return }
        throw BuildError("Expected failure: \(message)")
    }
    func profile(_ id: String, platform: String = "OSX") -> [String: Any] {
        ["Platform": [platform], "Entitlements": ["com.apple.application-identifier": id]]
    }
    let explicitID = "TESTTEAM00.\(bundleID)"
    guard try applicationIdentifier(in: profile(explicitID)) == explicitID,
          try applicationIdentifier(in: profile("TESTTEAM00.*")) == explicitID else {
        throw BuildError("Expected a concrete helper application identifier.")
    }
    for invalid in [profile("TESTTEAM00.com.example.other"), profile("TESTTEAM00.*", platform: "iOS"), profile(".*")] {
        try rejects("The macOS provisioning profile must authorize \(bundleID).") { _ = try applicationIdentifier(in: invalid) }
    }
    let root = try temporaryDirectory("/private/tmp/rome-native-build.XXXXXX", failure: "Cannot make test directory.")
    defer { try? files.removeItem(at: root) }
    try testNodeHandshake(app, state: root)
    let installed = root.appendingPathComponent(appName, isDirectory: true)
    try rejects("The arm64 helper app or its executable is missing.") { try validate(installed, release: true) }
    try rejects("A compile-only helper cannot be released or installed.") { try validate(app, release: true) }
    try withPublication(installed) { candidate in
        try rejects("Another helper build or install owns the output lock.") {
            try withPublication(installed) { _ in throw BuildError("Unexpected competing publication.") }
        }
        try files.copyItem(at: app, to: candidate)
        let icon = bundleIcon(candidate)
        try files.moveItem(at: icon, to: icon.appendingPathExtension("fixture"))
        try rejects("Missing Rome icon at \(icon.path).") { try validate(candidate) }
        try files.moveItem(at: icon.appendingPathExtension("fixture"), to: icon)
    }
    try validate(installed)
    try rejects("staging failed") {
        try withPublication(installed) { _ in throw BuildError("staging failed") }
    }
    try validate(installed)
    try withPublication(installed) { candidate in
        try files.copyItem(at: app, to: candidate)
        var info = try plist(infoPlist(candidate))
        info[testKey] = false
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: infoPlist(candidate), options: .atomic)
    }
    try rejects("The release helper needs a valid Developer ID Application signature.") { try validate(installed, release: true) }
    print("Bundle checks passed (icon, profile authorization, build lock, staging, atomic replacement, absent and unsigned release rejection).")
}

func testNodeHandshake(_ app: URL, state: URL) throws {
    let source = #"""
        import assert from 'node:assert/strict';
        import { spawn } from 'node:child_process';
        import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
        import { once } from 'node:events';
        import { existsSync, realpathSync, writeFileSync } from 'node:fs';
        import { createConnection } from 'node:net';
        import { setTimeout as delay } from 'node:timers/promises';

        const [executable, state] = process.argv.slice(1);
        const socketPath = state + '/helper.sock';
        const key = randomBytes(32);
        const nonce = randomBytes(32).toString('base64');
        const mac = (...fields) => createHmac('sha256', key)
          .update(['rome-computer-use-v1', ...fields].join('\n')).digest();
        writeFileSync(state + '/bootstrap.json', JSON.stringify({
          secret: key.toString('hex'), hostPid: process.pid, hostExecutable: realpathSync(process.execPath),
        }), { flag: 'wx', mode: 0o600 });

        const helper = spawn(executable, ['--self-test-server', state, 'allow'], { stdio: 'inherit' });
        const exited = once(helper, 'exit');
        exited.catch(() => {});
        let socket;
        const timeout = setTimeout(() => {
          socket?.destroy(new Error('Node handshake timed out'));
          helper.kill('SIGKILL');
        }, 6_000);
        try {
          for (let attempt = 0; attempt < 200; attempt++) {
            if (existsSync(socketPath)) {
              socket = createConnection(socketPath);
              try {
                await once(socket, 'connect');
                break;
              } catch (error) {
                socket.destroy();
                socket = undefined;
                if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
              }
            }
            await delay(10);
          }
          assert(socket, 'Connect to helper.');
          const body = Buffer.from(JSON.stringify({
            v: 1, id: 'node-host', method: 'hello',
            params: { nonce, proof: mac('host', process.pid, nonce).toString('base64') },
          }));
          const header = Buffer.alloc(8);
          header.writeUInt32BE(body.length);
          socket.write(Buffer.concat([header, body]));

          let frame = Buffer.alloc(0);
          for await (const chunk of socket) {
            frame = Buffer.concat([frame, chunk]);
            if (frame.length >= 8 && frame.length >= 8 + frame.readUInt32BE(0)) break;
          }
          assert(frame.length >= 8, 'Receive handshake frame.');
          assert.equal(frame.readUInt32BE(0), frame.length - 8);
          assert.equal(frame.readUInt32BE(4), 0);
          const { v, id, ok, result } = JSON.parse(frame.subarray(8));
          assert.equal(v, 1);
          assert.equal(id, 'node-host');
          assert.equal(ok, true);
          const { instance, helperPid: pid, helperProof: proof } = result;
          assert(Number.isSafeInteger(pid) && pid > 0);
          assert.match(instance, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
          assert(timingSafeEqual(Buffer.from(proof, 'base64'), mac('helper', process.pid, pid, nonce, instance)));
          assert.equal(pid, helper.pid);
          assert.deepEqual(await exited, [0, null]);
          console.log(`Node ${process.versions.node} completed the handshake without using the helper PID in the request.`);
        } finally {
          clearTimeout(timeout);
          socket?.destroy();
          if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
          await exited.catch(() => {});
        }
        """#
    try run("/usr/bin/env", ["node", "--input-type=module", "-e", source, executable(app).path, state.path])
}

func main() throws {
    var args = Array(CommandLine.arguments.dropFirst())
    guard !args.isEmpty else { throw BuildError("Usage: computer-use.swift build|verify|install|test [--app PATH]") }
    let command = args.removeFirst()
    var options: [String: String] = [:]
    var flags = Set<String>()
    while let option = args.first {
        args.removeFirst()
        if ["--self-test-build", "--release"].contains(option), flags.insert(option).inserted { continue }
        guard ["--app", "--source", "--identity", "--provisioning-profile", "--icon"].contains(option), options[option] == nil,
              let value = args.first, !value.hasPrefix("--") else { throw BuildError("Invalid option \(option).") }
        options[option] = value
        args.removeFirst()
    }
    let output = options["--app"].map { URL(fileURLWithPath: $0) } ??
        repository.appendingPathComponent(".scratch/rome-node-native/\(appName)", isDirectory: true)
    let buildOptions = Set(options.keys).subtracting(["--app"])
    switch command {
    case "build" where buildOptions.isSubset(of: ["--identity", "--provisioning-profile", "--icon"]) &&
        flags.isSubset(of: ["--self-test-build"]):
        try build(output, selfTest: flags.contains("--self-test-build"), identity: options["--identity"],
                  profile: options["--provisioning-profile"], iconPath: options["--icon"])
        print(output.path)
    case "verify" where buildOptions.isEmpty && flags.isSubset(of: ["--release"]):
        try validate(output, release: flags.contains("--release"))
        print("Verified \(output.path).")
    case "install" where buildOptions == ["--source"] && flags.isEmpty:
        guard let source = options["--source"] else { throw BuildError("Pass --source PATH.") }
        let app = URL(fileURLWithPath: source)
        try validate(app, signed: true)
        try withPublication(output) { candidate in
            try files.copyItem(at: app, to: candidate)
            try validate(candidate, signed: true)
        }
    case "test" where buildOptions.isEmpty && flags.isEmpty:
        try test(output)
    default:
        throw BuildError("Invalid command or options.")
    }
}

do { try main() }
catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
