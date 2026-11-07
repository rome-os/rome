import Foundation
import ImageIO
import Testing
import UIKit
@testable import Rome

private func photo(width: CGFloat, height: CGFloat) -> UIImage {
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
        // Noise-free gradients compress well; stripes keep some detail.
        for x in stride(from: 0, to: Int(width), by: 8) {
            UIColor(hue: CGFloat(x % 360) / 360, saturation: 0.6, brightness: 0.9, alpha: 1).setFill()
            context.fill(CGRect(x: CGFloat(x), y: 0, width: 8, height: height))
        }
    }
}

private func pixelSize(_ data: Data) -> CGSize? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
          let height = properties[kCGImagePropertyPixelHeight] as? CGFloat
    else { return nil }
    return CGSize(width: width, height: height)
}

@Suite struct ImageCompressorTests {
    @Test func aLargePhotoShrinksToTheLongEdgeAsJPEG() throws {
        let jpeg = try #require(ImageCompressor.jpeg(from: photo(width: 4032, height: 3024)))
        let size = try #require(pixelSize(jpeg))
        #expect(max(size.width, size.height) == 2048)
        #expect(abs(size.width / size.height - 4032.0 / 3024.0) < 0.01)
        #expect(jpeg.count <= ImageCompressor.maxBytes)
        // JPEG files start with FF D8.
        #expect(jpeg.prefix(2) == Data([0xFF, 0xD8]))
    }

    @Test func aSmallPhotoKeepsItsSize() throws {
        let jpeg = try #require(ImageCompressor.jpeg(from: photo(width: 800, height: 600)))
        #expect(pixelSize(jpeg) == CGSize(width: 800, height: 600))
    }

    @Test func aTightBudgetLowersTheQuality() throws {
        let image = photo(width: 2000, height: 2000)
        let roomy = try #require(ImageCompressor.jpeg(from: image))
        let tight = try #require(ImageCompressor.jpeg(from: image, maxBytes: roomy.count / 3))
        #expect(tight.count < roomy.count)
    }
}

@MainActor
@Suite struct ComposerAttachmentTests {
    private func png() -> Data { photo(width: 300, height: 200).pngData()! }

    @Test func addsUpToFourAndRemoves() async {
        let attachments = ComposerAttachments()
        let taken = await attachments.add(data: Array(repeating: png(), count: 6))
        #expect(taken == 4)
        #expect(attachments.images.count == 4)
        #expect(attachments.isFull)
        #expect(await attachments.add(images: [photo(width: 10, height: 10)]) == 0)
        attachments.remove(attachments.images[1].id)
        #expect(attachments.images.count == 3)
        #expect(attachments.remaining == 1)
    }

    @Test func takeHandsOverTheJPEGsAndEmpties() async {
        let attachments = ComposerAttachments()
        await attachments.add(data: [png(), png()])
        let photos = attachments.take()
        #expect(photos.count == 2)
        #expect(photos.allSatisfy { $0.jpeg.prefix(2) == Data([0xFF, 0xD8]) })
        // The thumbnail is made once, small.
        #expect(photos.allSatisfy { ($0.thumbnail?.width ?? 0) <= Int(ComposerImage.thumbnailPixels) })
        #expect(attachments.images.isEmpty)
    }

    @Test func pastedImagesBecomeAttachments() async {
        let pasteboard = UIPasteboard(name: UIPasteboard.Name("rome-test-\(UUID())"), create: true)!
        pasteboard.images = [photo(width: 120, height: 80), photo(width: 80, height: 120)]
        let attachments = ComposerAttachments()
        let field = PastingTextView()
        field.pasteboard = pasteboard
        var pasted: [NSItemProvider] = []
        field.onPasteImages = { pasted = $0 }
        #expect(field.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
        field.paste(nil)
        #expect(pasted.count == 2)
        #expect(await attachments.add(providers: pasted) == 2)
        #expect(attachments.images.count == 2)
        UIPasteboard.remove(withName: pasteboard.name)
    }

    @Test func pastedTextStillLandsInTheField() {
        let pasteboard = UIPasteboard(name: UIPasteboard.Name("rome-test-\(UUID())"), create: true)!
        pasteboard.string = "hello"
        let field = PastingTextView()
        field.pasteboard = pasteboard
        var pasted = false
        field.onPasteImages = { _ in pasted = true }
        field.paste(nil)
        #expect(!pasted)
        UIPasteboard.remove(withName: pasteboard.name)
    }
}

