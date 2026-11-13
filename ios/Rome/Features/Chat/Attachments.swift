import Foundation
import ImageIO
import Observation
import UIKit
import UniformTypeIdentifiers

/// Photos sent with a message are made small before they go: JPEG, the long
/// edge at most 2048 px, and the quality lowered until the file fits.
enum ImageCompressor {
    static let longEdge: CGFloat = 2048
    /// Four of these, base64 encoded, stay well under what a proxy in front of
    /// Rome accepts in one request.
    static let maxBytes = 2_500_000

    /// Any image file's bytes (HEIC, PNG, JPEG…), turned upright and scaled.
    nonisolated static func jpeg(from data: Data, longEdge: CGFloat = longEdge, maxBytes: Int = maxBytes) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return encode(image, maxBytes: maxBytes)
    }

    /// A camera image: drawn once, upright, straight at the target size.
    nonisolated static func jpeg(from image: UIImage, longEdge: CGFloat = longEdge, maxBytes: Int = maxBytes) -> Data? {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        guard pixels.width > 0, pixels.height > 0 else { return nil }
        let factor = min(1, longEdge / max(pixels.width, pixels.height))
        let target = CGSize(width: (pixels.width * factor).rounded(), height: (pixels.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let cgImage = drawn.cgImage else { return nil }
        return encode(cgImage, maxBytes: maxBytes)
    }

    /// A small, upright decode of any image file, at most `maxPixel` on the
    /// long edge. It never decodes the whole picture.
    nonisolated static func thumbnail(from data: Data, maxPixel: CGFloat) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    nonisolated private static func encode(_ image: CGImage, maxBytes: Int) -> Data? {
        var quality = 0.8
        while true {
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            if output.length <= maxBytes || quality <= 0.3 { return output as Data }
            quality -= 0.15
        }
    }
}

/// One photo waiting in the composer or going out with a message. Two are
/// the same photo when their ids match; the bytes are never compared.
struct ComposerImage: Identifiable, Hashable, Sendable {
    let id: UUID
    /// The JPEG that is sent.
    let jpeg: Data
    /// Made once, for the composer and the bubble.
    let thumbnail: CGImage?

    /// Big enough for a 200 pt bubble tile at 3x.
    static let thumbnailPixels: CGFloat = 600

    /// Decodes the thumbnail: call it off the main actor.
    nonisolated init(id: UUID = UUID(), jpeg: Data) {
        self.id = id
        self.jpeg = jpeg
        thumbnail = ImageCompressor.thumbnail(from: jpeg, maxPixel: Self.thumbnailPixels)
    }

    static func == (a: ComposerImage, b: ComposerImage) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// The photos in the composer: up to four per message.
@MainActor
@Observable
final class ComposerAttachments {
    static let limit = 4
    private(set) var images: [ComposerImage] = []
    /// Slots held by photos still loading or being made small: Send and the
    /// + wait for them.
    private(set) var preparing = 0

    var remaining: Int { max(0, Self.limit - images.count - preparing) }
    var isFull: Bool { remaining == 0 }
    var isPreparing: Bool { preparing > 0 }

    /// Holds up to `count` slots before the photos load. Returns how many.
    func reserve(_ count: Int) -> Int {
        let taken = min(count, remaining)
        preparing += taken
        return taken
    }

    /// Fills `reserved` slots with image files' bytes and gives back the rest.
    func fill(reserved: Int, data items: [Data]) async {
        defer { preparing -= reserved }
        for item in items.prefix(reserved) {
            let photo = await Task.detached(priority: .userInitiated) { () -> ComposerImage? in
                ImageCompressor.jpeg(from: item).map { ComposerImage(jpeg: $0) }
            }.value
            if let photo { images.append(photo) }
        }
    }

    /// Adds image files' bytes, as many as fit. Returns how many were taken.
    @discardableResult
    func add(data items: [Data]) async -> Int {
        let taken = reserve(items.count)
        guard taken > 0 else { return 0 }
        await fill(reserved: taken, data: items)
        return taken
    }

    /// Adds pasted images, as many as fit. The slots are held while the
    /// pasteboard's data loads, off the main actor.
    @discardableResult
    func add(providers: [NSItemProvider]) async -> Int {
        let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        let taken = reserve(images.count)
        guard taken > 0 else { return 0 }
        var files: [Data] = []
        for provider in images.prefix(taken) {
            if let data = await Self.load(provider) { files.append(data) }
        }
        await fill(reserved: taken, data: files)
        return taken
    }

    private static func load(_ provider: NSItemProvider) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    /// Adds camera images, as many as fit.
    @discardableResult
    func add(images items: [UIImage]) async -> Int {
        let taken = reserve(items.count)
        guard taken > 0 else { return 0 }
        defer { preparing -= taken }
        for item in items.prefix(taken) {
            let photo = await Task.detached(priority: .userInitiated) { () -> ComposerImage? in
                ImageCompressor.jpeg(from: item).map { ComposerImage(jpeg: $0) }
            }.value
            if let photo { images.append(photo) }
        }
        return taken
    }

    /// Puts back photos from a saved draft.
    func restore(_ photos: [ComposerImage]) {
        images = Array(photos.prefix(Self.limit))
    }

    func remove(_ id: UUID) {
        images.removeAll { $0.id == id }
    }

    /// Hands the photos to a send and empties the composer.
    func take() -> [ComposerImage] {
        defer { images = [] }
        return images
    }
}

/// A file in a turn's `files`: `POST /chat/sessions/:id/turns`.
struct OutgoingFile: Encodable, Equatable, Sendable {
    var name: String
    var mimeType: String
    var dataBase64: String

    /// Photos named in the order they were attached.
    static func photos(_ photos: [ComposerImage]) -> [OutgoingFile] {
        photos.enumerated().map { index, photo in
            OutgoingFile(name: "photo-\(index + 1).jpg", mimeType: "image/jpeg", dataBase64: photo.jpeg.base64EncodedString())
        }
    }
}

/// The server stores no attachment part: it appends one Markdown line per
/// file to the guardian's text, `- File 1: [photo-1.jpg](</api/assets/…>)`, and
/// keeps the file in its asset store. Older messages link under `/projects/…`.
/// This splits those lines off.
enum UploadLines {
    struct Upload: Hashable, Sendable {
        let name: String
        /// `/api/assets/<id>.<ext>`, or `/projects/…` for an older message.
        let linkPath: String

        var isImage: Bool {
            ["jpg", "jpeg", "png", "heic", "gif", "webp"].contains((name as NSString).pathExtension.lowercased())
        }

        /// The asset route's `path`: the link without its leading slash.
        var assetPath: String {
            let path = linkPath.hasPrefix("/") ? String(linkPath.dropFirst()) : linkPath
            return path.removingPercentEncoding ?? path
        }

        /// Where the bytes come from: the instance's own `/api/assets/…` route as
        /// written, or the projects asset route for an older `/projects/…` link.
        var source: ImageSource {
            linkPath.hasPrefix(UploadLines.assetsPrefix)
                ? .instance(path: String(linkPath.dropFirst(4)), query: nil)
                : .asset(path: assetPath)
        }
    }

    nonisolated static let assetsPrefix = "/api/assets/"

    /// What the server stores a file as: 32 hex digits, a dot, a short extension.
    nonisolated(unsafe) private static let assetName = try! NSRegularExpression(pattern: #"^[0-9a-f]{32}\.[a-z0-9]{1,8}$"#)

    nonisolated private static func isUploadLink(_ link: Substring) -> Bool {
        if link.hasPrefix("/projects/") { return true }
        guard link.hasPrefix(assetsPrefix) else { return false }
        let name = String(link.dropFirst(assetsPrefix.count))
        return assetName.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }

    nonisolated(unsafe) private static let line = try! NSRegularExpression(pattern: #"^- File \d+: \[(.*)\]\(<(.+)>\)$"#)

    /// The text the guardian wrote, and the files listed after it.
    /// Only the server's own list counts: lines linking under /api/assets/ or
    /// /projects/, at the very end, with a blank line (or nothing) before them.
    nonisolated static func split(_ text: String) -> (text: String, uploads: [Upload]) {
        var lines = text.components(separatedBy: "\n")
        var uploads: [Upload] = []
        while let last = lines.last {
            let range = NSRange(last.startIndex..., in: last)
            guard let match = line.firstMatch(in: last, range: range),
                  let name = Range(match.range(at: 1), in: last),
                  let link = Range(match.range(at: 2), in: last),
                  isUploadLink(last[link])
            else { break }
            uploads.insert(Upload(name: String(last[name]).replacingOccurrences(of: "\\", with: ""), linkPath: String(last[link])), at: 0)
            lines.removeLast()
        }
        guard !uploads.isEmpty else { return (text, []) }
        if let before = lines.last, !before.trimmingCharacters(in: .whitespaces).isEmpty { return (text, []) }
        return (lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), uploads)
    }
}
