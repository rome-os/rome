import Foundation

enum HelperLocale: String, CaseIterable, Sendable {
    case en, zhHans = "zh-Hans", zhHant = "zh-Hant", ja

    enum Text: Int, CaseIterable {
        case title, access, persistentAccess, source, fingerprint, remoteRisk, localRisk
        case deny, allowSession, allowPersistent
        case menuTitle, noWindows, oneWindow, multipleWindows, stop, revokeCurrent, revokeAll, keyStoreError
        case claimedSource, process, executable, signingIdentifier, teamID, signingUnavailable, noTeamID, adHoc
        case setupTitle, setupAccessibility, setupDeviceControl, setupScreenRecording, setupScreenAndAudioRecording
        case setupGranted, setupPending
        case setupInstructions, setupScreenInstructions, setupDragHint, setupGrantedDetail
        case setupComplete, setupCompleteDetail, setupCompleteReopenDetail
        case setupOpenSettings, setupShowInFinder, setupDone, setupClose
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
            "Set Up Computer Use", "Accessibility", "Device Control and Data Access",
            "Screen Recording", "Screen & System Audio Recording", "Allowed", "Needs permission",
            "Turn on Rome Computer Use in System Settings. If it is missing, drag the app below into the list.",
            "Turn on Rome Computer Use in System Settings (drag the app below into the list if missing). If macOS asks, click “Quit & Reopen”.",
            "Drag into System Settings", "This permission is on. Select the other step to finish.",
            "All set!", "Rome Computer Use has both permissions.",
            "Rome Computer Use has both permissions. If macOS prompted to “Quit & Reopen”, click it to finish applying access.",
            "Open System Settings", "Show in Finder", "Done", "Close",
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
            "设置电脑控制权限", "辅助功能", "设备控制和数据访问",
            "屏幕录制", "录屏与系统录音", "已允许", "待授权",
            "在「系统设置」中打开 Rome Computer Use 的开关。如果列表中没有此项，请将下方的应用拖入列表。",
            "在「系统设置」中打开 Rome Computer Use 的开关（如果列表中没有，请将下方应用拖入列表）。若系统提示，请点击「退出并重新打开」。",
            "拖入「系统设置」", "此权限已开启。请选择另一项完成设置。",
            "设置完成！", "Rome Computer Use 已获得两项权限。",
            "Rome Computer Use 已获得两项权限。如果系统弹出提示，请点击「退出并重新打开」完成生效。",
            "打开系统设置", "在访达中显示", "完成", "关闭",
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
            "設定電腦控制權限", "輔助使用", "裝置控制和資料取用",
            "螢幕錄製", "螢幕與系統錄音", "已允許", "待授權",
            "在「系統設定」中開啟 Rome Computer Use 的開關。如果列表中沒有這個項目，請將下方的 App 拖入列表。",
            "在「系統設定」中開啟 Rome Computer Use 的開關（如果列表中沒有，請將下方 App 拖入列表）。若系統提示，請點擊「結束並重新打開」。",
            "拖入「系統設定」", "這項權限已開啟。請選取另一項以完成設定。",
            "設定完成！", "Rome Computer Use 已取得兩項權限。",
            "Rome Computer Use 已取得兩項權限。如果系統彈出提示，請點擊「結束並重新打開」完成套用。",
            "打開系統設定", "在 Finder 中顯示", "完成", "關閉",
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
            "コンピュータ操作の権限設定", "アクセシビリティ", "デバイスの制御とデータへのアクセス",
            "画面収録", "画面収録とシステムオーディオ録音", "許可済み", "許可が必要",
            "「システム設定」で Rome Computer Use をオンにしてください。一覧にない場合は、下のアプリを一覧へドラッグしてください。",
            "「システム設定」で Rome Computer Use をオンにしてください（一覧にない場合は下のアプリをドラッグ）。確認が出たら「終了して再度開く」をクリックしてください。",
            "「システム設定」へドラッグ", "この権限は許可済みです。もう一方の項目を選んで設定を完了してください。",
            "設定が完了しました", "Rome Computer Use に両方の権限が付与されました。",
            "Rome Computer Use に両方の権限が付与されました。システムから確認が表示された場合は「終了して再度開く」をクリックしてください。",
            "システム設定を開く", "Finder で表示", "完了", "閉じる",
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
