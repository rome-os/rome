import Foundation
import Testing
@testable import Rome

@Suite struct ImageSourceTests {
    @Test func projectsAndMemoryFilesUseTheInstance() {
        #expect(ImageSource(src: "/projects/demo/a b.png") == .asset(path: "projects/demo/a b.png"))
        #expect(ImageSource(src: "/projects/demo/a%20b.png?x=1#y") == .asset(path: "projects/demo/a b.png"))
        #expect(ImageSource(src: "/memory/notes/plan.jpg") == .asset(path: "memory/notes/plan.jpg"))
    }

    @Test func publicHttpsImagesLoadWithoutTheSession() {
        #expect(ImageSource(src: "https://example.com/cat.png") == .external(URL(string: "https://example.com/cat.png")!))
    }

    @Test func everythingElseIsRejected() {
        for src in ["http://example.com/cat.png", "data:image/png;base64,AAAA", "cat.png", "//evil.example/x.png",
                    "/api/projects/asset?path=x", "/projects/", "/projects/../etc/passwd", "/projects/a/./b.png",
                    "/projects/a%2Fb.png", "javascript:alert(1)"] {
            #expect(ImageSource(src: src) == .rejected, "\(src)")
        }
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
