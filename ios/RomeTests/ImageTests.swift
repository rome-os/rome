import Foundation
import UIKit
import Testing
@testable import Rome

@Suite struct ImageSourceTests {
    @Test func projectsAndMemoryFilesUseTheInstance() {
        #expect(ImageSource(src: "/projects/demo/a b.png") == .asset(path: "projects/demo/a b.png"))
        #expect(ImageSource(src: "/projects/demo/a%20b.png?x=1#y") == .asset(path: "projects/demo/a b.png"))
        #expect(ImageSource(src: "/memory/notes/plan.jpg") == .asset(path: "memory/notes/plan.jpg"))
    }

    @Test func aThumbnailWidthIsAskedForOnlyOnTheInstancesAssetRoutes() {
        let query = "path=projects%2Fa.png"
        #expect(ImageFetch.assetQuery(query, path: "/projects/asset/a.png", width: 900) == "path=projects%2Fa.png&w=900")
        #expect(ImageFetch.assetQuery(query, path: "/memory/asset/a.png", width: 600) == "path=projects%2Fa.png&w=600")
        #expect(ImageFetch.assetQuery(query, path: "/projects/asset/a.png", width: nil) == query)
        #expect(ImageFetch.assetQuery("path=a.png&w=600", path: "/projects/asset/a.png", width: 900) == "path=a.png&w=600")
        #expect(ImageFetch.assetQuery(query, path: "/projects/assets/a.png", width: 900) == query)
        #expect(ImageFetch.assetQuery(query, path: "/share/t/projects/asset/a.png", width: 900) == query)
        #expect(ImageFetch.assetQuery(nil, path: "/projects/asset/a.png", width: 900) == nil)
        // A stored upload's URL has no query, so the width is the whole query.
        #expect(ImageFetch.assetQuery(nil, path: "/assets/0123456789abcdef0123456789abcdef.png", width: 600) == "w=600")
        #expect(ImageFetch.assetQuery(nil, path: "/assets/0123456789abcdef0123456789abcdef.png", width: nil) == nil)
        #expect(ImageFetch.assetQuery("w=900", path: "/assets/0123456789abcdef0123456789abcdef.png", width: 600) == "w=900")
    }

    @Test func publicHttpsImagesLoadWithoutTheSession() {
        #expect(ImageSource(src: "https://example.com/cat.png") == .external(URL(string: "https://example.com/cat.png")!))
    }

    @Test func everythingElseIsRejected() {
        for src in ["http://example.com/cat.png", "data:image/png;base64,AAAA", "cat.png", "//evil.example/x.png",
                    "/projects/", "/projects/../etc/passwd", "/projects/a/./b.png",
                    "/projects/a%2Fb.png", "javascript:alert(1)", "/desktop",
                    "/api/", "/api/../etc/passwd", "/api/projects/%2E%2E/x.png", "/api/a%zz.png", "/api/a.png?path=%"] {
            #expect(ImageSource(src: src, origin: origin) == .rejected, "\(src)")
        }
    }

    private let origin = URL(string: "https://me.romeos.cc")!

