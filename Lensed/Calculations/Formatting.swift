import Foundation

enum Fmt {
    private static let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = Locale(identifier: "en_US")
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    private static let intFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = 0
        return f
    }()

    static func currency(_ n: Double?) -> String {
        guard let n, !n.isNaN else { return "$0.00" }
        return currencyFormatter.string(from: NSNumber(value: n)) ?? "$0.00"
    }

    /// Currency with no decimals (whole dollars only)
    static func currencyWhole(_ n: Double?) -> String {
        guard let n, !n.isNaN else { return "$0" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_US")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: Int(round(n)))) ?? "$0"
    }

    /// Price display: single "$999" or range "$49-$52"
    static func priceDisplay(min: Double?, max: Double?, fallbackAvg: Double? = nil) -> String {
        if let min = min, let max = max {
            let minStr = currencyWhole(min)
            let maxStr = currencyWhole(max)
            if abs(min - max) < 0.01 {
                return minStr
            }
            return "\(minStr)-\(maxStr)"
        }
        if let avg = fallbackAvg, !avg.isNaN, avg > 0 {
            return currencyWhole(avg)
        }
        return "—"
    }

    static func int(_ n: Double?) -> String {
        guard let n, !n.isNaN else { return "0" }
        return intFormatter.string(from: NSNumber(value: n)) ?? "0"
    }

    static func int(_ n: Int?) -> String {
        guard let n else { return "0" }
        return intFormatter.string(from: NSNumber(value: n)) ?? "0"
    }

    static func pct(_ n: Double?) -> String {
        guard let n, !n.isNaN else { return "0.0%" }
        return String(format: "%.1f%%", n)
    }

    static func hours(_ n: Double?) -> String {
        guard let n, !n.isNaN else { return "0h" }
        if n < 1 { return "\(Int(round(n * 60)))m" }
        return String(format: "%.1fh", n)
    }

    static func perHour(_ n: Double?) -> String {
        guard let n, !n.isNaN else { return "$0/hr" }
        return "\(currencyWhole(n))/hr"
    }
}
