import SwiftUI

/// A `pictures` block in a reply. A grid is two columns of 4:3 tiles, each with
/// a bold title and up to two lines of note under it, and one picture alone
/// takes the full width. A list is rows with a 3:4 picture on the left and the
/// title and the whole note beside it. A tap on a picture calls `onOpen` with
/// its index in `items`.
struct MarkdownPictureSet: View {
    let layout: PictureLayout
    let items: [PictureItem]
    var fontSize: CGFloat = 16
    let onOpen: (Int) -> Void
    @Environment(\.instanceOrigin) private var origin
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        switch layout {
        case .grid: grid
        case .list: list
        }
    }

    private var grid: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: items.count == 1 ? 1 : 2),
            alignment: .leading,
            spacing: 16
        ) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                VStack(alignment: .leading, spacing: 6) {
                    PictureTile(source: ImageSource(src: item.src, origin: origin), alt: item.alt, aspect: 4.0 / 3.0) { onOpen(index) }
                    caption(item, lines: 2)
                }
            }
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 12) {
                    PictureTile(source: ImageSource(src: item.src, origin: origin), alt: item.alt, aspect: 3.0 / 4.0) { onOpen(index) }
                        .frame(width: sizeClass == .regular ? 180 : 140)
                    caption(item, lines: nil)
                }
            }
        }
    }

    /// `lines`: at most this many lines for each of the title and the note, or all of them.
    private func caption(_ item: PictureItem, lines: Int?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if !item.alt.isEmpty {
                Text(verbatim: item.alt)
                    .romeFont(fontSize - 1, .semibold)
                    .lineLimit(lines)
            }
            if !item.note.isEmpty {
                Text(verbatim: item.note)
                    .romeFont(fontSize - 3)
                    .foregroundStyle(Palette.sub)
                    .lineLimit(lines)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// One picture of a set in a frame of a fixed shape, `aspect` wide for each
/// unit of height, filled and cropped, with rounded corners. The host of an
/// outside picture sits on its corner. A picture that does not load leaves the
/// frame holding the failed tile, so the layout keeps its shape.
struct PictureTile: View {
    let source: ImageSource
    let alt: String
    let aspect: CGFloat
    let onOpen: () -> Void
    @Environment(\.assetLoader) private var assetLoader
    @Environment(\.apiFileLoader) private var apiLoader
    @State private var image: CGImage?
    @State private var failed = false

    /// A width the server offers (`?w=600`), so keep the two in step. The
    /// viewer fetches the original.
    nonisolated static let pixels: CGFloat = 600

    /// The host of an outside picture without a leading `www.`.
    nonisolated static func hostLabel(_ host: String) -> String {
        host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    var body: some View {
        Color.clear
            .aspectRatio(aspect, contentMode: .fit)
            .overlay {
                if source == .rejected || failed {
                    ImageFailedTile(label: alt)
                        .onTapGesture { if source != .rejected { failed = false } }
                } else if let image {
                    Color.clear
                        .overlay { Image(decorative: image, scale: 1).resizable().scaledToFill() }
                        .clipped()
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onOpen)
                        .accessibilityElement()
                        .accessibilityLabel(alt.isEmpty ? Text("Image") : Text(verbatim: alt))
                        .accessibilityAddTraits([.isImage, .isButton])
                        .accessibilityHint("Opens the image full screen")
                } else {
                    Palette.fill
                        .overlay { Spinner(size: 16, color: Palette.sub) }
                        .task(id: source) { await load() }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(alignment: .bottomLeading) {
                if case .external(let url) = source, let host = url.host(), image != nil {
                    Text(verbatim: Self.hostLabel(host))
                        .romeFont(11, .medium)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.regularMaterial, in: Capsule())
                        .padding(6)
                        .allowsHitTesting(false)
                }
            }
    }

    private func load() async {
        let key = StoredImageCache.shared.key("pic|\(source)")
        if let cached = StoredImageCache.shared.image(key) {
            image = cached
            return
        }
        do {
            let data = try await ImageFetch.data(source, assetLoader: assetLoader, apiLoader: apiLoader, width: Int(Self.pixels))
            let decoded = await Task.detached(priority: .userInitiated) {
                ImageCompressor.thumbnail(from: data, maxPixel: Self.pixels)
            }.value
            guard let decoded else {
                imageLog.error("picture set image is not an image: \(String(describing: source), privacy: .public), \(data.count) bytes")
                throw APIError.decoding
            }
            StoredImageCache.shared.store(decoded, for: key)
            image = decoded
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled {
                if (error as? APIError) != .decoding {
                    imageLog.error("picture set image failed: \(String(describing: source), privacy: .public): \(String(describing: error), privacy: .public)")
                }
                failed = true
            }
        }
    }
}