    /// The reply that showed only its alt text on a phone.
    @Test func anAssetURLLoadsAsWritten() {
        let src = "/api/projects/asset/photo-1.jpg?path=projects%2Fdefault%2F2026%2F11%2F07%2Fphoto-1.jpg"
        let source = ImageSource(src: src, origin: origin)
        #expect(source == .instance(path: "/projects/asset/photo-1.jpg", query: "path=projects%2Fdefault%2F2026%2F11%2F07%2Fphoto-1.jpg"))
        #expect(APIClient.fileURL(origin: origin, apiPath: "/projects/asset/photo-1.jpg", percentEncodedQuery: "path=projects%2Fdefault%2F2026%2F11%2F07%2Fphoto-1.jpg")?.absoluteString
            == "https://me.romeos.cc\(src)")
    }

    @Test func otherAssetAndAPIURLsLoadThroughTheInstance() {
        #expect(ImageSource(src: "/api/projects/asset?path=projects%2Fa.png") == .instance(path: "/projects/asset", query: "path=projects%2Fa.png"))
        #expect(ImageSource(src: "/api/memory/asset/b.png?path=memory%2Fb.png") == .instance(path: "/memory/asset/b.png", query: "path=memory%2Fb.png"))
        #expect(ImageSource(src: "/api/charts/usage.png") == .instance(path: "/charts/usage.png", query: nil))
        // What a URL cannot carry is encoded; escapes already there stay.
        #expect(ImageSource(src: "/api/projects/asset/a b.png?path=projects/a b.png&x=%2F") == .instance(path: "/projects/asset/a%20b.png", query: "path=projects/a%20b.png&x=%2F"))
    }

    @Test func theInstancesOwnAbsoluteURLsAreInternal() {
        #expect(ImageSource(src: "https://me.romeos.cc/projects/demo/a%20b.png", origin: origin) == .asset(path: "projects/demo/a b.png"))
        #expect(ImageSource(src: "https://ME.romeos.cc:443/memory/n.png", origin: origin) == .asset(path: "memory/n.png"))
        #expect(ImageSource(src: "https://me.romeos.cc/api/projects/asset/a.png?path=projects%2Fa.png#top", origin: origin)
            == .instance(path: "/projects/asset/a.png", query: "path=projects%2Fa.png"))
        let local = URL(string: "http://127.0.0.1:3000")!
        #expect(ImageSource(src: "http://127.0.0.1:3000/projects/a.png", origin: local) == .asset(path: "projects/a.png"))
    }

    /// Another origin never gets the session: at most a public fetch.
    @Test func anotherOriginIsNotInternal() {
        #expect(ImageSource(src: "https://other.romeos.cc/projects/a.png", origin: origin) == .external(URL(string: "https://other.romeos.cc/projects/a.png")!))
        #expect(ImageSource(src: "https://me.romeos.cc:8443/projects/a.png", origin: origin) == .external(URL(string: "https://me.romeos.cc:8443/projects/a.png")!))
        #expect(ImageSource(src: "http://me.romeos.cc/projects/a.png", origin: origin) == .rejected)
        #expect(ImageSource(src: "https://me.romeos.cc/projects/a.png") == .external(URL(string: "https://me.romeos.cc/projects/a.png")!))
        #expect(APIClient.fileURL(origin: origin, apiPath: "//evil.example/x.png", percentEncodedQuery: nil)?.host() == "me.romeos.cc")
    }

    @Test func aPathWithoutItsSlashIsStillAFile() {
        #expect(ImageSource(src: "projects/demo/a.png") == .asset(path: "projects/demo/a.png"))
        #expect(ImageSource(src: "memory/notes/b.jpg") == .asset(path: "memory/notes/b.jpg"))
    }

    @Test func assetPathsAreStrictlyEncodedOnTheWire() {
        #expect(APIClient.strictQueryValue("memory/C++ notes.png") == "memory/C%2B%2B%20notes.png")
    }
}

@Suite struct MarkdownImageTests {
    @Test func findsImagesAmongText() {
        let blocks = MarkdownParser.parse("Here it is:\n![Hotel](/projects/trip/hotel.jpg)\nWhat do you think?")
        #expect(blocks == [
            .paragraph("Here it is:"),
            .image(alt: "Hotel", src: "/projects/trip/hotel.jpg"),
            .paragraph("What do you think?"),
        ])
    }

    @Test func severalImagesAndTitles() {
        let blocks = MarkdownParser.parse("![a](https://x.example/a.png \"A\") and ![b](/memory/b.png)")
        #expect(blocks == [
            .image(alt: "a", src: "https://x.example/a.png"),
            .paragraph("and"),
            .image(alt: "b", src: "/memory/b.png"),
        ])
    }

    @Test func aPlainLinkToAnImageStaysALink() {
        let blocks = MarkdownParser.parse("See [the photo](/projects/a.png).")
        #expect(blocks == [.paragraph("See [the photo](/projects/a.png).")])
    }

    @Test func codeIsLeftAlone() {
        let blocks = MarkdownParser.parse("```\n![x](/projects/a.png)\n```")
        #expect(blocks == [.code(language: nil, text: "![x](/projects/a.png)")])
    }
}

@Suite struct PictureSetTests {
    private func item(_ alt: String, _ src: String, _ note: String = "") -> PictureItem {
        PictureItem(alt: alt, src: src, note: note)
    }

