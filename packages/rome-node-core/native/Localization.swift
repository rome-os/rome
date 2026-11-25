import Foundation

enum HelperLocale: String, CaseIterable, Sendable {
    case en, zhHans = "zh-Hans", zhHant = "zh-Hant", ja

    enum Text: Int, CaseIterable {
        case title, access, persistentAccess, source, fingerprint, remoteRisk, localRisk
        case deny, allowSession, allowPersistent
        case menuTitle, noWindows, oneWindow, multipleWindows, stop, revokeCurrent, revokeAll, keyStoreError
    }

    subscript(_ text: Text) -> String { Self.strings[self]![text.rawValue] }

    func sourceLabel(_ label: String) -> String { "\u{2068}\(label)\u{2069}" }

    func keyFingerprint(_ fingerprint: String) -> String { "\u{2066}\(fingerprint)\u{2069}" }

    private static let strings: [Self: [String]] = [
        .en: [
            "Allow computer use?",
            "This source can list, read, and control eligible windows until the session ends. Use Stop Computer Use in the menu bar to stop it.",
            "If you always allow this source, its private key can start future sessions without asking you.",
            "Source", "Key fingerprint",
            "The requester says a remote host holds the private key. Compare the fingerprint with the one shown on that host before you approve.",
            "The requester says the private key is on this Mac. If you always allow this source, any process running as you that can read the key can control this Mac unattended until you revoke it.",
            "Deny", "Allow This Session", "Always Allow This Source",
            "Rome Computer Use", "No window bound", "1 active window", "%d active windows", "Stop Computer Use",
            "Revoke “%@” (%@) & Stop", "Revoke All Authorized Keys", "Could not access authorized keys",
        ],
        .zhHans: [
            "允许电脑控制？",
            "此来源可以列出、读取和控制符合条件的窗口，直到会话结束。可在菜单栏选择「停止电脑控制」。",
            "如果总是允许此来源，持有私钥的一方可以在未来无需确认地开启会话。",
            "来源", "公钥指纹",
            "请求方声明私钥由远端主机持有。请在确认前核对这里的指纹与远端主机显示的指纹一致。",
            "请求方声明私钥存放在本机。如果总是允许该来源，以你的用户身份运行且能读取私钥的任何进程，都可以在撤销授权前无人值守地控制这台 Mac。",
            "拒绝", "允许本次会话", "总是允许该来源",
            "Rome 电脑控制", "未绑定窗口", "1 个活动窗口", "%d 个活动窗口", "停止电脑控制",
            "撤销「%@」（%@）并停止", "撤销全部已授权来源", "无法访问已授权公钥",
        ],
        .zhHant: [
            "允許電腦控制？",
            "此來源可以列出、讀取和控制符合條件的視窗，直到工作階段結束。可在選單列選擇「停止電腦控制」。",
            "如果一律允許此來源，持有私密金鑰的一方日後可直接啟動工作階段，無需確認。",
            "來源", "公開金鑰指紋",
            "請求方聲明私密金鑰由遠端主機持有。確認前，請核對這裡的指紋與遠端主機顯示的指紋一致。",
            "請求方聲明私密金鑰儲存在這台 Mac。如果一律允許此來源，以你的使用者身分執行且能讀取金鑰的任何程序，都能在撤銷授權前無人值守地控制這台 Mac。",
            "拒絕", "允許本次工作階段", "一律允許此來源",
            "Rome 電腦控制", "未綁定視窗", "1 個使用中的視窗", "%d 個使用中的視窗", "停止電腦控制",
            "撤銷「%@」（%@）並停止", "撤銷所有已授權來源", "無法存取已授權的公開金鑰",
        ],
        .ja: [
            "コンピュータの操作を許可しますか？",
            "この接続元はセッションが終了するまで、対象のウインドウを一覧表示し、読み取り、操作できます。メニューバーの「コンピュータの操作を停止」で終了できます。",
            "この接続元を常に許可すると、秘密鍵を持つ側は今後、確認なしでセッションを開始できます。",
            "接続元", "公開鍵のフィンガープリント",
            "接続元は、秘密鍵をリモートホストで管理していると申告しています。許可する前に、表示されているフィンガープリントがリモートホストの表示と一致することを確認してください。",
            "接続元は、秘密鍵をこの Mac に保存していると申告しています。この接続元を常に許可すると、自分のユーザーとして動作し、秘密鍵を読み取れるプロセスは、許可を取り消すまで無人でこの Mac を操作できます。",
            "拒否", "今回のセッションを許可", "この接続元を常に許可",
            "Rome コンピュータ操作", "接続中のウインドウなし", "1 個のウインドウが接続中", "%d 個のウインドウが接続中",
            "コンピュータの操作を停止", "「%@」（%@）の許可を取り消して停止", "すべての接続元の許可を取り消す",
            "許可済みの鍵にアクセスできません",
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
