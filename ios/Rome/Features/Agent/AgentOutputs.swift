import QuickLook
import SwiftUI
import UIKit

/// One chat's outputs as the Agent page lists them: what was read last shows
/// at once, and each opening of the tab reads them again.
/// docs/domains/chats.md#outputs
@MainActor
@Observable
final class ChatOutputsStore {
    /// The chat's server id.
    let chatId: String
    private(set) var outputs: [ChatOutput] = []
    /// Earlier outputs are still being read back, so the list may grow.
    private(set) var indexing = false
    /// A list arrived at least once.
    private(set) var loaded = false
    /// The last read failed.
    private(set) var loadFailed = false

    @ObservationIgnored private let backend: RomeBackend

    /// How often the tab reads again while earlier outputs are still being read back.
    static let indexingRefetch: Duration = .seconds(3)

    init(chatId: String, backend: RomeBackend) {
        self.chatId = chatId
        self.backend = backend
    }

    /// Reads the list, and again every few seconds while the server is still
    /// reading back earlier ones. Runs until the tab goes.
    func open() async {
        await load()
        while indexing, !Task.isCancelled {
            try? await Task.sleep(for: Self.indexingRefetch)
            if Task.isCancelled { return }
            await load()
        }
    }

    func load() async {
        do {
            let response = try await backend.chatOutputs(chatId: chatId)
            outputs = response.outputs
            indexing = response.indexing
            loaded = true
            loadFailed = false
        } catch {
            // A list read once stays up; the failure shows only without one.
            loadFailed = true
            indexing = false
        }
    }

}

/// What an output is, as its row names it. The web's `outputTypeOf`, kept in step.
enum ChatOutputType: Equatable {
    case document, spreadsheet, page, picture, audio, video, code, file

    init(name: String, kind: FileKind) {
        let ext = (name as NSString).pathExtension.lowercased()
        if kind == .pdf || kind == .docx { self = .document }
        else if ["md", "markdown", "txt", "doc", "pptx", "ppt"].contains(ext) { self = .document }
        else if ["csv", "tsv", "xlsx", "xls"].contains(ext) { self = .spreadsheet }
        else if ["html", "htm"].contains(ext) { self = .page }
        else if kind == .image { self = .picture }
        else if kind == .audio { self = .audio }
        else if kind == .video { self = .video }
        else if Self.codeExtensions.contains(ext) { self = .code }
        else { self = .file }
    }

    private static let codeExtensions: Set<String> = [
        "c", "cc", "cjs", "cpp", "cs", "css", "diff", "go", "h", "java", "js", "jsx", "json", "kt",
        "mjs", "patch", "py", "rb", "rs", "sh", "sql", "swift", "toml", "ts", "tsx", "xml", "yaml",
        "yml",
    ]

    var label: String {
        switch self {
        case .document: return String(localized: "Document")
        case .spreadsheet: return String(localized: "Spreadsheet")
        case .page: return String(localized: "Page")
        case .picture: return String(localized: "Picture")
        case .audio: return String(localized: "Audio")
        case .video: return String(localized: "Video")
        case .code: return String(localized: "Code")
        case .file: return String(localized: "File")
        }
    }

    var symbol: String {
        switch self {
        case .document: return "doc.text"
        case .spreadsheet: return "tablecells"
        case .page: return "macwindow"
        case .picture: return "photo"
        case .audio: return "waveform"
        case .video: return "film"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .file: return "doc"
        }
    }
}

extension ChatOutput {
    var type: ChatOutputType { ChatOutputType(name: name, kind: previewKind) }

    /// What it previews as: the server's kind, else what its MIME type or name says.
    var previewKind: FileKind {
        fileKind.flatMap(FileKind.init(rawValue:)) ?? FileKind(mimeType: mimeType) ?? FileKind(name: name)
    }

