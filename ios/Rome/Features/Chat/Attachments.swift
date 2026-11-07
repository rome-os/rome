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

    /// A camera or pasteboard image.
    nonisolated static func jpeg(from image: UIImage, longEdge: CGFloat = longEdge, maxBytes: Int = maxBytes) -> Data? {
        // Drawing turns it upright; PNG keeps every pixel for the downsampling above.
        guard let data = upright(image).pngData() else { return nil }
        return jpeg(from: data, longEdge: longEdge, maxBytes: maxBytes)
    }

    nonisolated private static func upright(_ image: UIImage) -> UIImage {
        guard image.imageOrientation != .up else { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
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

/// One photo waiting in the composer.
struct ComposerImage: Identifiable, Equatable, Sendable {
    let id = UUID()
    /// The JPEG that is sent.
    let jpeg: Data
}

/// The photos in the composer: up to four per message.
@MainActor
@Observable
final class ComposerAttachments {
    static let limit = 4
    private(set) var images: [ComposerImage] = []
    /// How many are being made small right now, so the + waits.
    private(set) var preparing = 0

    var remaining: Int { max(0, Self.limit - images.count - preparing) }
    var isFull: Bool { remaining == 0 }

    /// Adds image files' bytes, as many as fit. Returns how many were taken.
    @discardableResult
    func add(data items: [Data]) async -> Int {
        let taken = Array(items.prefix(remaining))
        guard !taken.isEmpty else { return 0 }
        preparing += taken.count
        defer { preparing -= taken.count }
        for item in taken {
            let jpeg = await Task.detached(priority: .userInitiated) { ImageCompressor.jpeg(from: item) }.value
            if let jpeg { images.append(ComposerImage(jpeg: jpeg)) }
        }
        return taken.count
    }

    /// Adds camera or pasteboard images, as many as fit.
    @discardableResult
    func add(images items: [UIImage]) async -> Int {
        let taken = Array(items.prefix(remaining))
        guard !taken.isEmpty else { return 0 }
        preparing += taken.count
        defer { preparing -= taken.count }
        for item in taken {
            let jpeg = await Task.detached(priority: .userInitiated) { ImageCompressor.jpeg(from: item) }.value
            if let jpeg { images.append(ComposerImage(jpeg: jpeg)) }
        }
        return taken.count
    }

    func remove(_ id: UUID) {
        images.removeAll { $0.id == id }
    }

    /// Hands the photos to a send and empties the composer.
    func take() -> [Data] {
        defer { images = [] }
        return images.map(\.jpeg)
    }
}

/// A file in a turn's `files`: `POST /chat/sessions/:id/turns`.
struct OutgoingFile: Encodable, Equatable, Sendable {
    var name: String
    var mimeType: String
    var dataBase64: String

    /// Photos named in the order they were attached.
    static func photos(_ jpegs: [Data]) -> [OutgoingFile] {
        jpegs.enumerated().map { index, data in
            OutgoingFile(name: "photo-\(index + 1).jpg", mimeType: "image/jpeg", dataBase64: data.base64EncodedString())
        }
    }
}

/// The server stores no attachment part: it appends one Markdown line per
/// file to the guardian's text, `- File 1: [photo-1.jpg](</projects/…>)`, and
/// keeps the file in the chat's project folder. This splits those lines off.
enum UploadLines {
    struct Upload: Hashable, Sendable {
        let name: String
        /// `/projects/…`, served by `GET /api/projects/asset?path=projects/…`.
        let linkPath: String

        var isImage: Bool {
            ["jpg", "jpeg", "png", "heic", "gif", "webp"].contains((name as NSString).pathExtension.lowercased())
        }

        /// The asset route's `path`: the link without its leading slash.
        var assetPath: String {
            let path = linkPath.hasPrefix("/") ? String(linkPath.dropFirst()) : linkPath
            return path.removingPercentEncoding ?? path
        }
    }

    nonisolated(unsafe) private static let line = try! NSRegularExpression(pattern: #"^- File \d+: \[(.*)\]\(<(.+)>\)$"#)

    /// The text the guardian wrote, and the files listed after it.
    nonisolated static func split(_ text: String) -> (text: String, uploads: [Upload]) {
        var lines = text.components(separatedBy: "\n")
        var uploads: [Upload] = []
        while let last = lines.last {
            let range = NSRange(last.startIndex..., in: last)
            guard let match = line.firstMatch(in: last, range: range),
                  let name = Range(match.range(at: 1), in: last),
                  let link = Range(match.range(at: 2), in: last)
            else { break }
            uploads.insert(Upload(name: String(last[name]).replacingOccurrences(of: "\\", with: ""), linkPath: String(last[link])), at: 0)
            lines.removeLast()
        }
        guard !uploads.isEmpty else { return (text, []) }
        return (lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), uploads)
    }
}
