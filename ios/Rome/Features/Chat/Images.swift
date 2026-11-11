import os
import SwiftUI
import UIKit
import UniformTypeIdentifiers

let imageLog = Logger(subsystem: "cc.romeos.mobile", category: "Images")

/// Where a Markdown image's bytes come from, by the web's rules
/// (packages/web/src/lib/markdown-url.ts and internal-href.ts): a URL of the
/// instance's own, fetched with the session; a public https image, fetched
/// with no cookies; anything else is not loaded, and its alt text shows instead.
enum ImageSource: Hashable, Sendable {
    /// A logical path, `projects/…` or `memory/…`, for the instance's asset route.
    case asset(path: String)
    /// An `/api/…` URL of the instance's, sent as written: `path` after `/api`,
    /// `query` still percent-encoded.
    case instance(path: String, query: String?)
    case external(URL)
    case rejected

    /// `origin`: the instance's, so its own absolute URLs count as internal.
    init(src raw: String, origin: URL? = nil) {
        var src = raw.trimmingCharacters(in: .whitespaces)
        if let origin, let url = URL(string: src), url.scheme != nil {
            guard Self.sameOrigin(url, origin) else {
                self = url.scheme?.lowercased() == "https" && url.host() != nil ? .external(url) : .rejected
                return
            }
            // The path and query as written, still percent-encoded.
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            src = (components?.percentEncodedPath ?? "") + (components?.percentEncodedQuery.map { "?\($0)" } ?? "")
        } else if src.hasPrefix("projects/") || src.hasPrefix("memory/") {
            src = "/" + src
        }
        if src.hasPrefix("/") && !src.hasPrefix("//") {
            self = Self.internalSource(src)
            return
        }
        if let url = URL(string: src), url.scheme?.lowercased() == "https", url.host() != nil {
            self = .external(url)
            return
        }
        self = .rejected
    }

    private static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        func port(_ url: URL) -> Int? { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : url.scheme?.lowercased() == "http" ? 80 : nil) }
        return url.scheme?.lowercased() == origin.scheme?.lowercased()
            && url.host()?.lowercased() == origin.host()?.lowercased()
            && port(url) == port(origin)
    }

    private static func internalSource(_ src: String) -> ImageSource {
        let withoutFragment = String(src.prefix { $0 != "#" })
        let pathname = String(withoutFragment.prefix { $0 != "?" })
        guard pathname.hasPrefix("/api/") else {
            return internalPath(src).map { .asset(path: $0) } ?? .rejected
        }
        // An API URL, such as an asset URL already: as written, through the session.
        let rest = withoutFragment.dropFirst(pathname.count)
        let query = rest.isEmpty ? nil : String(rest.dropFirst())
        guard let path = encoded(String(pathname.dropFirst(4)), allowed: .urlPathAllowed),
              path.count > 1,
              path.split(separator: "/").allSatisfy({ segment in
                  let decoded = String(segment).removingPercentEncoding ?? ""
                  return decoded != "." && decoded != ".." && !decoded.contains("\\")
              })
        else { return .rejected }
        if let query, !query.isEmpty {
            guard let query = encoded(query, allowed: .urlQueryAllowed) else { return .rejected }
            return .instance(path: path, query: query)
        }
        return .instance(path: path, query: nil)
    }

    /// Encodes what a URL cannot carry as is (a space, a CJK name) and keeps
    /// the escapes already there; nil for a stray `%`.
    private static func encoded(_ text: String, allowed: CharacterSet) -> String? {
        guard let result = text.addingPercentEncoding(withAllowedCharacters: allowed.union(CharacterSet(charactersIn: "%"))) else { return nil }
        var rest = Substring(result)
        while let percent = rest.firstIndex(of: "%") {
            let hex = rest[rest.index(after: percent)...].prefix(2)
            guard hex.count == 2, hex.allSatisfy(\.isHexDigit) else { return nil }
            rest = rest[rest.index(percent, offsetBy: 3)...]
        }
        return result
    }

    /// `/projects/a%20b/c.png` → `projects/a b/c.png`; nil for any other
    /// internal path, or one with an empty, `.` or `..` segment.
    private static func internalPath(_ src: String) -> String? {
        let pathname = String(src.split(whereSeparator: { $0 == "?" || $0 == "#" }).first ?? "")
        let trimmed = pathname.dropFirst()
        guard let slash = trimmed.firstIndex(of: "/") else { return nil }
        let root = String(trimmed[trimmed.startIndex..<slash])
        guard root == "projects" || root == "memory" else { return nil }
        let rest = trimmed[trimmed.index(after: slash)...].trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !rest.isEmpty else { return nil }
        var segments: [String] = []
        for segment in rest.split(separator: "/", omittingEmptySubsequences: false) {
            guard let decoded = String(segment).removingPercentEncoding,
                  !decoded.isEmpty, decoded != ".", decoded != "..",
                  !decoded.contains("/"), !decoded.contains("\\")
            else { return nil }
            segments.append(decoded)
        }
        return "\(root)/\(segments.joined(separator: "/"))"
    }
}