    /// The file as the phone opens it, the way a chat's link to it opens;
    /// nil while it cannot be served.
    var linkedFile: LinkedFile? {
        guard !missing, let url = contentUrl, url.hasPrefix("/api/") else { return nil }
        // Sent as written: the server already encoded the ids in it.
        return LinkedFile(apiPath: String(url.dropFirst(4)), query: nil, name: name, kind: previewKind)
    }

    /// A file name as a title: no extension, words for dashes and underscores,
    /// a capital first. The web's `outputTitle`.
    var title: String {
        var words = name.replacingOccurrences(of: #"\.[A-Za-z0-9]{1,8}$"#, with: "", options: .regularExpression)
        words = words.replacingOccurrences(of: #"[-_]+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return name }
        return first.uppercased() + words.dropFirst()
    }

    /// A picture the picture viewer shows; an SVG is not one.
    var isPicture: Bool { linkedFile?.opening == .picture }

    /// Where it came from: the task chat it came from, else how this chat's agent made it.
    var sourceLine: String {
        if missing { return String(localized: "Moved or deleted") }
        if let from { return String(localized: "from \(from.name)") }
        return kind == "shown" ? String(localized: "Shown") : String(localized: "Written")
    }
}

/// The Agent page's Outputs tab: the files the chat's agent wrote or showed,
/// under Today and Earlier, newest first, as the Tasks tab lists its rows.
/// A tap opens one as a chat's link to it opens (`linkedFileViewer`).
struct AgentOutputsView: View {
    let store: ChatOutputsStore?
    let backend: RomeBackend
    let onOpenChat: (ConciergeTask.LinkedChat) -> Void

    @State private var opening: LinkedFileRequest?
    @State private var notice: String?

    var body: some View {
        TimelineView(.everyMinute) { context in
            content(now: context.date)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: store?.chatId) { await store?.open() }
        .overlay(alignment: .top) {
            if let notice {
                TopBanner(kind: .error, text: notice)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(for: .seconds(3))
                        self.notice = nil
                    }
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: notice)
        .linkedFileViewer(backend: backend, request: $opening, top: 4, shown: { _ in }, openPage: { _ in })
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let store, !store.loaded, store.outputs.isEmpty, !store.loadFailed {
            VStack {
                Spacer()
                Spinner(size: 20, color: Palette.sub)
                Spacer()
            }
        } else if let store, store.loadFailed, store.outputs.isEmpty {
            VStack {
                Spacer()
                Text("Failed to load outputs")
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
                Spacer()
            }
        } else if let store, !store.outputs.isEmpty {
            list(store, now: now)
        } else if let store, store.indexing {
            VStack {
                indexingNote
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 4)
        } else {
            empty
        }
    }

    private var indexingNote: some View {
        Text("Still finding earlier files.")
            .romeFont(13)
            .foregroundStyle(Palette.sub)
            .padding(.horizontal, 6)
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: "doc.on.doc")
                .romeFont(22)
                .foregroundStyle(Palette.sub)
                .frame(width: 52, height: 52)
                .background(Palette.fillStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.bottom, 8)
                .accessibilityHidden(true)
            Text("No outputs yet")
                .romeFont(19, .semibold)
                .tracking(-0.4)
            Text("Files the agent writes or shows in this chat appear here.")
                .romeFont(15)
                .lineSpacing(4)
                .foregroundStyle(Palette.sub)
                .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 52)
    }

    private func list(_ store: ChatOutputsStore, now: Date) -> some View {
        let today = store.outputs.filter { Self.isToday($0, now: now) }
        let earlier = store.outputs.filter { !Self.isToday($0, now: now) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if store.indexing { indexingNote }
                if !today.isEmpty { section("Today", today, now: now) }
                if !earlier.isEmpty { section("Earlier", earlier, now: now) }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    static func isToday(_ output: ChatOutput, now: Date, calendar: Calendar = .current) -> Bool {
        guard let date = output.date else { return false }
        return calendar.isDate(date, inSameDayAs: now)
    }

    private func section(_ title: LocalizedStringKey, _ items: [ChatOutput], now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .romeFont(13, .semibold)
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 6)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, output in
                    OutputRow(
                        output: output,
                        backend: backend,
                        now: now,
                        last: index == items.count - 1,
                        onOpen: { open(output) },
                        onOpenChat: output.from.map { from in { onOpenChat(.init(id: from.chatId, name: from.name)) } }
                    )
                }
            }
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
            .hairline(radius: Metrics.groupRadius)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func open(_ output: ChatOutput) {
        guard let file = output.linkedFile else {
            notice = output.missing ? String(localized: "Moved or deleted") : String(localized: "This file cannot be opened here.")
            return
        }
        opening = LinkedFileRequest(file: file)
    }

