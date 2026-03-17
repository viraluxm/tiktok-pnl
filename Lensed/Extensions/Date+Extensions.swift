import Foundation

extension Date {
    var startOfDay: Date {
        Calendar.current.startOfDay(for: self)
    }

    func adding(days: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: days, to: self)!
    }

    var isoDateString: String {
        DateFormatters.iso.string(from: self)
    }

    var displayString: String {
        DateFormatters.display.string(from: self)
    }

    var shortDisplayString: String {
        DateFormatters.shortDisplay.string(from: self)
    }

    static func fromISO(_ string: String) -> Date? {
        DateFormatters.iso.date(from: string)
    }

    func durationHours(to end: Date?) -> Double {
        guard let end else { return 0 }
        return end.timeIntervalSince(self) / 3600
    }
}
