import CryptoKit
import Foundation
import UIKit

/// Small images kept on disk across launches: app icons and the account
/// picture. Each is stored as drawn (PNG at the screen's scale), per instance,
/// with what it was drawn from, so it shows at once on the next launch and is
/// replaced only when the source changed.
struct ImageDiskCache: Sendable {
    let root: URL
    /// Past this, the oldest images go first.
    var limit = 20 * 1024 * 1024

    static let shared = ImageDiskCache(root: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appending(path: "Images", directoryHint: .isDirectory))

    /// What a stored image was drawn from: the source's version where it has
    /// one (an app's `version`), and the bytes' hash.
    struct Stamp: Codable, Equatable, Sendable {
        var version: String?
        var hash: String
    }

    struct Entry: Sendable {
        let png: Data
        let stamp: Stamp
    }

    /// The bytes' hash, the stamp when the source names no version.
    static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func entry(instance: String, key: String) -> Entry? {
        let base = file(instance: instance, key: key)
        guard let png = try? Data(contentsOf: base.appendingPathExtension("png")),
              let meta = try? Data(contentsOf: base.appendingPathExtension("json")),
              let stamp = try? JSONDecoder().decode(Stamp.self, from: meta)
        else { return nil }
        // Read: it is the newest to go when the cache trims.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: base.appendingPathExtension("png").path(percentEncoded: false))
        return Entry(png: png, stamp: stamp)
    }

    func store(_ png: Data, stamp: Stamp, instance: String, key: String) {
        let base = file(instance: instance, key: key)
        let manager = FileManager.default
        try? manager.createDirectory(at: base.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? png.write(to: base.appendingPathExtension("png"), options: .atomic)
        if let meta = try? JSONEncoder().encode(stamp) { try? meta.write(to: base.appendingPathExtension("json"), options: .atomic) }
        trim()
    }

    /// Sign-out: every instance's images.
    func removeAll() {
        try? FileManager.default.removeItem(at: root)
        Self.drawn.removeAllObjects()
    }

    /// The images read from disk, drawn, by `drawnKey`. A view that shows one
    /// reads it in its initializer, which runs on each update of its parent:
    /// from here, that is no file read and no PNG decode.
    nonisolated(unsafe) static let drawn: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 200
        return cache
    }()

    func drawnKey(instance: String, key: String) -> NSString {
        file(instance: instance, key: key).path(percentEncoded: false) as NSString
    }

    /// Oldest first until under the limit.
    func trim() {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else { return }
        var files: [(url: URL, size: Int, date: Date)] = []
        for case let url as URL in enumerator where url.pathExtension == "png" {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            files.append((url, values?.fileSize ?? 0, values?.contentModificationDate ?? .distantPast))
        }
        var total = files.reduce(0) { $0 + $1.size }
        for file in files.sorted(by: { $0.date < $1.date }) where total > limit {
            try? manager.removeItem(at: file.url)
            try? manager.removeItem(at: file.url.deletingPathExtension().appendingPathExtension("json"))
            total -= file.size
        }
    }

    /// One folder per instance, so no instance reads another's images.
    private func file(instance: String, key: String) -> URL {
        root.appending(path: DraftStore.safe(instance), directoryHint: .isDirectory).appending(path: DraftStore.safe(key))
    }
}

/// Shows a cached image at once and replaces it only when its source changed.
@MainActor
enum CachedImage {
    /// The stored image for `key`, drawn at the screen's scale.
    static func cached(instance: String, key: String, cache: ImageDiskCache = .shared) -> UIImage? {
        let drawnKey = cache.drawnKey(instance: instance, key: key)
        if let image = ImageDiskCache.drawn.object(forKey: drawnKey) { return image }
        let image = cache.entry(instance: instance, key: key).flatMap { UIImage(data: $0.png, scale: UITraitCollection.current.displayScale) }
        if let image { ImageDiskCache.drawn.setObject(image, forKey: drawnKey) }
        return image
    }

    /// Fetches the source and, when it differs from what is stored, draws and
    /// stores it and answers the new image; nil when nothing changed or it
    /// failed. `account`: whose image it is; once that account has ended, it
    /// is neither stored nor answered.
    static func refresh(
        instance: String, key: String, version: String?,
        account: AccountStamp = .unchecked,
        cache: ImageDiskCache = .shared,
        fetch: () async throws -> Data,
        draw: (Data) async -> UIImage?
    ) async -> UIImage? {
        guard let data = try? await fetch() else { return nil }
        let stamp = ImageDiskCache.Stamp(version: version, hash: ImageDiskCache.hash(data))
        if cache.entry(instance: instance, key: key)?.stamp == stamp { return nil }
        guard let image = await draw(data), let png = image.pngData() else { return nil }
        guard account.ifCurrent({ cache.store(png, stamp: stamp, instance: instance, key: key) }) else { return nil }
        ImageDiskCache.drawn.setObject(image, forKey: cache.drawnKey(instance: instance, key: key))
        return image
    }
}