    /// Whether Quick Look shows this file. Mac Catalyst's SDK keeps the
    /// method's Objective-C name.
    static func quickLookReads(_ url: URL) -> Bool {
        #if targetEnvironment(macCatalyst)
        QLPreviewController.canPreviewItem(url as NSURL)
        #else
        QLPreviewController.canPreview(url as NSURL)
        #endif
    }

    /// The bytes in a temporary folder of their own, under the file's own
    /// name, so Quick Look and the share sheet see what it is.
    static func write(_ data: Data, name: String) -> URL? {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Output-\(UUID().uuidString)", directoryHint: .isDirectory)
        let safe = name.components(separatedBy: CharacterSet(charactersIn: "/\\:")).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let url = folder.appending(path: safe.isEmpty ? "File" : String(safe.prefix(120)))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}

/// One output: its kind's icon or a thumbnail, its title, what it is and
/// where it came from, and how long ago. Long-pressed, one from a task chat
/// offers that chat.
private struct OutputRow: View {
    let output: ChatOutput
    let backend: RomeBackend
    let now: Date
    let last: Bool
    let onOpen: () -> Void
    let onOpenChat: (() -> Void)?

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                OutputThumbnail(output: output, backend: backend)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: output.title)
                        .romeFont(16, .medium)
                        .tracking(-0.3)
                        .foregroundStyle(output.missing ? Palette.sub : Palette.fg)
                        .lineLimit(1)
                    Text(verbatim: "\(output.type.label) · \(output.sourceLine)")
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let date = output.date {
                    Text(verbatim: TaskListWords.time(date.timeIntervalSince1970 * 1000, now: now))
                        .romeFont(13)
                        .monospacedDigit()
                        .foregroundStyle(Palette.sub)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 10)
            .padding(.leading, 12)
            .padding(.trailing, 14)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 60) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .contextMenu {
            if let onOpenChat {
                Button(action: onOpenChat) { Label("Open task chat", systemImage: "bubble.left") }
            }
        }
        .accessibilityHint(Text(verbatim: output.name))
    }
}

/// A picture's own thumbnail, the instance's 600-wide one; any other file
/// gets its kind's icon.
private struct OutputThumbnail: View {
    let output: ChatOutput
    let backend: RomeBackend

    static let size: CGFloat = 36
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.fillStrong)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: output.type.symbol)
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
            }
        }
        .frame(width: Self.size, height: Self.size)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityHidden(true)
        .task(id: output.id) { await load() }
    }

    private var source: ImageSource? {
        guard output.isPicture, !output.missing, let link = output.link else { return nil }
        let source = ImageSource(src: link, origin: backend.origin)
        if case .external = source { return nil }
        if case .rejected = source { return nil }
        return source
    }

    private func load() async {
        guard let source, image == nil else { return }
        let backend = backend
        guard let data = try? await ImageFetch.data(
            source,
            assetLoader: { path, width in try await backend.asset(path: path, width: width) },
            apiLoader: { path, query in try await backend.apiFile(path: path, query: query) },
            width: 600
        ) else { return }
        let maxPixel = Self.size * max(UITraitCollection.current.displayScale, 2)
        let thumbnail = await Task.detached { ImageCompressor.thumbnail(from: data, maxPixel: maxPixel) }.value
        if let thumbnail { image = UIImage(cgImage: thumbnail) }
    }
}
