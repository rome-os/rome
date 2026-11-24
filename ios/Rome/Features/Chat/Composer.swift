import PhotosUI
import SwiftUI

/// The capsule composer: a growing text field and a round send button.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    /// Set when `placeholder` names something: a long name is shortened to fit.
    var named: NamedPlaceholder? = nil
    var stopVisible = false
    var stopping = false
    @Binding var focused: Bool
    /// Photos to send with the message; nil leaves out the +.
    var attachments: ComposerAttachments? = nil
    /// The instance's voice input; nil (demo data, previews) shows no control.
    var voiceInput: VoiceInputService? = nil
    /// The chat this field writes in, so voice input stopped by leaving it
    /// says why on return; nil keeps no such notice.
    var voiceKey: String? = nil
    /// Which field this is, for the voice input start's signpost. Chat and
    /// topic chats also offer a voice conversation; a task chat does not.
    var voiceField: VoiceInputField = .chat
    /// False while the field's chat is covered or hidden but still mounted
    /// (Chat under another section, a sheet, the drawer): listening stops.
    var onScreen = true
    /// False while the field writes in a thread or replies to one message. A
    /// voice conversation's turns go to the chat itself, where the thread
    /// would not show them, so none is offered then.
    var conversationHere = true
    let onSend: () -> Void
    var onStop: () -> Void = {}

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var multiline = false
    @State private var composerWidth: CGFloat = 300
    @State private var editorHeight: CGFloat?
    @State private var overflows = false
    @State private var voice = VoiceInputController()
    @State private var conversation = VoiceConversationController()
    @State private var textHandle = ComposerTextHandle()
    @State private var choosingPhotos = false
    @State private var takingPhoto = false
    @State private var picked: [PhotosPickerItem] = []
    /// The text without what an input method is still composing (pinyin).
    @State private var committedText = ""

    /// The + and Send sit on the text's last line, 36 pt tall.
    private var controlPadding: CGFloat {
        ComposerTextView.controlBottomPadding(height: 36, size: dynamicTypeSize)
    }

    private var hasPhotos: Bool { !(attachments?.images.isEmpty ?? true) }
    private var canSend: Bool {
        guard !(attachments?.isPreparing ?? false) else { return false }
        // Sending waits for the spoken words to land.
        guard !voice.active else { return false }
        // The voice conversation sends what is said; End shows in Send's place.
        guard !conversation.active else { return false }
        return !committedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos
    }

    private var usesRows: Bool {
        focused || multiline || text.contains("\n") || expanded || hasPhotos || voice.active || conversation.active || dynamicTypeSize.isAccessibilitySize
    }

    private var shapeAnimation: Animation? {
        reduceMotion ? nil : .smooth(duration: 0.32, extraBounce: 0)
    }

    private var compactWidth: CGFloat {
        composerWidth - compactGutter * 2 - leadingInset(rows: false) - trailingInset(rows: false)
    }

    private var compactGutter: CGFloat { composerWidth >= 340 ? 24 : 0 }
    private var showsExpansion: Bool { (overflows || expanded) && !voice.active && !conversation.active }

    /// Whether this field offers a voice conversation: Chat and topic chats,
    /// on an instance that offers one, outside a thread or a reply.
    private var offersConversation: Bool {
        Self.offersConversation(field: voiceField, chat: voiceKey, available: voiceInput?.conversationAvailable ?? false, here: conversationHere)
    }

    static func offersConversation(field: VoiceInputField, chat: String?, available: Bool, here: Bool) -> Bool {
        field != .taskChat && chat != nil && available && here
    }

    private func leadingInset(rows: Bool) -> CGFloat { rows || attachments == nil ? 18 : 51 }
    /// Send, and 44 pt more for each voice control beside it.
    private func trailingInset(rows: Bool) -> CGFloat {
        guard !rows else { return 18 }
        return 51 + ((voiceInput?.available ?? false) ? 44 : 0) + (offersConversation ? 44 : 0)
    }

    var body: some View {
        VStack(spacing: 8) {
            if conversation.active {
                VoiceConversationCapsule(state: conversation.state, muted: conversation.muted, level: conversation.level)
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .bottom)))
            }
            field
        }
        .animation(shapeAnimation, value: conversation.active)
    }

    /// The field itself: the notices, the photos, the text and its controls.
    private var field: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let notice = voice.notice {
                VoiceInputNotice(stop: notice)
                    .padding(.top, 10)
                    .padding(.horizontal, 18)
            } else if let stop = conversation.notice {
                VoiceConversationNotice(reason: stop)
                    .padding(.top, 10)
                    .padding(.horizontal, 18)
            }
            if let attachments, !attachments.images.isEmpty || attachments.preparing > 0 {
                ComposerThumbnails(attachments: attachments)
                    .padding(.top, 10)
                    .padding(.leading, 12)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            // One editor and one set of controls retain focus and move through the morph.
            ComposerTextView(
                text: $text,
                focused: $focused,
                placeholder: placeholder,
                named: named,
                onPasteImages: attachments.map { attachments in
                    { providers in Task { await attachments.add(providers: providers) } }
                },
                committedText: $committedText,
                handle: textHandle,
                editable: !voice.active,
                onReturn: returnSends,
                onEdit: {
                    voice.edited(service: voiceInput, chat: voiceKey)
                    conversation.edited()
                },
                expanded: expanded,
                compactWidth: compactWidth,
                onMeasure: { multiple, height, overflow in
                    var transaction = Transaction()
                    transaction.disablesAnimations = editorHeight == nil || !onScreen
                    withTransaction(transaction) {
                        if multiline != multiple { multiline = multiple }
                        if editorHeight == nil || abs((editorHeight ?? 0) - height) > 0.5 { editorHeight = height }
                        if overflows != overflow { overflows = overflow }
                        if !overflow { expanded = false }
                    }
                }
            )
            .frame(height: editorHeight)
            .padding(.leading, leadingInset(rows: usesRows))
            .padding(.trailing, trailingInset(rows: usesRows))
            .padding(.bottom, usesRows ? 44 : 0)
            .overlay(alignment: .bottomLeading) {
                if let attachments {
                    plusMenu(attachments)
                        .padding(.leading, 7)
                        .padding(.bottom, usesRows ? 7 : controlPadding)
                }
            }
            .overlay(alignment: .bottom) {
                if voice.state == .listening {
                    VoiceInputWaveform(meter: voice.meter)
                        .padding(.horizontal, 96)
                        .padding(.bottom, 7 + (36 - VoiceInputWaveform.height) / 2)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                HStack(spacing: 0) {
                    Button {
                        expanded.toggle()
                    } label: {
                        Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                            .romeFont(15, .medium)
                            .foregroundStyle(Palette.sub)
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel(expanded ? String(localized: "Collapse input") : String(localized: "Expand input"))
                    .accessibilityIdentifier("composer-expand")
                    .opacity(showsExpansion ? 1 : 0)
                    .frame(width: showsExpansion ? 44 : 0)
                    .clipped()
                    .allowsHitTesting(showsExpansion)
                    .accessibilityHidden(!showsExpansion)
                    HStack(spacing: 8) { controls }
                }
                .padding(.trailing, 7)
                .padding(.bottom, usesRows ? 7 : controlPadding)
            }
        }
        .frame(minHeight: ComposerTextView.minHeight)
        .onChange(of: text.isEmpty) { _, empty in if empty { expanded = false } }
        // Frosted glass: the transcript behind blurs out so the placeholder
        // reads. In light the glass alone barely parts from the page, so it
        // keeps an edge.
        .glassSurface(RoundedRectangle(cornerRadius: 25, style: .continuous), interactive: true, frost: Frost.composer)
        .overlay(RoundedRectangle(cornerRadius: 25, style: .continuous).strokeBorder(Palette.hair, lineWidth: 0.5))
        .shadow(color: Palette.softShadow, radius: 7, x: 0, y: 4)
        .padding(.horizontal, usesRows ? 0 : compactGutter)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { composerWidth = $0 }
        .animation(shapeAnimation, value: usesRows)
        .animation(shapeAnimation, value: showsExpansion)
        .animation(shapeAnimation, value: expanded)
        .animation(shapeAnimation, value: editorHeight)
        // The main Chat stays mounted under other sections, so it asks again on each return.
        .task(id: onScreen) { if onScreen { await voiceInput?.refresh() } }
        // A field mounted hidden, such as the main Chat under another section,
        // arrives when it shows.
        .onAppear { if onScreen { voice.arrive(service: voiceInput, chat: voiceKey) } }
        .onDisappear {
            voice.leave(service: voiceInput, chat: voiceKey)
            conversation.leave()
        }
        .onChange(of: voice.state) { voice.stateShown() }
        .onChange(of: onScreen) { _, now in
            if now {
                voice.arrive(service: voiceInput, chat: voiceKey)
            } else {
                voice.leave(service: voiceInput, chat: voiceKey)
                conversation.leave()
                expanded = false
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: canSend)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: stopVisible)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: attachments?.images.count)
        .photosPicker(
            isPresented: $choosingPhotos,
            selection: $picked,
            maxSelectionCount: max(1, attachments?.remaining ?? 1),
            matching: .images
        )
        .onChange(of: picked) { _, items in
            guard !items.isEmpty, let attachments else { return }
            picked = []
            // The slots are held before loading: a spinner shows, the + and
            // Send wait, and nothing picked is dropped.
            let taken = attachments.reserve(items.count)
            guard taken > 0 else { return }
            Task {
                var files: [Data] = []
                for item in items.prefix(taken) {
                    if let data = try? await item.loadTransferable(type: Data.self) { files.append(data) }
                }
                await attachments.fill(reserved: taken, data: files)
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                guard let attachments else { return }
                Task { await attachments.add(images: [image]) }
            }
            .ignoresSafeArea()
        }
    }

    /// Return on a hardware keyboard while listening: listening ends, and the
    /// message is sent once the last words are in. Shift-Return does nothing.
    private var returnSends: (() -> Void)? {
        guard voice.active else { return nil }
        return sendWhenHeard
    }

    private func sendWhenHeard() {
        voice.stopAndSend {
            guard !(attachments?.isPreparing ?? false),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos
            else { return }
            voice.edited(service: voiceInput, chat: voiceKey)
            conversation.edited()
            onSend()
        }
    }

    /// The voice controls, and Send or the turn's stop. During a voice
    /// conversation: mute and End alone.
    @ViewBuilder private var controls: some View {
        if conversation.active {
            Group {
                VoiceConversationMuteButton(muted: conversation.muted) { conversation.toggleMute() }
                VoiceConversationEndButton { conversation.end() }
            }
            .transition(.scale.combined(with: .opacity))
        } else {
            if let voiceInput, voiceInput.available {
                VoiceInputButton(state: voice.state) {
                    // A conversation's old notice would hide what listening says.
                    conversation.edited()
                    voice.toggle(service: voiceInput, chat: voiceKey, field: voiceField, text: $text, handle: textHandle)
                }
            }
            if offersConversation, !voice.active, let voiceInput, let voiceKey {
                VoiceConversationButton {
                    focused = false
                    // Listening's old notice would hide what the conversation says.
                    voice.edited(service: voiceInput, chat: voiceKey)
                    conversation.start(service: voiceInput, chat: voiceKey)
                }
                .transition(.scale.combined(with: .opacity))
            }
            sendOrStop
        }
    }

    /// Send, or the turn's stop while it runs.
    private var sendOrStop: some View {
        Group {
            // While listening, the field's stop is the voice control's.
            if stopVisible && !canSend && !voice.active {
                Button(action: onStop) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Palette.bg)
                        .frame(width: 12, height: 12)
                        .frame(width: 36, height: 36)
                        .background(Palette.fg, in: Circle())
                        .opacity(stopping ? 0.5 : 1)
                }
                .disabled(stopping)
                .accessibilityLabel("Stop")
                .transition(.scale.combined(with: .opacity))
            } else {
                Button {
                    voice.edited(service: voiceInput, chat: voiceKey)
                    conversation.edited()
                    onSend()
                } label: {
                    Image(systemName: "arrow.up")
                        .romeFont(16, .bold)
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Palette.primary, in: Circle())
                        .opacity(canSend ? 1 : 0.35)
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("send")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
    }

    private func plusMenu(_ attachments: ComposerAttachments) -> some View {
        Menu {
            Button {
                takingPhoto = true
            } label: {
                Label("Take photo", systemImage: "camera")
            }
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            Button {
                choosingPhotos = true
            } label: {
                Label("Choose from library", systemImage: "photo.on.rectangle")
            }
        } label: {
            Image(systemName: "plus")
                .romeFont(17, .medium)
                .foregroundStyle(attachments.isFull ? Palette.sub.opacity(0.5) : Palette.sub)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        // The camera would cover the voice controls while they listen.
        .disabled(attachments.isFull || voice.active || conversation.active)
        .accessibilityLabel("Add photos")
    }
}

/// The photos waiting in the composer, each with an ×.
private struct ComposerThumbnails: View {
    let attachments: ComposerAttachments

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments.images) { image in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let thumbnail = image.thumbnail {
                                Image(decorative: thumbnail, scale: 1).resizable().scaledToFill()
                            } else {
                                Palette.fill
                            }
                        }
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("Photo")
                        Button {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { attachments.remove(image.id) }
                        } label: {
                            Image(systemName: "xmark")
                                .romeFont(9, .bold)
                                .foregroundStyle(.white)
                                .frame(width: 20, height: 20)
                                .background(.black.opacity(0.6), in: Circle())
                                .frame(width: 32, height: 32)
                                .contentShape(Rectangle())
                        }
                        .offset(x: 8, y: -8)
                        .accessibilityLabel("Remove photo")
                    }
                    .transition(.scale.combined(with: .opacity))
                }
                ForEach(0..<attachments.preparing, id: \.self) { _ in
                    Palette.fill
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay { Spinner(size: 14, color: Palette.sub) }
                }
            }
            .padding(.top, 8)
            .padding(.trailing, 12)
        }
        .scrollIndicators(.hidden)
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
