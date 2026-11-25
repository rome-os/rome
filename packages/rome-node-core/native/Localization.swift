import Foundation

enum HelperLocale: String, CaseIterable, Sendable {
    case en, zhHans = "zh-Hans", zhHant = "zh-Hant", ja

    enum Text: Int, CaseIterable {
        case title, access, persistentAccess, source, fingerprint, remoteRisk, localRisk
        case deny, allowSession, allowPersistent
        case menuTitle, noWindows, oneWindow, multipleWindows, stop, revokeCurrent, revokeAll, keyStoreError
        case claimedSource, process, executable, signingIdentifier, teamID, signingUnavailable, noTeamID, adHoc
    }

    subscript(_ text: Text) -> String { Self.strings[self]![text.rawValue] }

    func sourceLabel(_ label: String) -> String { "\u{2068}\(label)\u{2069}" }

    func keyFingerprint(_ fingerprint: String) -> String { "\u{2066}\(fingerprint)\u{2069}" }

    private static let strings: [Self: [String]] = [
        .en: [
            "Allow window control through Rome?",
            "Window control can read private information. Stop it from the menu bar or settings.",
            "The key holder can connect without asking.",
            "Source", "Key fingerprint",
            "Verify the remote fingerprint.",
            "Apps running as you can use the private key to connect without asking.",
            "Deny", "Allow This Session", "Always Allow This Source",
            "Rome Computer Use", "No window bound", "1 active window", "%d active windows", "Stop Computer Use",
            "Revoke “%@” (%@) & Stop", "Revoke All Authorized Keys", "Could not revoke authorized keys",
            "Claimed by requester", "Process", "Executable", "Signing ID", "Team ID", "Unverified", "None", "Ad hoc signed",
        ],
        .zhHans: [
            "允许通过 Rome 控制窗口？",
            "此来源申请控制窗口，可能读取隐私信息。你可以在菜单栏或应用设置中停止。",
            "长期授权凭私钥免确认。",
            "来源", "公钥指纹",
            "核对远端指纹。",
            "本机同用户进程可凭私钥免确认。",
            "拒绝", "允许本次会话", "总是允许该来源",
            "Rome 电脑控制", "未绑定窗口", "1 个活动窗口", "%d 个活动窗口", "停止电脑控制",
            "撤销「%@」（%@）并停止", "撤销全部已授权来源", "无法撤销已授权公钥",
            "请求方声称", "进程", "可执行文件", "签名标识", "团队 ID", "未验证", "无", "临时签名",
        ],
        .zhHant: [
            "允許透過 Rome 控制視窗？",
            "此來源申請控制視窗，可能讀取隱私資訊。你可以在選單列或應用程式設定中停止。",
            "長期授權可憑私密金鑰直接連線。",
            "來源", "公開金鑰指紋",
            "請核對遠端指紋。",
            "同一使用者的程序可憑私密金鑰直接連線。",
            "拒絕", "允許本次工作階段", "一律允許此來源",
            "Rome 電腦控制", "未綁定視窗", "1 個使用中的視窗", "%d 個使用中的視窗", "停止電腦控制",
            "撤銷「%@」（%@）並停止", "撤銷所有已授權來源", "無法撤銷已授權的公開金鑰",
            "請求方聲稱", "程序", "可執行檔", "簽章識別碼", "團隊 ID", "未驗證", "無", "臨時簽章",
        ],
        .ja: [
            "Rome 経由でウインドウの操作を許可しますか？",
            "ウインドウの操作により個人情報が読み取られる場合があります。メニューバーまたは設定から停止できます。",
            "秘密鍵があれば確認なしで再接続できます。",
            "接続元", "公開鍵のフィンガープリント",
            "リモート側の指紋と照合してください。",
            "同じユーザーのアプリが秘密鍵を読めると確認なしで再接続できます。",
            "拒否", "今回のセッションを許可", "この接続元を常に許可",
            "Rome コンピュータ操作", "接続中のウインドウなし", "1 個のウインドウが接続中", "%d 個のウインドウが接続中",
            "コンピュータの操作を停止", "「%@」（%@）の許可を取り消して停止", "すべての接続元の許可を取り消す",
            "許可済みの鍵を取り消せませんでした",
            "要求元の申告", "プロセス", "実行ファイル", "署名識別子", "チーム ID", "未検証", "なし", "アドホック署名",
        ],
    ]
}

func resolveLocale(requested: String?, preferred: [String]) -> HelperLocale {
    func parse(_ tag: String) -> HelperLocale? {
        guard tag.utf8.count <= 64, tag.utf8.allSatisfy({ $0 < 128 }) else { return nil }
        let fields = tag.lowercased().split(separator: "-", omittingEmptySubsequences: false)
        guard fields.allSatisfy({ (1...8).contains($0.utf8.count) && $0.utf8.allSatisfy {
            (97...122).contains($0) || (48...57).contains($0)
        } }) else { return nil }
        switch fields.first {
        case "en": return .en
        case "ja": return .ja
        case "zh":
            switch fields.dropFirst().first {
            case "hant", "tw", "hk", "mo": return .zhHant
            case nil, "hans", "cn", "sg": return .zhHans
            default: return nil
            }
        default: return nil
        }
    }

    return requested.flatMap(parse) ?? preferred.lazy.compactMap(parse).first ?? .en
}

func sanitizeLabel(_ label: String) -> String? {
    var clean = String.UnicodeScalarView()
    var space = false
    for scalar in label.unicodeScalars {
        if scalar.properties.isWhitespace {
            space = !clean.isEmpty
            continue
        }
        if scalar.properties.generalCategory == .control || scalar.properties.generalCategory == .format { continue }
        if space { clean.append(" ") }
        clean.append(scalar)
        space = false
        // Bound both display width and the size of a grapheme with many combining marks.
        if clean.count >= 256 { break }
    }
    let result = String(clean).prefix(64).trimmingCharacters(in: .whitespaces)
    guard result.unicodeScalars.contains(where: {
        !$0.properties.isWhitespace && !$0.properties.isDefaultIgnorableCodePoint &&
            ![.nonspacingMark, .spacingMark, .enclosingMark].contains($0.properties.generalCategory)
    }) else { return nil }
    return result
}
