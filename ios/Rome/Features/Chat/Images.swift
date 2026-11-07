import SwiftUI
import UIKit

/// Where a Markdown image's bytes come from, by the web's rules
/// (packages/web/src/lib/markdown-url.ts): a file of the instance's own,
/// fetched with the session; a public https image, fetched with no cookies;
/// anything else is not loaded, and its alt text shows instead.
enum ImageSource: Hashable, Sendable {
    /// A logical path, `projects/…` or `memory/…`, for the instance's asset route.
    case asset(path: String)
    case external(URL)
    case rejected

    init(src raw: String) {
        let src = raw.trimmingCharacters(in: .whitespaces)
        if src.hasPrefix("/") && !src.hasPrefix("//") {
            self = Self.internalPath(src).map { .asset(path: $0) } ?? .rejected
            return
        }
        if let url = URL(string: src), url.scheme?.lowercased() == "https", url.host() != nil {
            self = .external(url)
            return
        }
        self = .rejected
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
    /// No cookies, no cache on disk: an outside host never sees the session.
    static let publicSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    @MainActor
    static func data(_ source: ImageSource, assetLoader: (@MainActor (String) async throws -> Data)?) async throws -> Data {
        switch source {
        case .asset(let path):
            guard let assetLoader else { throw APIError.network }
            return try await assetLoader(path)
        case .external(let url):
            let (data, response) = try await publicSession.data(from: url)
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
    case markdown(ImageSource, alt: String, src: String)

    var id: String {
        switch self {
        case .local(let photo): return photo.id.uuidString
        case .stored(let upload): return upload.linkPath
        case .markdown(_, _, let src): return src
        }
    }

    var label: Text {
        switch self {
        case .local, .stored: return Text("Photo")
        case .markdown(_, let alt, _): return alt.isEmpty ? Text("Image") : Text(verbatim: alt)
        }
    }

    func matches(src: String) -> Bool {
        if case .markdown(_, _, let own) = self { return own == src }
        return false
    }

    @MainActor
    func data(assetLoader: (@MainActor (String) async throws -> Data)?) async throws -> Data {
        switch self {
        case .local(let photo): return photo.jpeg
        case .stored(let upload): return try await ImageFetch.data(.asset(path: upload.assetPath), assetLoader: assetLoader)
        case .markdown(let source, _, _): return try await ImageFetch.data(source, assetLoader: assetLoader)
        }
    }
}

/// A Markdown image in a reply: as wide as the bubble, at most about 240 pt
/// tall, filled and cropped. A tap opens the viewer.
struct MarkdownImageView: View {
    let source: ImageSource
    let alt: String
    let onOpen: () -> Void
    @Environment(\.assetLoader) private var assetLoader
    @State private var image: CGImage?
    @State private var failed = false

    nonisolated static let maxHeight: CGFloat = 240
    /// Big enough for a bubble's width at 3x.
    nonisolated static let pixels: CGFloat = 900

    var body: some View {
        Group {
            if source == .rejected {
                // Not something the app loads: the alt text stands in.
                Text(verbatim: alt.isEmpty ? String(localized: "Image") : alt)
                    .romeFont(15)
                    .foregroundStyle(Palette.sub)
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
        let key = "md|\(source)"
        if let cached = StoredImageCache.image(key) {
            image = cached
            return
        }
        do {
            let data = try await ImageFetch.data(source, assetLoader: assetLoader)
            let decoded = await Task.detached(priority: .userInitiated) {
                ImageCompressor.thumbnail(from: data, maxPixel: Self.pixels)
            }.value
            guard let decoded else { throw APIError.network }
            StoredImageCache.store(decoded, for: key)
            image = decoded
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { failed = true }
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
    @State private var loaded: [String: UIImage] = [:]
    @State private var sharing: UIImage?
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
                    ViewerPage(image: image, zoomed: $zoomed) { loaded[image.id] = $0 }
                        .tag(offset)
                }
            }
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
                    if let current = currentImage {
                        viewerButton("square.and.arrow.up", label: "Share") { sharing = current }
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
        .sheet(item: Binding(get: { sharing.map(SharedImage.init) }, set: { if $0 == nil { sharing = nil } })) { shared in
            ActivitySheet(items: [shared.image])
                .presentationDetents([.medium, .large])
        }
    }

    private var currentImage: UIImage? {
        images.indices.contains(index) ? loaded[images[index].id] : nil
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

private struct SharedImage: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// One page of the viewer: the full image, decoded off the main actor at
/// up to three times the screen.
private struct ViewerPage: View {
    let image: ViewerImage
    @Binding var zoomed: Bool
    let onLoad: (UIImage) -> Void
    @Environment(\.assetLoader) private var assetLoader
    @Environment(\.displayScale) private var displayScale
    @State private var full: UIImage?
    @State private var failed = false

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let full {
                    ZoomableImage(image: full, zoomed: $zoomed)
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
            let data = try await image.data(assetLoader: assetLoader)
            let decoded = await Task.detached(priority: .userInitiated) {
                ImageCompressor.thumbnail(from: data, maxPixel: max(600, longEdge))
            }.value
            guard let decoded else { throw APIError.network }
            let ui = UIImage(cgImage: decoded)
            full = ui
            onLoad(ui)
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

/// Pinch and double-tap zoom on an image, the system way.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
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
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: ZoomableImage
        weak var imageView: UIImageView?

        init(parent: ZoomableImage) { self.parent = parent }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
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