    @Test func aGridHoldsOnePictureAndItsNotePerLine() {
        let blocks = MarkdownParser.parse("""
        ```pictures grid
        ![Oʻahu](https://upload.wikimedia.org/a/960px-x.jpg) Waikiki and Diamond Head, good for a first trip
        ![Maui](/projects/demo/maui.png) Palm trees, beaches and resorts
        ![Hawaiʻi](/memory/pictures/hawaii.png)
        ```
        """)
        #expect(blocks == [
            .pictures(layout: .grid, items: [
                item("Oʻahu", "https://upload.wikimedia.org/a/960px-x.jpg", "Waikiki and Diamond Head, good for a first trip"),
                item("Maui", "/projects/demo/maui.png", "Palm trees, beaches and resorts"),
                item("Hawaiʻi", "/memory/pictures/hawaii.png"),
            ]),
        ])
    }

    @Test func aBareFenceIsAGridAndListNamesTheList() {
        let line = "![A](https://example.com/a.jpg) one"
        #expect(MarkdownParser.parse("```pictures\n\(line)\n```") == [.pictures(layout: .grid, items: [item("A", "https://example.com/a.jpg", "one")])])
        #expect(MarkdownParser.parse("```pictures list\n\(line)\n```") == [.pictures(layout: .list, items: [item("A", "https://example.com/a.jpg", "one")])])
        #expect(MarkdownParser.parse("``` pictures   list \n\(line)\n```") == [.pictures(layout: .list, items: [item("A", "https://example.com/a.jpg", "one")])])
        #expect(MarkdownParser.parse("```pictures carousel\n\(line)\n```") == [.pictures(layout: .grid, items: [item("A", "https://example.com/a.jpg", "one")])])
    }

    @Test func linesThatAreNotPicturesAreSkipped() {
        let blocks = MarkdownParser.parse("""
        ```pictures
        Some words
        ![A](https://example.com/a.jpg) first
        - ![B](https://example.com/b.jpg) a bullet
        ![C](https://example.com/c.jpg
        ![D](https://example.com/d.jpg \"Caption\") fourth
        ```
        """)
        #expect(blocks == [
            .pictures(layout: .grid, items: [
                item("A", "https://example.com/a.jpg", "first"),
                item("D", "https://example.com/d.jpg", "fourth"),
            ]),
        ])
    }

    @Test func unsafeAddressesAreDropped() {
        let blocks = MarkdownParser.parse("""
        ```pictures
        ![A](javascript:alert(1)) x
        ![B](data:image/png;base64,AAAA) y
        ![C](http://example.com/c.jpg) z
        ![D](https://example.com/d.jpg) kept
        ```
        """)
        #expect(blocks == [.pictures(layout: .grid, items: [item("D", "https://example.com/d.jpg", "kept")])])
    }

    @Test func aFenceWithNoSafePictureStaysCode() {
        #expect(MarkdownParser.parse("```pictures grid\nnot a picture\n```") == [.code(language: "pictures grid", text: "not a picture")])
        #expect(MarkdownParser.parse("```pictures\n![A](http://example.com/a.jpg)\n```") == [.code(language: "pictures", text: "![A](http://example.com/a.jpg)")])
        #expect(MarkdownParser.parse("```pictures\n```") == [.code(language: "pictures", text: "")])
    }

    @Test func aFenceOfAnotherKindStaysCode() {
        #expect(MarkdownParser.parse("```swift\n![A](https://example.com/a.jpg)\n```") == [.code(language: "swift", text: "![A](https://example.com/a.jpg)")])
        #expect(MarkdownParser.parse("```picturesque\n![A](https://example.com/a.jpg)\n```") == [.code(language: "picturesque", text: "![A](https://example.com/a.jpg)")])
    }

    @Test func aFenceStillOpenWaitsForItsLastLine() {
        let first = "![A](https://example.com/a.jpg) one"
        let second = "![B](https://example.com/b.jpg) two"
        // The text ends partway through the second line.
        #expect(MarkdownParser.parse("```pictures\n\(first)\n![B](https://example.com/b.jpg) tw") == [.pictures(layout: .grid, items: [item("A", "https://example.com/a.jpg", "one")])])
        // Its newline has arrived, so the line counts.
        #expect(MarkdownParser.parse("```pictures\n\(first)\n\(second)\n") == [
            .pictures(layout: .grid, items: [item("A", "https://example.com/a.jpg", "one"), item("B", "https://example.com/b.jpg", "two")]),
        ])
        // A first line still being written leaves the fence as code.
        #expect(MarkdownParser.parse("```pictures\n![A](https://example.com/a.jpg) on") == [.code(language: "pictures", text: "![A](https://example.com/a.jpg) on")])
    }

    @Test func balancedParenthesesStayInAnAddress() {
        let fuji = "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Mount_Fuji_(Japan).jpg/960px-Mount_Fuji_(Japan).jpg"
        let middle = "https://example.com/photo_(1).jpg"
        let blocks = MarkdownParser.parse("```pictures\n![Fuji](\(fuji)) Spring\n![One](\(middle))\n```")
        #expect(blocks == [.pictures(layout: .grid, items: [item("Fuji", fuji, "Spring"), item("One", middle)])])
    }

    @Test func anEscapedLabelIsShownUnescaped() {
        let blocks = MarkdownParser.parse(#"""
        ```pictures
        ![photo \[1\].png](https://example.com/a.png) Beach
        ![a \\ b \x](https://example.com/b.png)
        ```
        """#)
        #expect(blocks == [.pictures(layout: .grid, items: [item("photo [1].png", "https://example.com/a.png", "Beach"), item(#"a \ b \x"#, "https://example.com/b.png")])])
    }

    @Test func textAfterTheImagesParenthesisStaysTheNote() {
        let blocks = MarkdownParser.parse("```pictures\n![a](https://example.com/b.jpg) (c)\n![d](https://example.com/e.jpg)(f)\n```")
        #expect(blocks == [.pictures(layout: .grid, items: [item("a", "https://example.com/b.jpg", "(c)"), item("d", "https://example.com/e.jpg", "(f)")])])
    }

    @Test func anUnsafeAddressWithParenthesesIsStillSkipped() {
        #expect(MarkdownParser.parse("```pictures\n![b](http://example.com/b_(1).jpg)\n```") == [.code(language: "pictures", text: "![b](http://example.com/b_(1).jpg)")])
    }

    @Test func textAroundASetStaysAsBlocks() {
        let blocks = MarkdownParser.parse("Here:\n\n```pictures\n![A](https://example.com/a.jpg)\n```\n\nWhich one?")
        #expect(blocks == [
            .paragraph("Here:"),
            .pictures(layout: .grid, items: [item("A", "https://example.com/a.jpg")]),
            .paragraph("Which one?"),
        ])
    }

    @Test func aTileLabelsAnOutsideHostWithoutWWW() {
        #expect(PictureTile.hostLabel("www.example.com") == "example.com")
        #expect(PictureTile.hostLabel("upload.wikimedia.org") == "upload.wikimedia.org")
    }

    @Test func aTileAsksForAThumbnailOfTheInstancesOwnPictures() {
        #expect(PictureTile.pixels == 600)
        #expect(ImageFetch.assetQuery("path=projects%2Fa.png", path: "/projects/asset/a.png", width: Int(PictureTile.pixels)) == "path=projects%2Fa.png&w=600")
    }
}

/// Records what the client sent and answers with a few bytes.
final class RecordingProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var urls: [String] = []
    nonisolated(unsafe) static var cookies: [String?] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.urls.append(request.url!.absoluteString)
        Self.cookies.append(request.value(forHTTPHeaderField: "Cookie"))
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data([0xFF, 0xD8]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
@Suite(.serialized) struct InstanceImageWireTests {
    @Test func anAssetURLGoesOutUnchangedWithTheSession() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingProtocol.self]
        RecordingProtocol.urls = []
        RecordingProtocol.cookies = []
        let backend = LiveBackend(client: APIClient(origin: URL(string: "https://me.romeos.cc")!, token: { "t" }, configuration: configuration))
        let src = "/api/projects/asset/photo-1.jpg?path=projects%2Fdefault%2F2026%2F11%2F07%2Fphoto-1.jpg"
        guard case .instance(let path, let query) = ImageSource(src: src, origin: backend.origin) else {
            Issue.record("not an instance URL")
            return
        }
        let data = try await backend.apiFile(path: path, query: query)
        #expect(data == Data([0xFF, 0xD8]))
        #expect(RecordingProtocol.urls == ["https://me.romeos.cc\(src)"])
        #expect(RecordingProtocol.cookies == ["rome_session=t"])
    }
}

/// Answers with a declared length past the image limit.
final class HugeProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg", "Content-Length": "30000000"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data([0xFF, 0xD8]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
@Suite struct ImageSafetyTests {
    @Test func anImagePastTwentyMegabytesIsNotLoaded() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HugeProtocol.self]
        let client = APIClient(origin: URL(string: "https://me.romeos.cc")!, token: { "t" }, configuration: configuration)
        await #expect(throws: APIError.tooLarge) {
            try await client.getFile(apiPath: "/projects/asset/big.jpg", percentEncodedQuery: "path=projects%2Fbig.jpg")
        }
    }

    /// Another instance or account never sees a picture cached for this one.
    @Test func theCacheIsScopedToTheWorkspace() {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { _ in }.cgImage!
        let cache = StoredImageCache()
        let before = cache.key("projects/a.png")
        cache.store(image, for: before)
        #expect(cache.image(before) != nil)
        cache.reset()
        let after = cache.key("projects/a.png")
        #expect(after != before)
        #expect(cache.image(after) == nil)
        #expect(cache.image(before) == nil)
    }

    @Test func theSameImageTwiceIsTwoPages() {
        let source = ImageSource(src: "/projects/a.png")
        let first = ViewerImage.markdown(source, alt: "", src: "/projects/a.png", position: 0)
        let second = ViewerImage.markdown(source, alt: "", src: "/projects/a.png", position: 2)
        #expect(first.id != second.id)
        #expect(second.matches(position: 2) && !first.matches(position: 2))
    }

    /// Shared as the file it is: the extension comes from the bytes.
    @Test func aSharedImageKeepsItsType() throws {
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { _ in }
        #expect(SharedFile.fileExtension(png) == "png")
        let shared = try #require(SharedFile.write(png, name: "Hotel / front"))
        #expect(shared.url.lastPathComponent == "Hotel   front.png")
        #expect(try Data(contentsOf: shared.url) == png)
    }
}