@MainActor
@Suite struct PhotoSendTests {
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func photosGoWithTheTextInOneTurn() async throws {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        let jpegs = [Data([0xFF, 0xD8, 1]), Data([0xFF, 0xD8, 2])]
        #expect(store.send("Look at these", images: jpegs.map { ComposerImage(jpeg: $0) }))
        await settle()
        #expect(backend.calls == ["send concierge Look at these [2 files]"])
        #expect(backend.sentFiles == [
            OutgoingFile(name: "photo-1.jpg", mimeType: "image/jpeg", dataBase64: jpegs[0].base64EncodedString()),
            OutgoingFile(name: "photo-2.jpg", mimeType: "image/jpeg", dataBase64: jpegs[1].base64EncodedString()),
        ])
    }

    @Test func photosAloneAreAMessage() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        #expect(store.send("   ", images: [ComposerImage(jpeg: Data([0xFF, 0xD8]))]))
        await settle()
        #expect(backend.calls == ["send concierge  [1 files]"])
        // Nothing at all is not.
        #expect(!store.send("  ", images: []))
    }

    @Test func thePendingBubbleShowsThePhotos() {
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: FakeBackend())
        let photo = ComposerImage(jpeg: Data([0xFF, 0xD8]))
        store.send("Hi", images: [photo])
        // The typing dots follow it, so look for the bubble itself.
        let bubble = store.rows.compactMap { row -> (String, [UserImage])? in
            if case .userText(_, let text, let images, .some(.sending)) = row { return (text, images) }
            return nil
        }.first
        #expect(bubble?.0 == "Hi")
        #expect(bubble?.1 == [.local(photo)])
    }
}

@MainActor
@Suite struct PhotoSlotTests {
    @Test func reservedSlotsHoldSendAndThePlus() async {
        let attachments = ComposerAttachments()
        #expect(attachments.reserve(6) == 4)
        #expect(attachments.isPreparing && attachments.isFull)
        let png = photo(width: 50, height: 50).pngData()!
        await attachments.fill(reserved: 4, data: [png, png])
        // Two loaded, two failed: all slots are given back.
        #expect(!attachments.isPreparing)
        #expect(attachments.images.count == 2)
        #expect(attachments.remaining == 2)
    }

    @Test func aPhotoIsTheSameByIdNotByBytes() {
        let a = ComposerImage(jpeg: Data([1]))
        #expect(a == ComposerImage(id: a.id, jpeg: Data([2])))
        #expect(a != ComposerImage(jpeg: Data([1])))
    }
}

@Suite struct AssetQueryTests {
    @Test func plusAmpersandAndEqualsAreEncoded() {
        #expect(APIClient.strictQueryValue("projects/a/C++ & x=1.png") == "projects/a/C%2B%2B%20%26%20x%3D1.png")
    }

    @Test func chineseNamesAreEncoded() {
        #expect(APIClient.strictQueryValue("projects/图.png") == "projects/%E5%9B%BE.png")
    }
}

@Suite struct UploadLineTests {
    @Test func onlyLinksUnderProjectsCount() {
        let message = "See\n\n- File 1: [x.png](</etc/x.png>)"
        #expect(UploadLines.split(message).uploads.isEmpty)
    }

    @Test func theListMustFollowABlankLine() {
        let message = "My notes\n- File 1: [x.png](</projects/a/x.png>)"
        #expect(UploadLines.split(message).uploads.isEmpty)
        #expect(UploadLines.split(message).text == message)
    }

    @Test func splitsTheServersFileLinesOffTheText() {
        let stored = "Look at this\n\n- File 1: [photo-1.jpg](</projects/chats/2026/11/07/photo-1.jpg>)\n- File 2: [photo-2.jpg](</projects/chats/2026/11/07/photo-2.jpg>)"
        let (text, uploads) = UploadLines.split(stored)
        #expect(text == "Look at this")
        #expect(uploads.map(\.name) == ["photo-1.jpg", "photo-2.jpg"])
        #expect(uploads[0].assetPath == "projects/chats/2026/11/07/photo-1.jpg")
        #expect(uploads[0].isImage)
    }

    @Test func photosAloneLeaveNoText() {
        let (text, uploads) = UploadLines.split("- File 1: [photo-1.jpg](</projects/a/photo-1.jpg>)")
        #expect(text.isEmpty)
        #expect(uploads.count == 1)
    }

    @Test func ordinaryTextIsLeftAlone() {
        let message = "Here is a list:\n- one\n- two"
        #expect(UploadLines.split(message).text == message)
        #expect(UploadLines.split(message).uploads.isEmpty)
    }

    @Test func aDocumentIsNotAPhoto() {
        let (_, uploads) = UploadLines.split("- File 1: [notes.pdf](</projects/a/notes.pdf>)")
        #expect(uploads.first?.isImage == false)
    }

    @Test func encodedPathsAreDecodedForTheAssetRoute() {
        let (_, uploads) = UploadLines.split("- File 1: [my photo.jpg](</projects/a/my%20photo.jpg>)")
        #expect(uploads.first?.assetPath == "projects/a/my photo.jpg")
    }
}
