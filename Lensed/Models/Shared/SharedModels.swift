import Foundation

// MARK: - Filter State

struct FilterState: Sendable {
    var dateFrom: Date?
    var dateTo: Date?
    var productId: String = "all"

    var dateFromString: String? {
        dateFrom.map { DateFormatters.iso.string(from: $0) }
    }

    var dateToString: String? {
        dateTo.map { DateFormatters.iso.string(from: $0) }
    }
}

struct WhatnotFilterState: Sendable {
    var dateFrom: Date?
    var dateTo: Date?
    var livestreamId: String = "all"

    var dateFromString: String? {
        dateFrom.map { DateFormatters.iso.string(from: $0) }
    }

    var dateToString: String? {
        dateTo.map { DateFormatters.iso.string(from: $0) }
    }
}

// MARK: - Margin Level

enum MarginLevel: Sendable {
    case green, yellow, red
}

// MARK: - Quick Filter Period

enum QuickFilterPeriod: String, CaseIterable, Sendable {
    case today = "Today"
    case yesterday = "Yesterday"
    case sevenDays = "7 Days"
    case thirtyDays = "30 Days"
    case custom = "Custom"

    var dateOffset: Int? {
        switch self {
        case .today: return 0
        case .yesterday: return -1
        case .sevenDays: return -7
        case .thirtyDays: return -30
        case .custom: return nil
        }
    }

    /// For today/yesterday we use start of that day; for multi-day we go back N days from today
    var isSingleDay: Bool {
        switch self {
        case .today, .yesterday: return true
        case .sevenDays, .thirtyDays, .custom: return false
        }
    }

    /// Periods shown as buttons (excludes custom which is via calendar)
    static var presetCases: [QuickFilterPeriod] {
        [.today, .yesterday, .sevenDays, .thirtyDays]
    }
}

// MARK: - Dashboard Metrics

struct TikTokDashboardMetrics: Sendable {
    var totalGMV: Double = 0
    var totalNetProfit: Double = 0
    var avgMargin: Double = 0
    var totalVideos: Int = 0
    var totalViews: Int = 0
    var totalAds: Double = 0
    var totalAffiliate: Double = 0
    var totalShipping: Double = 0
    var totalUnitsSold: Int = 0
    var entryCount: Int = 0
    var avgViewsPerVideo: Double = 0
    var revenuePerVideo: Double = 0
    var profitPerVideo: Double = 0
    var roas: Double?
    var topProduct: (name: String, profit: Double)?
    var productProfits: [String: ProductProfitData] = [:]
}

struct ProductProfitData: Sendable {
    var profit: Double = 0
    var gmv: Double = 0
    var unitsSold: Int = 0
    var revenue: Double = 0
    var orders: Int = 0
    /// Variant name -> units sold (for products with variations)
    var variantUnits: [String: Int] = [:]
    /// Price range: min (lowest variant) and max (highest variant). Single price: min == max.
    var priceMin: Double?
    var priceMax: Double?
}

struct WhatnotDashboardMetrics: Sendable {
    var totalRevenue: Double = 0
    var totalProfit: Double = 0
    var totalOrders: Int = 0
    var totalOrdersExGiveaways: Int = 0
    var totalUnits: Int = 0
    var totalShipping: Double = 0
    var totalFees: Double = 0
    var totalCogs: Double = 0
    var totalGiveaways: Int = 0
    var avgSellingPrice: Double = 0
    var avgOrderValue: Double = 0
    var avgOrderSize: Double = 0
    var profitMargin: Double = 0
    var salesPerHour: Double = 0
    var profitPerHour: Double = 0
    var unitsPerHour: Double = 0
    var viewsPerHour: Double?
    var profitPerDay: Double = 0
    var ordersPerDay: Double = 0
    var productProfits: [String: ProductProfitData] = [:]
    var topProduct: (name: String, profit: Double)?
}

// MARK: - Chart Data Models

struct TimeSeriesData: Identifiable, Sendable {
    let id = UUID()
    let date: String
    let value: Double
}

struct ChartSeriesData: Identifiable, Sendable {
    let id = UUID()
    let date: String
    let value: Double
    let series: String
}

struct CostBreakdownItem: Identifiable, Sendable {
    let id = UUID()
    let label: String
    let value: Double
    let percentage: Double
    let color: String
}

struct ProductCompareItem: Identifiable, Sendable {
    let id = UUID()
    let name: String
    let gmv: Double
    let profit: Double
}

struct TikTokChartData: Sendable {
    var profitByDate: [TimeSeriesData] = []
    var gmvByDate: [TimeSeriesData] = []
    var marginByDate: [TimeSeriesData] = []
    var costBreakdown: [CostBreakdownItem] = []
    var productCompare: [ProductCompareItem] = []
}

struct MonthlyForecast: Sendable {
    let sales: Double
    let unitsSold: Int
    let videosPosted: Int
    let affiliateCommission: Double
    let adCost: Double
    let estimatedPayout: Double
    let netProfit: Double
    let marginPercent: Double
    let daysRemaining: Int
    let percentThroughMonth: Double
    let monthStart: Date
    let monthEnd: Date
}

struct WhatnotChartData: Sendable {
    var profitByDate: [TimeSeriesData] = []
    var revenueByDate: [TimeSeriesData] = []
    var salesPerHourByDate: [TimeSeriesData] = []
    var feeBreakdown: [CostBreakdownItem] = []
    var profitByLivestream: [TimeSeriesData] = []
}

// MARK: - Livestream Metrics

struct WhatnotLivestreamMetrics: Identifiable, Sendable {
    let id: String
    let title: String
    let startedAt: Date
    let endedAt: Date?
    let durationHours: Double
    let revenue: Double
    let profit: Double
    let orders: Int
    let units: Int
    let giveaways: Int
    let salesPerHour: Double
    let profitPerHour: Double
    let unitsPerHour: Double
    let viewsPerHour: Double?
    let avgSellingPrice: Double
}

// MARK: - Date Formatters

enum DateFormatters {
    static let iso: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    static let display: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f
    }()

    static let shortDisplay: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()
}

// MARK: - Whatnot Fee Constants

enum WhatnotFees {
    static let standardRate: Double = 0.08
    static let premierRate: Double = 0.072

    static func feeRate(isPremier: Bool) -> Double {
        isPremier ? premierRate : standardRate
    }
}
