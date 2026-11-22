import CoreGraphics

enum DesktopInput {
    static func keyCode(_ value: String) -> CGKeyCode? {
        let keys: [String: CGKeyCode] = [
            "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
            "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19,
            "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
            "0": 29, "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "RETURN": 36, "ENTER": 36,
            "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "N": 45,
            "M": 46, ".": 47, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "ESCAPE": 53,
            "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98,
            "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
            "HOME": 115, "PAGEUP": 116, "DELETE": 117, "END": 119, "PAGEDOWN": 121,
            "ARROWLEFT": 123, "ARROWRIGHT": 124, "ARROWDOWN": 125, "ARROWUP": 126]
        return keys[value.uppercased()]
    }

    static func unicodeChunks(_ text: String) -> [[UniChar]] {
        var result: [[UniChar]] = [], current: [UniChar] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            if current.count + units.count > 16 { result.append(current); current = [] }
            current += units
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
}
