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
    /// preview would run it. A file that fails, or that no route serves, gets
    /// a short notice at the top.
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
    @State private var picture: LinkedFile?
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
            .fullScreenCover(item: $picture) { file in
                PhotoViewer(images: [file.viewerImage], start: 0)
                    .environment(\.apiFileLoader) { [backend] path, query in try await backend.apiFile(path: path, query: query) }
            }
            .fullScreenCover(item: $playing) { item in
                StreamPlayer(item: item)
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
                switch file.opening {
                case .picture:
                    picture = file
                    return
                case .media:
                    guard let origin = backend.origin,
                          let url = APIClient.fileURL(origin: origin, apiPath: file.streamPath, percentEncodedQuery: file.query)
                    else { throw APIError.notFound }
                    playing = MediaItem(url: url, cookie: backend.webSessionCookie())
                    return
                case .preview, .share:
                    break
                }
                let data = try await backend.linkedFile(file)
                guard let url = AgentOutputsView.write(data, name: file.name) else { throw APIError.network }
                if file.opening == .preview, AgentOutputsView.quickLookReads(url) {
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
    /// Streamed in the system player, never downloaded first.
    case media
    /// Downloaded, then in Quick Look when it reads the file.
    case preview
    /// Downloaded, then only in the share sheet: a page or an SVG would run in a preview.
    case share
}

extension LinkedFile: Identifiable {
    var id: String { apiPath + "?" + (query ?? "") }

    var opening: FileOpening {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["html", "htm", "svg", "xhtml"].contains(ext) { return .share }
        switch previewKind {
        case .image: return .picture
        case .video, .audio: return .media
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

/// A video or audio file to stream, with the session that reads it.
struct MediaItem: Identifiable {
    let id = UUID()
    let url: URL
    let cookie: HTTPCookie?
}

/// The system player over the whole screen, streaming `item`: AVKit asks the
/// instance for the parts it plays and seeks to, so nothing is downloaded
/// first. Its own close button closes the cover.
private struct StreamPlayer: UIViewControllerRepresentable {
    let item: MediaItem
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(close: { dismiss() }) }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        var options: [String: Any] = [:]
        if let cookie = item.cookie { options[AVURLAssetHTTPCookiesKey] = [cookie] }
        // A debug build reaches a dev instance behind Cloudflare Access with its client headers.
        var stamped = URLRequest(url: item.url)
        DevAccess.stamp(&stamped)
        if let headers = stamped.allHTTPHeaderFields, !headers.isEmpty {
            options["AVURLAssetHTTPHeaderFieldsKey"] = headers
        }
        let player = AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: item.url, options: options)))
        let controller = AVPlayerViewController()
        controller.delegate = context.coordinator
        controller.player = player
        player.play()
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
        controller.player?.pause()
    }

    @MainActor
    final class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        let close: () -> Void
        init(close: @escaping () -> Void) { self.close = close }

        // Filling the cover, the player reads as full screen, and its close
        // button ends that.
        nonisolated func playerViewController(
            _ playerViewController: AVPlayerViewController,
            willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
        ) {
            MainActor.assumeIsolated { close() }
        }
    }
}
