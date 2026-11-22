import SwiftUI
import UIKit

/// A ChatGPT login by device code: Rome asks for a code, the guardian enters
/// it on OpenAI's page, and the status says when the account is in. The
/// same routes as the web's device-code login.
@MainActor
@Observable
final class ChatGPTLoginFlow {
    enum Phase: Equatable {
        case starting
        /// The code to enter, and the page to enter it on.
        case code(String, URL?)
        /// The login did not complete; the server's reason when it gave one.
        case failed(String?)
        case connected
    }

    private(set) var phase: Phase = .starting
    private let backend: RomeBackend
    private let pollInterval: Duration
    private var poll: Task<Void, Never>?
    private var started = false
    /// Told the status that showed the account logged in.
    var onConnected: ((AIToolsStatus) -> Void)?

    init(backend: RomeBackend, pollInterval: Duration = .seconds(2), phase: Phase = .starting) {
        self.backend = backend
        self.pollInterval = pollInterval
        self.phase = phase
    }

    /// Asks for a code, then watches the status until the account is in.
    func start() {
        phase = .starting
        started = true
        poll?.cancel()
        poll = Task { [weak self] in
            guard let self else { return }
            do {
                let code = try await backend.startChatGPTDeviceLogin()
                guard !Task.isCancelled else { return }
                guard let userCode = code.userCode, !userCode.isEmpty else {
                    phase = .failed(nil)
                    return
                }
                phase = .code(userCode, code.verificationUrl.flatMap(URL.init(string:)))
            } catch {
                if !Task.isCancelled { phase = .failed(nil) }
                return
            }
            await watch()
        }
    }

    private func watch() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: pollInterval)
            guard !Task.isCancelled else { return }
            guard let status = try? await backend.aiTools() else { continue }
            guard !Task.isCancelled else { return }
            if status.codex?.loggedIn == true {
                phase = .connected
                started = false
                onConnected?(status)
                return
            }
            if let error = status.codexDeviceLogin?.lastError, !error.isEmpty {
                phase = .failed(error)
                return
            }
        }
    }

    /// Closed before the account came in: the login stops on the server too.
    func cancel() {
        poll?.cancel()
        poll = nil
        guard started, phase != .connected else { return }
        started = false
        Task { [backend] in await backend.cancelChatGPTDeviceLogin() }
    }
}

/// The terminal socket a Claude login runs on, as the flow reads it.
@MainActor
protocol LoginSocket: AnyObject {
    /// The next text frame; throws once the socket closes.
    func receive() async throws -> String
    func send(_ text: String) async throws
    func close()
}

/// `URLSessionWebSocketTask` behind `LoginSocket`.
@MainActor
final class WebLoginSocket: LoginSocket {
    private let task: URLSessionWebSocketTask

    init(request: URLRequest) {
        task = URLSession.shared.webSocketTask(with: request)
        task.resume()
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// A Claude login over the instance's terminal socket, which runs
/// `claude /login`: the server finds the sign-in page's address in its
/// output (`auth_url`), the guardian signs in there and pastes the code it
/// shows, and the code goes back to the login (`submit_code`). A code the
/// login refuses comes back as `auth_error`. As on the web, the account is
/// read again every two seconds to see it arrive.
@MainActor
@Observable
final class ClaudeLoginFlow {
    enum Failure: Equatable {
        /// The sign-in page's address never came.
        case timedOut
        /// The socket closed before the account came in.
        case closed
        /// The server said why.
        case server(String)
    }

    enum Phase: Equatable {
        /// Waiting for the sign-in page's address.
        case preparing
        case ready(URL)
        /// A code is on its way to the login.
        case submitting(URL)
        case connected
        case failed(Failure)
    }

    private(set) var phase: Phase = .preparing
    /// The login refused the last code.
    private(set) var codeRejected = false
    private let backend: RomeBackend
    private let makeSocket: () -> LoginSocket?
    private let prepareTimeout: Duration
    private let pollInterval: Duration
    private var socket: LoginSocket?
    private var tasks: [Task<Void, Never>] = []
    var onConnected: ((AIToolsStatus) -> Void)?

    init(
        backend: RomeBackend,
        makeSocket: (() -> LoginSocket?)? = nil,
        prepareTimeout: Duration = .seconds(25),
        pollInterval: Duration = .seconds(2),
        phase: Phase = .preparing
    ) {
        self.backend = backend
        self.makeSocket = makeSocket ?? { backend.claudeLoginSocket() }
        self.prepareTimeout = prepareTimeout
        self.pollInterval = pollInterval
        self.phase = phase
    }

    private var url: URL? {
        switch phase {
        case .ready(let url), .submitting(let url): return url
        default: return nil
        }
    }

    private var settled: Bool {
        switch phase {
        case .connected, .failed: return true
        default: return false
        }
    }

    func start() {
        stop()
        phase = .preparing
        codeRejected = false
        guard let socket = makeSocket() else {
            phase = .failed(.closed)
            return
        }
        self.socket = socket
        tasks = [
            Task { [weak self] in await self?.read(socket) },
            Task { [weak self, prepareTimeout] in
                try? await Task.sleep(for: prepareTimeout)
                guard let self, !Task.isCancelled, phase == .preparing else { return }
                fail(.timedOut)
            },
            Task { [weak self, pollInterval] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: pollInterval)
                    guard let self, !Task.isCancelled else { return }
                    await checkOnce()
                }
            },
        ]
    }

