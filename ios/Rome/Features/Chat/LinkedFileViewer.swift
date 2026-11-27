import AVKit
import QuickLook
import SwiftUI

/// A file to open, for `linkedFileViewer`: a link tapped in a chat or an
/// output of the Outputs tab; nil for one the phone cannot open.
struct LinkedFileRequest: Identifiable, Equatable {
    let id = UUID()
    let file: LinkedFile?
}

extension View {
    /// Opens the file set in `request` over this view, by what it previews as
    /// (`LinkedFile.opening`): a picture in the picture viewer, a video or
    /// audio file streamed in the system player, anything else downloaded with
    /// the session and shown in Quick Look, whose Share button sends or saves
    /// it, or straight in the share sheet when Quick Look cannot show it or a
    /// preview would run it. A picture too large for the viewer opens in Quick
    /// Look. A file that fails, or that no route serves, gets a short notice
    /// at the top.
    /// A project or memory path that names a folder goes to `openPage` with
    /// the dashboard's page for it. `top` is how far below the view's top
    /// edge the notice sits.
    /// `shown` hears whether Quick Look or the share sheet covers the view.
    func linkedFileViewer(
        backend: RomeBackend, request: Binding<LinkedFileRequest?>, top: CGFloat = 58,
        shown: @escaping (Bool) -> Void, openPage: @escaping (URL) -> Void
    ) -> some View {
        modifier(LinkedFileViewer(backend: backend, request: request, top: top, shown: shown, openPage: openPage))
    }
}

private struct LinkedFileViewer: ViewModifier {
    let backend: RomeBackend
    @Binding var request: LinkedFileRequest?
    let top: CGFloat
    let shown: (Bool) -> Void
    let openPage: (URL) -> Void

    @State private var preview: URL?
    @State private var picture: Picture?
    @State private var playing: MediaItem?
    @State private var sharing: SharedFile?
    @State private var notice: String?
    @State private var loading = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if loading {
                    // From the tap until Quick Look shows: a large file takes a while.
                    TopBanner(kind: .info, text: String(localized: "Loading…"))
                        .readableColumn()
                        .padding(.top, top)
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else if let notice {
                    TopBanner(kind: .error, text: notice)
                        .readableColumn()
                        .padding(.top, top)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .task(id: notice) {
                            try? await Task.sleep(for: .seconds(3))
                            if self.notice == notice { self.notice = nil }
                        }
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: notice)
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: loading)
            .fullScreenCover(item: $picture) { picture in
                // The viewer shows this one file, already downloaded.
                PhotoViewer(images: [picture.file.viewerImage], start: 0)
                    .environment(\.apiFileLoader) { _, _ in picture.data }
            }
            .fullScreenCover(item: $playing) { item in
                StreamPlayer(item: item) { notice = String(localized: "Failed to load the file") }
                    .ignoresSafeArea()
            }
            .quickLookPreview($preview)
            .onChange(of: preview) { old, new in
                if new == nil, let old { try? FileManager.default.removeItem(at: old.deletingLastPathComponent()) }
            }
            .sheet(item: $sharing) { shared in
                ActivitySheet(items: [shared.url])
                    .presentationDetents([.medium, .large])
            }
            .onChange(of: covers) { _, covers in shown(covers) }
            .onDisappear { if covers { shown(false) } }
            .onChange(of: request) { _, asked in
                guard let asked else { return }
                request = nil
                open(asked.file)
            }
    }

    private var covers: Bool { preview != nil || sharing != nil || picture != nil || playing != nil }

    private func open(_ file: LinkedFile?) {
        guard let file else {
            notice = String(localized: "This file cannot be opened here.")
            return
        }
        // A second tap while the first downloads opens nothing more.
        guard !loading else { return }
        loading = true
        Task {
            defer { loading = false }
            do {
                // An instance that cannot say what it is gets the download tried.
                switch (try? await backend.linkedFileKind(file)) ?? .file {
                case .folder:
                    if let page = file.page { openPage(page) } else { notice = String(localized: "This file cannot be opened here.") }
                    return
                case .missing:
                    throw APIError.notFound
                case .file:
                    break
                }
                // A player streams from the instance itself, which the demo
                // has not, and a debug build cannot hand a dev host's access
                // headers to AVKit: those download the file instead.
                if file.opening == .media, let origin = backend.origin,
                   let url = APIClient.fileURL(origin: origin, apiPath: file.streamPath, percentEncodedQuery: file.query),
                   !DevAccess.stamps(url) {
                    playing = MediaItem(url: url, cookie: backend.webSessionCookie())
                    return
                }
                let data = try await backend.linkedFile(file)
                // A picture past what the viewer loads opens in Quick Look.
                if file.opening == .picture, data.count <= APIClient.imageLimit {
                    picture = Picture(file: file, data: data)
                    return
                }
                guard let url = AgentOutputsView.write(data, name: file.name) else { throw APIError.network }
                if file.opening != .share, AgentOutputsView.quickLookReads(url) {
                    preview = url
                } else {
                    sharing = SharedFile(url: url)
                }
            } catch {
                notice = switch error as? APIError {
                case .tooLarge: String(localized: "Too large to open on this phone.")
                case .notFound: String(localized: "Moved or deleted")
                default: String(localized: "Failed to load the file")
                }
            }
        }
    }
}