/// Bytes of an image, from the instance or the open web.
enum ImageFetch {
    /// The query of an instance asset URL with `w=width` added; any other URL, or
    /// one that already names a width, keeps its query.
    static func assetQuery(_ query: String?, path: String, width: Int?) -> String? {
        guard let width, let query, !query.isEmpty,
              path == "/projects/asset" || path.hasPrefix("/projects/asset/") || path == "/memory/asset" || path.hasPrefix("/memory/asset/"),
              !query.split(separator: "&").contains(where: { $0.hasPrefix("w=") })
        else { return query }
        return "\(query)&w=\(width)"
    }

    /// No cookies, no cache on disk: an outside host never sees the session.
    static let publicSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    @MainActor
    /// `width`: ask the instance for a thumbnail this wide (600 or 900) of one of
    /// its own pictures. An external image ignores it, and nil is the original.
    static func data(_ source: ImageSource, assetLoader: (@MainActor (String, Int?) async throws -> Data)?, apiLoader: (@MainActor (String, String?) async throws -> Data)? = nil, width: Int? = nil) async throws -> Data {
        switch source {
        case .asset(let path):
            guard let assetLoader else { throw APIError.network }
            return try await assetLoader(path, width)
        case .instance(let path, let query):
            guard let apiLoader else { throw APIError.network }
            return try await apiLoader(path, assetQuery(query, path: path, width: width))
        case .external(let url):
            let (data, response) = try await APIClient.cappedData(for: URLRequest(url: url), in: publicSession, limit: APIClient.imageLimit)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw APIError.network }
            return data
        case .rejected:
            throw APIError.notFound
        }
    }
}

/// One image the viewer can show.
enum ViewerImage: Identifiable, Hashable {
    case local(ComposerImage)
    case stored(UploadLines.Upload)
    /// `position`: its block in the reply, so the same image twice is two pages.
    case markdown(ImageSource, alt: String, src: String, position: Int)

    var id: String {
        switch self {
        case .local(let photo): return photo.id.uuidString
        case .stored(let upload): return upload.linkPath
        case .markdown(_, _, let src, let position): return "\(position)|\(src)"
        }
    }

    var label: Text {
        switch self {
        case .local, .stored: return Text("Photo")
        case .markdown(_, let alt, _, _): return alt.isEmpty ? Text("Image") : Text(verbatim: alt)
        }
    }

    func matches(position: Int) -> Bool {
        if case .markdown(_, _, _, let own) = self { return own == position }
        return false
    }

    /// A name for the shared file, without its extension.
    var fileName: String {
        switch self {
        case .local, .stored: return String(localized: "Photo")
        case .markdown(_, let alt, _, _): return alt.isEmpty ? String(localized: "Image") : alt
        }
    }

    @MainActor
    func data(assetLoader: (@MainActor (String, Int?) async throws -> Data)?, apiLoader: (@MainActor (String, String?) async throws -> Data)? = nil) async throws -> Data {
        switch self {
        case .local(let photo): return photo.jpeg
        case .stored(let upload): return try await ImageFetch.data(.asset(path: upload.assetPath), assetLoader: assetLoader)
        case .markdown(let source, _, _, _): return try await ImageFetch.data(source, assetLoader: assetLoader, apiLoader: apiLoader)
        }
    }
}

/// A Markdown image in a reply: as wide as the bubble, at most about 240 pt
/// tall, filled and cropped. A tap opens the viewer.
struct MarkdownImageView: View {
    let source: ImageSource
    let alt: String
    /// As written, for the log when it does not load.
    var src: String = ""
    let onOpen: () -> Void
    @Environment(\.assetLoader) private var assetLoader
    @Environment(\.apiFileLoader) private var apiLoader
    @State private var image: CGImage?
    @State private var failed = false

