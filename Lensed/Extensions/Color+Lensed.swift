import SwiftUI

extension Color {
    // Primary brand colors (matching web dark theme)
    static let lensedBackground = Color(hex: "0a0a0a")
    static let lensedCardBackground = Color(hex: "171717")
    static let lensedCardBorder = Color(hex: "262626")
    static let lensedAccent = Color(hex: "69C9D0") // TikTok teal
    static let lensedSecondaryAccent = Color(hex: "EE1D52") // TikTok red

    // Text colors
    static let lensedTextPrimary = Color(hex: "fafafa")
    static let lensedTextSecondary = Color(hex: "a3a3a3")
    static let lensedTextMuted = Color(hex: "737373")

    // Status colors
    static let lensedGreen = Color(hex: "22c55e")
    static let lensedYellow = Color(hex: "eab308")
    static let lensedRed = Color(hex: "ef4444")

    // Chart colors
    static let chartPink = Color(hex: "ff6384")
    static let chartOrange = Color(hex: "f97316")
    static let chartAmber = Color(hex: "ff9f40")
    static let chartYellow = Color(hex: "ffcd56")
    static let chartTikTokRed = Color(hex: "EE1D52")
    static let chartTeal = Color(hex: "69C9D0")

    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }

    static func fromHex(_ hex: String) -> Color {
        Color(hex: hex)
    }
}