/// How the phone opens a file, by what it previews as.
enum FileOpening: Equatable {
    /// In the picture viewer.
    case picture
    /// Streamed in the system player, never downloaded first, where the
    /// instance can stream it.
    case media
    /// Downloaded, then in Quick Look when it reads the file.
    case preview
    /// Downloaded, then only in the share sheet: a page or an SVG would run in a preview.
    case share
}

extension LinkedFile: Identifiable {
    var id: String { apiPath + "?" + (query ?? "") }

    /// The video and audio extensions AVFoundation plays. WebM and Ogg are
    /// not among them: those download and go to Quick Look or the share sheet.
    static let playable: Set<String> = ["mp4", "mov", "m4v", "m4a", "mp3", "aac", "wav", "flac"]

    var opening: FileOpening {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["html", "htm", "svg", "xhtml"].contains(ext) { return .share }
        switch previewKind {
        case .image: return .picture
        case .video, .audio: return Self.playable.contains(ext) ? .media : .preview
        default: return .preview
        }
    }

    /// Where a player reads it in parts: a project or memory file's asset
    /// route, which answers ranges where its download does not.
    var streamPath: String {
        for folder in ["projects", "memory"] where apiPath == "/\(folder)/download" { return "/\(folder)/asset" }
        return apiPath
    }

    /// The picture viewer's page for it, read through the session.
    var viewerImage: ViewerImage {
        let src = "/api" + apiPath + (query.map { "?" + $0 } ?? "")
        return .markdown(ImageSource(src: src), alt: name, src: src, position: 0)
    }
}

/// A picture to show, with the bytes already downloaded for it.
private struct Picture: Identifiable {
    let file: LinkedFile
    let data: Data
    var id: String { file.id }
}

/// A video or audio file to stream, with the session that reads it.
struct MediaItem: Identifiable {
    let id = UUID()
    let url: URL
    let cookie: HTTPCookie?
}

/// The system player over the whole screen, streaming `item`: AVKit asks the
/// instance for the parts it plays and seeks to, so nothing is downloaded
/// first. The cover holds a bare controller that presents the player the
/// standard way, so the player's own close button and swipe down close it,
/// and then the cover goes.
private struct StreamPlayer: UIViewControllerRepresentable {
    let item: MediaItem
    /// Runs when the player cannot play the file, once the cover is gone.
    let failed: () -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> Host {
        Host(item: item, onClose: { didFail in
            dismiss()
            if didFail { failed() }
        })
    }

    func updateUIViewController(_ host: Host, context: Context) {}

    final class Host: UIViewController {
        private let item: MediaItem
        private let onClose: (Bool) -> Void
        private var shown = false

        init(item: MediaItem, onClose: @escaping (Bool) -> Void) {
            self.item = item
            self.onClose = onClose
            super.init(nibName: nil, bundle: nil)
            view.backgroundColor = .black
        }

        required init?(coder: NSCoder) { nil }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !shown else { return }
            shown = true
            var options: [String: Any] = [:]
            if let cookie = item.cookie { options[AVURLAssetHTTPCookiesKey] = [cookie] }
            let player = ClosingPlayer()
            player.onClose = onClose
            player.watch(AVPlayerItem(asset: AVURLAsset(url: item.url, options: options)))
            player.modalPresentationStyle = .fullScreen
            present(player, animated: false) { player.player?.play() }
        }
    }

    /// Says when it closed: by the person, or by itself when the file
    /// cannot be played (a refused request, a format it cannot read).
    final class ClosingPlayer: AVPlayerViewController {
        var onClose: ((Bool) -> Void)?
        private var failed = false
        private var status: NSKeyValueObservation?

        func watch(_ item: AVPlayerItem) {
            player = AVPlayer(playerItem: item)
            status = item.observe(\.status) { [weak self] item, _ in
                guard item.status == .failed else { return }
                Task { @MainActor in
                    guard let self, !self.failed else { return }
                    self.failed = true
                    self.dismiss(animated: true)
                }
            }
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            guard isBeingDismissed else { return }
            status = nil
            player?.pause()
            onClose?(failed)
            onClose = nil
        }
    }
}
