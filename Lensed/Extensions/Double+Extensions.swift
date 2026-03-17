import Foundation

extension Double {
    var marginLevel: MarginLevel {
        if self >= 25 { return .green }
        if self >= 10 { return .yellow }
        return .red
    }
}

extension Optional where Wrapped == Double {
    var orZero: Double { self ?? 0 }
}