    nonisolated static let maxHeight: CGFloat = 240
    /// Big enough for a bubble's width at 3x. It is also a width the server
    /// offers (`?w=900`), so keep the two in step.
    nonisolated static let pixels: CGFloat = 900

    var body: some View {
        Group {
            if source == .rejected {
                // Not something the app loads: the alt text stands in.
                Text(verbatim: alt.isEmpty ? String(localized: "Image") : alt)
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
                    .onAppear { imageLog.notice("reply image not loaded, not an allowed source: \(src, privacy: .public)") }
            } else if let image {
                Color.clear
                    .aspectRatio(CGFloat(image.width) / CGFloat(max(1, image.height)), contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: Self.maxHeight)
                    .overlay {
                        Image(decorative: image, scale: 1).resizable().scaledToFill()
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onOpen)
                    .accessibilityElement()
                    .accessibilityLabel(alt.isEmpty ? Text("Image") : Text(verbatim: alt))
                    .accessibilityAddTraits([.isImage, .isButton])
                    .accessibilityHint("Opens the image full screen")
            } else if failed {
                ImageFailedTile(label: alt)
                    .frame(maxWidth: .infinity)
                    .frame(height: 120)
                    .onTapGesture { failed = false }
                    .onDisappear { failed = false }
            } else {
                Palette.fill
                    .frame(maxWidth: .infinity)
                    .frame(height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay { Spinner(size: 16, color: Palette.sub) }
                    .task(id: source) { await load() }
            }
        }
    }

    private func load() async {
        let key = StoredImageCache.shared.key("md|\(source)")
        if let cached = StoredImageCache.shared.image(key) {
            image = cached
            return
        }
        do {
            // A thumbnail of the size it shows at, not the original. The viewer fetches the original.
            let data = try await ImageFetch.data(source, assetLoader: assetLoader, apiLoader: apiLoader, width: Int(Self.pixels))
            let decoded = await Task.detached(priority: .userInitiated) {
                ImageCompressor.thumbnail(from: data, maxPixel: Self.pixels)
            }.value
            guard let decoded else {
                // Not an image, such as a page or an error in JSON.
                imageLog.error("reply image is not an image: \(src, privacy: .public) as \(String(describing: source), privacy: .public), \(data.count) bytes")
                throw APIError.decoding
            }
            StoredImageCache.shared.store(decoded, for: key)
            image = decoded
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled {
                if (error as? APIError) != .decoding {
                    imageLog.error("reply image failed: \(src, privacy: .public) as \(String(describing: source), privacy: .public): \(String(describing: error), privacy: .public)")
                }
                failed = true
            }
        }
    }
}

/// An image that did not load; a tap tries again.
struct ImageFailedTile: View {
    var label: String = ""

    var body: some View {
        Palette.fill
            .overlay {
                VStack(spacing: 4) {
                    Image(systemName: "photo").romeFont(16, .medium)
                    Text("Image").romeFont(12, .medium)
                }
                .foregroundStyle(Palette.sub)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label.isEmpty ? Text("Image") : Text(verbatim: label))
            .accessibilityHint("Tap to try again")
    }
}

// MARK: - Viewer

/// The images of one message, full screen on black: pinch or double-tap to
/// zoom, swipe sideways between them, swipe down to close, share at the top.
struct PhotoViewer: View {
    let images: [ViewerImage]
    @State private var index: Int
    @State private var dragY: CGFloat = 0
    @State private var zoomed = false
    /// The bytes as they came, shared as they are: full size, metadata, animation.
    @State private var originals: [String: Data] = [:]
    @State private var sharing: SharedFile?
    @Environment(\.dismiss) private var dismiss

    init(images: [ViewerImage], start: Int) {
        self.images = images
        _index = State(initialValue: min(max(0, start), max(0, images.count - 1)))
    }