    private func read(_ socket: LoginSocket) async {
        while !Task.isCancelled {
            let text: String
            do {
                text = try await socket.receive()
            } catch {
                guard !Task.isCancelled, !settled else { return }
                // The login may have landed just as it closed.
                await checkOnce()
                if !settled { fail(.closed) }
                return
            }
            handle(text)
        }
    }

    /// One frame from the socket. Raw terminal output is not drawn.
    func handle(_ text: String) {
        guard !settled, let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return }
        switch frame["type"]?.string {
        case "auth_url":
            guard let url = frame["url"]?.string.flatMap(URL.init(string:)) else { return }
            if case .submitting = phase { return }
            phase = .ready(url)
        case "auth_error":
            codeRejected = true
            if let url { phase = .ready(url) }
        case "exit":
            Task { await checkOnce() }
        case "error":
            fail(.server(frame["message"]?.string ?? ""))
        default:
            break
        }
    }

    /// Reads the account now; once it is in, the login is done.
    func checkOnce() async {
        guard !settled, let status = try? await backend.refreshAITools(.anthropic), !settled else { return }
        if status.claude?.loggedIn == true {
            phase = .connected
            stop()
            onConnected?(status)
        }
    }

    /// Sends the pasted code, or the callback link that holds it.
    func submit(_ raw: String) {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, let url, let socket else { return }
        codeRejected = false
        phase = .submitting(url)
        let frame: JSONValue = .object(["type": .string("submit_code"), "code": .string(code)])
        guard let data = try? JSONEncoder().encode(frame) else { return }
        Task { [weak self] in
            do {
                try await socket.send(String(decoding: data, as: UTF8.self))
            } catch {
                self?.fail(.closed)
            }
        }
    }

    private func fail(_ failure: Failure) {
        phase = .failed(failure)
        stop()
    }

    /// Closes the socket, which ends the login on the server.
    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        socket?.close()
        socket = nil
    }
}

/// The sheet that logs in to one AI account, from the AI Tools page or a
/// chat's card. It closes itself once the account is in.
struct AILoginSheet: View {
    let account: AIAccount
    let backend: RomeBackend
    /// The status that showed the account in.
    var onConnected: (AIToolsStatus) -> Void = { _ in }

    var body: some View {
        Group {
            switch account {
            case .chatgpt: ChatGPTLoginSheet(backend: backend, onConnected: onConnected)
            case .claude: ClaudeLoginSheet(backend: backend, onConnected: onConnected)
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Palette.sheet)
        .presentationCornerRadius(22)
    }
}

/// How long a login's success shows before its sheet closes.
private let connectedHold: Duration = .seconds(1.4)

/// A login sheet's title row and close button.
private struct LoginHeader: View {
    let title: LocalizedStringKey
    let close: () -> Void

    var body: some View {
        HStack {
            Text(title).romeFont(24, .bold).tracking(-0.6)
            Spacer()
            SheetCloseButton(action: close)
        }
    }
}

/// The login is done: a moment's confirmation, then the sheet closes.
private struct LoginDone: View {
    let title: LocalizedStringKey

    var body: some View {
        VStack(spacing: 10) {
            StatusGlyph(tone: .done, size: 36)
            Text(title).romeFont(17, .semibold)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity.combined(with: .scale(scale: 0.95)))
    }
}

/// A failure line in a login sheet, economical.
private struct LoginProblem: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            AlertGlyph(size: 15)
            Text(verbatim: text).romeFont(14, .medium).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Palette.destructive)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.dangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// ChatGPT's login: the device code, large, to copy and enter on OpenAI's page.
struct ChatGPTLoginSheet: View {
    let backend: RomeBackend
    var onConnected: (AIToolsStatus) -> Void = { _ in }
    /// Snapshot runs show a phase as it is, with nothing started.
    var preview: ChatGPTLoginFlow.Phase? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var flow: ChatGPTLoginFlow?
    @State private var copied = false

