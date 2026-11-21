import CoreGraphics
import Foundation

/// Pictures already loaded, so scrolling back does not fetch them again. It
/// holds at most 64 MB of decoded pixels in memory, kept while the app is in
/// the background, and on disk (`ImageDiskCache.thumbnails`) the fetched
/// bytes of the open instance's `/api/assets/` pictures, so they show
/// offline and after a relaunch. The app uses `shared`; a test makes its
/// own, so it never sees another test's pictures or resets.
@MainActor
final class StoredImageCache {
    static let shared = StoredImageCache(disk: .thumbnails)

    /// Discardable content, so the cache keeps it when the app goes to the
    /// background: a plain object in an `NSCache` is let go then, and every
    /// picture loaded again on return. Memory pressure still discards it.
    nonisolated private final class Box: NSObject, NSDiscardableContent {
        private(set) var image: CGImage?
        private var accessing = true
        init(_ image: CGImage) { self.image = image }
        func beginContentAccess() -> Bool {
            accessing = image != nil
            return accessing
        }
        func endContentAccess() { accessing = false }
        func discardContentIfPossible() { image = nil }
        func isContentDiscarded() -> Bool { image == nil }
    }

    private let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    /// Where fetched pictures are kept across launches; nil keeps them in memory only.
    private let disk: ImageDiskCache?
    /// The open instance, whose folder on disk is read and written; nil when none is open.
    private var instance: String?
    /// The largest picture kept on disk, in bytes; thumbnails are 5–30 KB.
    nonisolated static let diskLimit = 1024 * 1024
    /// Pictures written since the disk was last trimmed.
    private var writes = 0

    init(disk: ImageDiskCache? = nil) {
        self.disk = disk
    }

    /// The open workspace's: keys carry it, so a picture loaded for one
    /// instance or account never shows in another.
    private var scope = UUID()

    /// The key for a path in the open workspace. Taken before a load starts,
    /// so a load that ends after a switch lands under the old scope.
    func key(_ path: String) -> String { "\(scope.uuidString)|\(path)" }

    /// A workspace opened or closed: nothing in memory carries over. When an
    /// instance opens, only its pictures stay on disk; closing one, as a
    /// session renewal does before reopening it, keeps them. Sign-out removes
    /// them all (`AppModel.forgetAccountData`).
    func reset(instance: String? = nil) {
        scope = UUID()
        cache.removeAllObjects()
        self.instance = instance
        if let disk, let instance {
            Task.detached(priority: .utility) {
                disk.removeAll(except: instance)
                disk.trim()
            }
        }
    }

    func image(_ path: String) -> CGImage? {
        cache.object(forKey: path as NSString)?.image
    }

    func store(_ image: CGImage, for path: String) {
        cache.setObject(Box(image), forKey: path as NSString, cost: image.bytesPerRow * image.height)
    }

    /// The picture `name` names, at most `maxPixel` on its longer side: from
    /// memory, else from disk, else fetched. A fetched one is kept in memory,
    /// and on disk too when `onDisk`: only for `/api/assets/` files, which
    /// never change at their name. A project file can be rewritten at its
    /// path, so it stays in memory only.
    /// Throws `APIError.decoding` for bytes that are not a picture.
    func load(_ name: String, maxPixel: CGFloat, onDisk: Bool, fetch: () async throws -> Data) async throws -> CGImage {
        let key = key(name)
        if let image = image(key) { return image }
        let instance = onDisk ? instance : nil
        let scope = scope
        if let disk, let instance, let data = disk.data(instance: instance, key: name),
           let image = await Self.decode(data, maxPixel: maxPixel) {
            store(image, for: key)
            return image
        }
        let data = try await fetch()
        guard let image = await Self.decode(data, maxPixel: maxPixel) else { throw APIError.decoding }
        store(image, for: key)
        // Only while the same workspace is open: after a switch or sign-out,
        // even back to the same instance, nothing writes the old load back.
        // Only thumbnails: the server returns a GIF or HEIC as its original.
        if let disk, let instance, scope == self.scope, data.count <= Self.diskLimit {
            disk.store(data, instance: instance, key: name)
            writes += 1
            if writes >= 20 {
                writes = 0
                Task.detached(priority: .utility) { disk.trim() }
            }
        }
        return image
    }

    /// Decoded small and off the main actor: a picture from the web may be huge.
    private nonisolated static func decode(_ data: Data, maxPixel: CGFloat) async -> CGImage? {
        await Task.detached(priority: .userInitiated) {
            ImageCompressor.thumbnail(from: data, maxPixel: maxPixel)
        }.value
    }
}
