import Foundation
import Testing
import UIKit
@testable import Rome

@Suite @MainActor struct ImageDiskCacheTests {
    private func cache(limit: Int = 20 * 1024 * 1024) -> ImageDiskCache {
        var cache = ImageDiskCache(root: FileManager.default.temporaryDirectory.appending(path: "rome-images-\(UUID().uuidString)", directoryHint: .isDirectory))
        cache.limit = limit
        return cache
    }

    private func png(_ color: UIColor) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            color.setFill(); context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }.pngData()!
    }

    @Test func missThenHitPerInstance() {
        let cache = cache()
        defer { cache.removeAll() }
        #expect(cache.entry(instance: "me.romeos.cc", key: "app-icon-habits") == nil)
        let stamp = ImageDiskCache.Stamp(version: "1.0.0", hash: "abc")
        cache.store(png(.red), stamp: stamp, instance: "me.romeos.cc", key: "app-icon-habits")
        #expect(cache.entry(instance: "me.romeos.cc", key: "app-icon-habits")?.stamp == stamp)
        // Another instance never sees it.
        #expect(cache.entry(instance: "team.romeos.cc", key: "app-icon-habits") == nil)
        #expect(CachedImage.cached(instance: "me.romeos.cc", key: "app-icon-habits", cache: cache) != nil)
    }

    /// The stored image is replaced only when the source's version or bytes changed.
    @Test func refreshSwapsOnlyOnChange() async {
        let cache = cache()
        defer { cache.removeAll() }
        var draws = 0
        let draw: (Data) async -> UIImage? = { _ in draws += 1; return UIImage(data: self.png(.blue)) }
        let source = Data("<svg>1</svg>".utf8)
        let first = await CachedImage.refresh(instance: "i", key: "k", version: "1", cache: cache, fetch: { source }, draw: draw)
        #expect(first != nil)
        let same = await CachedImage.refresh(instance: "i", key: "k", version: "1", cache: cache, fetch: { source }, draw: draw)
        #expect(same == nil)
        #expect(draws == 1)
        let newVersion = await CachedImage.refresh(instance: "i", key: "k", version: "2", cache: cache, fetch: { source }, draw: draw)
        #expect(newVersion != nil)
        let newBytes = await CachedImage.refresh(instance: "i", key: "k", version: "2", cache: cache, fetch: { Data("<svg>2</svg>".utf8) }, draw: draw)
        #expect(newBytes != nil)
        // A failed fetch keeps what is shown.
        struct Offline: Error {}
        let failed = await CachedImage.refresh(instance: "i", key: "k", version: "2", cache: cache, fetch: { throw Offline() }, draw: draw)
        #expect(failed == nil)
        #expect(cache.entry(instance: "i", key: "k")?.stamp.hash == ImageDiskCache.hash(Data("<svg>2</svg>".utf8)))
    }

    @Test func keysAreStable() {
        #expect(AppIcon.cacheKey(InstalledApp(id: "habits")) == "app-icon-habits")
        let url = URL(string: "https://lh3.example.com/a.png")!
        #expect(InitialAvatar.cacheKey(url) == InitialAvatar.cacheKey(url))
        #expect(InitialAvatar.cacheKey(url) != InitialAvatar.cacheKey(URL(string: "https://lh3.example.com/b.png")!))
        #expect(ImageDiskCache.hash(Data("a".utf8)) != ImageDiskCache.hash(Data("b".utf8)))
    }

    /// Past the limit, the oldest images go first.
    @Test func trimsOldestFirst() throws {
        let image = png(.green)
        let cache = cache(limit: image.count * 2)
        defer { cache.removeAll() }
        let stamp = ImageDiskCache.Stamp(version: nil, hash: "h")
        cache.store(image, stamp: stamp, instance: "i", key: "a")
        let old = cache.root.appending(path: "i").appending(path: "a.png")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -100)], ofItemAtPath: old.path(percentEncoded: false))
        cache.store(image, stamp: stamp, instance: "i", key: "b")
        cache.store(image, stamp: stamp, instance: "i", key: "c")
        #expect(cache.entry(instance: "i", key: "a") == nil)
        #expect(cache.entry(instance: "i", key: "c") != nil)
    }

    @Test func signOutClearsEverything() {
        let cache = cache()
        cache.store(png(.red), stamp: .init(version: nil, hash: "h"), instance: "i", key: "k")
        cache.removeAll()
        #expect(cache.entry(instance: "i", key: "k") == nil)
    }
}