    var body: some View {
        let phase = flow?.phase ?? preview ?? .starting
        VStack(alignment: .leading, spacing: 16) {
            LoginHeader(title: "Log in to ChatGPT") { close() }
            switch phase {
            case .connected:
                LoginDone(title: "Logged in to ChatGPT")
            case .failed(let reason):
                LoginProblem(text: reason.map { String(localized: "Login did not complete: \($0)") } ?? String(localized: "Login did not complete"))
                Spacer()
                PrimaryButton(title: "New code") { flow?.start() }
            case .starting, .code:
                Text("Enter this code on the ChatGPT login page.")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
                    .fixedSize(horizontal: false, vertical: true)
                codeBox(phase)
                Text("Device code login must be on in ChatGPT, under Settings → Security.")
                    .romeFont(13)
                    .foregroundStyle(Palette.sub)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if case .code(let code, let url) = phase {
                    HStack(spacing: 8) {
                        Spinner(size: 14, color: Palette.sub)
                        Text("Waiting for you to finish…").romeFont(14).foregroundStyle(Palette.sub)
                    }
                    .frame(maxWidth: .infinity)
                    SecondaryButton(title: copied ? "Copied" : "Copy code") {
                        UIPasteboard.general.string = code
                        copied = true
                    }
                    PrimaryButton(title: "Open login page", disabled: url == nil) {
                        if let url { openURL(url) }
                    }
                }
            }
        }
        .padding(20)
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: phase)
        .task {
            guard preview == nil, flow == nil else { return }
            let flow = ChatGPTLoginFlow(backend: backend)
            flow.onConnected = { status in
                onConnected(status)
                Task {
                    try? await Task.sleep(for: connectedHold)
                    dismiss()
                }
            }
            self.flow = flow
            flow.start()
        }
        .onDisappear { flow?.cancel() }
    }

    private func codeBox(_ phase: ChatGPTLoginFlow.Phase) -> some View {
        Group {
            if case .code(let code, _) = phase {
                Text(verbatim: code)
                    .romeFont(34, .semibold, design: .monospaced)
                    .tracking(2)
                    .textSelection(.enabled)
                    .accessibilityLabel(Text("Device code"))
                    .accessibilityValue(Text(verbatim: code))
            } else {
                Spinner(size: 22, color: Palette.sub)
                    .accessibilityLabel(Text("Getting a code…"))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 88)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .hairline(radius: 16)
    }

    private func close() {
        flow?.cancel()
        dismiss()
    }
}

/// Claude's login in two steps: open the sign-in page, then paste the code
/// it shows.
struct ClaudeLoginSheet: View {
    let backend: RomeBackend
    var onConnected: (AIToolsStatus) -> Void = { _ in }
    var preview: ClaudeLoginFlow.Phase? = nil
    var previewRejected = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var flow: ClaudeLoginFlow?
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        let phase = flow?.phase ?? preview ?? .preparing
        let rejected = flow?.codeRejected ?? previewRejected
        VStack(alignment: .leading, spacing: 16) {
            LoginHeader(title: "Log in to Claude") { close() }
            switch phase {
            case .connected:
                LoginDone(title: "Logged in to Claude")
            case .failed(let failure):
                LoginProblem(text: Self.text(failure))
                Spacer()
                PrimaryButton(title: "Try again") {
                    code = ""
                    flow?.start()
                }
            case .preparing, .ready, .submitting:
                step(1, "Open the Claude sign-in page and approve access.")
                openButton(phase)
                step(2, "Paste the code the page shows.")
                TextField("Code", text: $code)
                    .romeFont(16, design: .monospaced)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit { flow?.submit(code) }
                    .padding(14)
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .hairline(radius: 16)
                    .disabled(phase == .preparing)
                if rejected {
                    Text("That code did not work. Paste it again.")
                        .romeFont(13, .medium)
                        .foregroundStyle(Palette.destructive)
                }
                Spacer()
                PrimaryButton(
                    title: "Connect",
                    loading: { if case .submitting = phase { return true } else { return false } }(),
                    disabled: code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || phase == .preparing
                ) {
                    flow?.submit(code)
                }
            }
        }
        .padding(20)
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: phase)
        .task {
            guard preview == nil, flow == nil else { return }
            let flow = ClaudeLoginFlow(backend: backend)
            flow.onConnected = { status in
                onConnected(status)
                Task {
                    try? await Task.sleep(for: connectedHold)
                    dismiss()
                }
            }
            self.flow = flow
            flow.start()
        }
        .onDisappear { flow?.stop() }
    }

    static func text(_ failure: ClaudeLoginFlow.Failure) -> String {
        switch failure {
        case .timedOut: return String(localized: "The sign-in page did not come")
        case .closed: return String(localized: "The connection closed")
        case .server(let message): return message.isEmpty ? String(localized: "The connection closed") : message
        }
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: "\(number)")
                .romeFont(13, .semibold, monospacedDigits: true)
                .foregroundStyle(Palette.sub)
                .frame(width: 22, height: 22)
                .background(Palette.fill, in: Circle())
            Text(text)
                .romeFont(15)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func openButton(_ phase: ClaudeLoginFlow.Phase) -> some View {
        let url: URL? = {
            switch phase {
            case .ready(let url), .submitting(let url): return url
            default: return nil
            }
        }()
        return Button {
            if let url {
                openURL(url)
                focused = true
            }
        } label: {
            HStack(spacing: 8) {
                if url == nil {
                    Spinner(size: 14, color: Palette.sub)
                } else {
                    Image(systemName: "arrow.up.right").romeFont(14, .semibold)
                }
                Text("Open Claude sign-in").romeFont(16, .semibold)
            }
            .foregroundStyle(Palette.fg)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(Palette.fill, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .disabled(url == nil)
        .accessibilityHint(url == nil ? Text("Preparing sign-in…") : Text("Opens Safari"))
    }

    private func close() {
        flow?.stop()
        dismiss()
    }
}
