import SwiftUI

/// A pushed page's top: a glass back button and a large title.
struct PageHeader: View {
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GlassCircleButton(accessibilityLabel: "返回", action: { dismiss() }) {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            Text(title)
                .font(.system(size: 34, weight: .bold))
                .tracking(-0.8)
                .padding(.horizontal, 20)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An inset group: a white rounded card with hairline rows.
struct SettingsGroup<Content: View>: View {
    var header: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header {
                Text(header)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.sub)
                    .padding(.horizontal, 20)
            }
            VStack(spacing: 0, content: content)
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
        }
    }
}

/// A row with a 30 pt icon tile, a label, and a trailing accessory.
struct SettingsRow<Trailing: View>: View {
    let systemImage: String
    let title: String
    var last = false
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 15))
                .foregroundStyle(Palette.fg)
                .frame(width: 30, height: 30)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            HStack {
                Text(title).font(.system(size: 17)).foregroundStyle(Palette.fg)
                Spacer(minLength: 8)
                trailing()
            }
            .frame(minHeight: 52)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 14)
        .contentShape(Rectangle())
    }
}

/// Board 3: account, AI tool usage, links, sign out.
struct SettingsScreen: View {
    let workspace: Workspace
    let onInstances: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var usage: AIToolsStatus?
    @State private var confirmSignOut = false
    @State private var showFeedback = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                PageHeader(title: "设置")
                accountCard
                    .padding(.horizontal, 16)
                    .padding(.top, -8)
                SettingsGroup(header: "AI 工具用量") {
                    UsageRow(name: "Claude", provider: usage?.claude, last: false)
                    UsageRow(name: "Codex", provider: usage?.codex, last: true)
                }
                .padding(.horizontal, 16)
                SettingsGroup(header: "其他") {
                    Button {
                        if let url = model.webURL { openURL(url) }
                    } label: {
                        SettingsRow(systemImage: "safari", title: "在 Web 上管理") {
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Palette.sub)
                        }
                    }
                    .buttonStyle(RowPressStyle())
                    Button { showFeedback = true } label: {
                        SettingsRow(systemImage: "bubble.left.and.text.bubble.right", title: "发送反馈") {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Palette.sub)
                        }
                    }
                    .buttonStyle(RowPressStyle())
                    SettingsRow(systemImage: "info.circle", title: "版本", last: true) {
                        Text(appVersion)
                            .font(.system(size: 17).monospacedDigit())
                            .foregroundStyle(Palette.sub)
                    }
                }
                .padding(.horizontal, 16)
                SettingsGroup {
                    Button { confirmSignOut = true } label: {
                        Text("退出登录")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Palette.destructive)
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                }
                .padding(.horizontal, 16)
                .padding(.top, 2)
            }
            .padding(.bottom, 32)
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        .task { usage = try? await workspace.backend.aiTools() }
        .confirmationDialog("退出后需要重新用 Rome Cloud 登录。", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) { Task { await model.signOut() } }
        }
        .sheet(isPresented: $showFeedback) {
            FeedbackSheet(backend: workspace.backend)
                .presentationDetents([.medium])
                .presentationBackground(Palette.sheet)
                .presentationCornerRadius(22)
        }
    }

    private var accountCard: some View {
        Button(action: onInstances) {
            HStack(spacing: 14) {
                InitialAvatar(text: workspace.accountLabel, size: 48)
                VStack(alignment: .leading, spacing: 1) {
                    Text(workspace.accountLabel)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Circle().fill(Palette.success).frame(width: 7, height: 7)
                        Text("\(workspace.instanceName) · \(workspace.host)").lineLimit(1)
                    }
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.sub)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.sub)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .softElevation(radius: Metrics.cardRadius)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityHint("切换实例")
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }
}

/// One AI subscription: how much of its tightest window is used, and when it resets.
struct UsageRow: View {
    let name: String
    let provider: AIToolsStatus.Provider?
    let last: Bool

    private var window: AIToolsStatus.Window? {
        let windows = [provider?.usage?.fiveHour, provider?.usage?.sevenDay].compactMap { $0 }
        return windows.max { ($0.usedPercent ?? 0) < ($1.usedPercent ?? 0) }
    }

    private var percent: Double { min(100, max(0, window?.usedPercent ?? 0)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(.system(size: 17, weight: .medium))
                Spacer()
                if provider?.loggedIn == true, window != nil {
                    Text("\(Int(percent.rounded()))%")
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .contentTransition(.numericText())
                }
            }
            if provider?.loggedIn == true {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Palette.fill)
                        Capsule()
                            .fill(percent >= 100 || provider?.quotaExhausted == true ? Palette.destructive : Palette.fg)
                            .frame(width: geometry.size.width * percent / 100)
                    }
                }
                .frame(height: 6)
                .accessibilityElement()
                .accessibilityLabel("\(name) 用量")
                .accessibilityValue("\(Int(percent))%")
                Text(resetText)
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.sub)
            } else {
                Text(provider == nil ? "正在读取…" : "未登录")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.sub)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 15)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Palette.hair).frame(height: 0.5) }
        }
        .animation(.spring(response: 0.5, dampingFraction: 0.85), value: percent)
    }

    private var resetText: String {
        guard let date = RomeDate.parse(window?.resetsAt) else {
            return window == nil ? "暂无用量数据" : "用量会自动重置"
        }
        let seconds = date.timeIntervalSinceNow
        if seconds <= 0 { return "即将重置" }
        if seconds < 3600 { return "\(max(1, Int(seconds / 60))) 分钟后重置" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时后重置" }
        return "\(Int(seconds / 86_400)) 天后重置"
    }
}

struct FeedbackSheet: View {
    let backend: RomeBackend
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var sent = false
    @State private var failed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("发送反馈").font(.system(size: 24, weight: .bold)).tracking(-0.6)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            if sent {
                VStack(spacing: 10) {
                    StatusGlyph(tone: .done, size: 36)
                    Text("已发送。谢谢。").font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity.combined(with: .scale(scale: 0.95)))
            } else {
                TextField("哪里好用，哪里不好用？", text: $text, axis: .vertical)
                    .font(.system(size: 16))
                    .lineLimit(5...10)
                    .focused($focused)
                    .padding(14)
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .hairline(radius: 16)
                if failed {
                    Text("没发出去，请再试一次。")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Palette.destructive)
                }
                Spacer()
                PrimaryButton(title: "发送", loading: sending, disabled: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    send()
                }
            }
        }
        .padding(20)
        .onAppear { focused = true }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: sent)
    }

    private func send() {
        sending = true
        failed = false
        Task {
            do {
                try await backend.sendFeedback(text.trimmingCharacters(in: .whitespacesAndNewlines))
                sent = true
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            } catch {
                failed = true
            }
            sending = false
        }
    }
}