    var body: some View {
        ZStack {
            Color.black
                .opacity(1 - min(0.7, abs(dragY) / 400))
                .ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(images.enumerated()), id: \.element.id) { offset, image in
                    ViewerPage(image: image, current: offset == index, zoomed: $zoomed) { originals[image.id] = $0 }
                        .tag(offset)
                }
            }
            // Each page starts unzoomed; the one left behind zooms back out.
            .onChange(of: index) { zoomed = false }
            .tabViewStyle(.page(indexDisplayMode: images.count > 1 ? .automatic : .never))
            .ignoresSafeArea()
            .offset(y: dragY)
            .simultaneousGesture(
                DragGesture(minimumDistance: 24)
                    .onChanged { value in
                        guard !zoomed, abs(value.translation.height) > abs(value.translation.width) else { return }
                        dragY = value.translation.height
                    }
                    .onEnded { _ in
                        if abs(dragY) > 120 {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { dragY = 0 }
                        }
                    }
            )
            VStack {
                HStack {
                    viewerButton("xmark", label: "Close") { dismiss() }
                    Spacer()
                    if let current = currentOriginal {
                        viewerButton("square.and.arrow.up", label: "Share") {
                            sharing = SharedFile.write(current.data, name: current.image.fileName)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }
            .opacity(dragY == 0 ? 1 : 0)
        }
        .statusBarHidden()
        .preferredColorScheme(.dark)
        .accessibilityAction(.escape) { dismiss() }
        .sheet(item: $sharing) { shared in
            ActivitySheet(items: [shared.url])
                .presentationDetents([.medium, .large])
        }
    }

    private var currentOriginal: (image: ViewerImage, data: Data)? {
        guard images.indices.contains(index), let data = originals[images[index].id] else { return nil }
        return (images[index], data)
    }

    private func viewerButton(_ systemImage: String, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .romeFont(16, .semibold)
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(.white.opacity(0.14), in: Circle())
        }
        .accessibilityLabel(label)
    }
}

/// An image's original bytes in a temporary file named for what it is, so
/// the share sheet saves or sends the file itself, not a re-encoded copy.
struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL

    static func write(_ data: Data, name: String) -> SharedFile? {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Shared-\(UUID().uuidString)", directoryHint: .isDirectory)
        let safeName = name.components(separatedBy: CharacterSet(charactersIn: "/\\:")).joined(separator: " ").prefix(80)
        let url = folder.appending(path: "\(safeName.isEmpty ? "Image" : String(safeName)).\(fileExtension(data))")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return SharedFile(url: url)
        } catch {
            return nil
        }
    }

    /// From the bytes themselves: what the image is, not what its link says.
    static func fileExtension(_ data: Data) -> String {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }),
              let ext = type.preferredFilenameExtension
        else { return "jpg" }
        return ext
    }
}

/// One page of the viewer: the full image, decoded off the main actor at
/// up to three times the screen.
private struct ViewerPage: View {
    let image: ViewerImage
    /// The page on screen: only it reports zoom, and the others zoom back out.
    let current: Bool
    @Binding var zoomed: Bool
    /// The original bytes, for sharing.
    let onLoad: (Data) -> Void
    @Environment(\.assetLoader) private var assetLoader
    @Environment(\.apiFileLoader) private var apiLoader
    @Environment(\.displayScale) private var displayScale
    @State private var full: UIImage?
    @State private var failed = false

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let full {
                    ZoomableImage(image: full, current: current, zoomed: $zoomed)
                        .accessibilityElement()
                        .accessibilityLabel(image.label)
                        .accessibilityAddTraits(.isImage)
                } else if failed {
                    ImageFailedTile()
                        .frame(width: 160, height: 120)
                        .onTapGesture { failed = false }
                } else {
                    Spinner(size: 22, color: .white.opacity(0.7))
                        .task(id: image.id) { await load(longEdge: max(geometry.size.width, geometry.size.height) * min(3, displayScale)) }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private func load(longEdge: CGFloat) async {
        do {
            let data = try await image.data(assetLoader: assetLoader, apiLoader: apiLoader)
            let decoded = await Task.detached(priority: .userInitiated) {
                ImageCompressor.thumbnail(from: data, maxPixel: max(600, longEdge))
            }.value
            guard let decoded else { throw APIError.network }
            full = UIImage(cgImage: decoded)
            onLoad(data)
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

/// Pinch and double-tap zoom on an image, the system way.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let current: Bool
    @Binding var zoomed: Bool

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .clear
        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            imageView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
        ])
        context.coordinator.imageView = imageView
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.imageView?.image !== image { context.coordinator.imageView?.image = image }
        if !current && scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: false) }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: ZoomableImage
        weak var imageView: UIImageView?

        init(parent: ZoomableImage) { self.parent = parent }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            guard parent.current else { return }
            let zoomed = scrollView.zoomScale > 1.01
            if parent.zoomed != zoomed { parent.zoomed = zoomed }
        }

        @objc func doubleTapped(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1.01 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

/// The system share sheet: save to Photos, send, and so on.
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
