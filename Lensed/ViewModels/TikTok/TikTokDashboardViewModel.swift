import Foundation
import Observation
import WidgetKit

@Observable
@MainActor
final class TikTokDashboardViewModel {
    var entries: [TikTokEntry] = []
    var products: [TikTokProduct] = []
    var costsMap: CostsMap = [:]
    var connection: TikTokConnection?
    var latestSyncLog: TikTokSyncLog?

    var metrics = TikTokDashboardMetrics()
    var chartData = TikTokChartData()
    var monthlyForecast: MonthlyForecast?

    var selectedPeriod: QuickFilterPeriod = .thirtyDays
    var filterDateFrom: Date?
    var filterDateTo: Date?
    var filterProductId: String = "all"

    var isLoading = false
    var isSyncing = false
    var errorMessage: String?
    var syncMessage: String?

    // Store selector
    var selectedStore: String = "Demo Store"
    var showStoreMenu = false

    private let dataService = TikTokDataService()
    private let syncService = TikTokSyncService()

    private var usingDemoData = false

    var filteredEntries: [TikTokEntry] {
        entries.filter { entry in
            if let from = effectiveDateFrom {
                guard let entryDate = Date.fromISO(entry.date), entryDate >= from else { return false }
            }
            if let to = effectiveDateTo {
                guard let entryDate = Date.fromISO(entry.date), entryDate <= to else { return false }
            }
            if filterProductId != "all" {
                guard entry.productId.uuidString == filterProductId else { return false }
            }
            return true
        }
    }

    private var effectiveDateFrom: Date? {
        if let offset = selectedPeriod.dateOffset {
            let cal = Calendar.current
            let today = cal.startOfDay(for: Date())
            return cal.date(byAdding: .day, value: offset, to: today)
        }
        return filterDateFrom
    }

    private var effectiveDateTo: Date? {
        if let offset = selectedPeriod.dateOffset {
            let cal = Calendar.current
            let today = cal.startOfDay(for: Date())
            let from = cal.date(byAdding: .day, value: offset, to: today)!
            let toDay = selectedPeriod.isSingleDay ? from : today
            return cal.date(byAdding: .day, value: 1, to: toDay)?.addingTimeInterval(-1)
        }
        return filterDateTo
    }

    var sortedProducts: [(name: String, data: ProductProfitData)] {
        metrics.productProfits
            .sorted { $0.value.gmv > $1.value.gmv }
            .map { (name: $0.key, data: $0.value) }
    }

    func loadData() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            async let entriesTask = dataService.fetchEntries()
            async let productsTask = dataService.fetchProducts()
            async let costsTask = dataService.fetchProductCosts()
            async let connectionTask = dataService.fetchConnection()
            async let syncLogTask = dataService.fetchLatestSyncLog()

            let (fetchedEntries, fetchedProducts, fetchedCosts, fetchedConnection, fetchedSyncLog) =
                try await (entriesTask, productsTask, costsTask, connectionTask, syncLogTask)

            entries = fetchedEntries
            products = fetchedProducts
            costsMap = dataService.buildCostsMap(from: fetchedCosts)
            connection = fetchedConnection
            latestSyncLog = fetchedSyncLog

            if let shopName = fetchedConnection?.shopName {
                selectedStore = shopName
            }

            if entries.isEmpty {
                loadDemoData()
            } else {
                usingDemoData = false
                recomputeMetrics()
            }
        } catch {
            errorMessage = error.localizedDescription
            loadDemoData()
        }
    }

    func recomputeMetrics() {
        if usingDemoData { return }
        let filtered = filteredEntries
        metrics = TikTokCalculations.computeMetrics(filtered, costsMap: costsMap)
        chartData = TikTokCalculations.computeChartData(filtered, costsMap: costsMap)
        monthlyForecast = TikTokCalculations.computeMonthlyForecast(entries: entries, costsMap: costsMap)
        saveMetricsToWidget()
    }

    func sync() async {
        isSyncing = true
        syncMessage = nil
        defer { isSyncing = false }

        do {
            let result = try await syncService.sync()
            syncMessage = "Synced: \(result.entriesCreated) new, \(result.entriesUpdated) updated"
            await loadData()
        } catch {
            syncMessage = "Sync failed: \(error.localizedDescription)"
        }
    }

    func onFilterChange() {
        if usingDemoData {
            loadDemoData()
        } else {
            recomputeMetrics()
        }
    }

    // MARK: - Demo Data

    private func loadDemoData() {
        usingDemoData = true
        selectedStore = "Demo Store"

        let today = Date()
        let cal = Calendar.current

        // Generate 30 days of demo chart data
        var profitByDate: [TimeSeriesData] = []
        var gmvByDate: [TimeSeriesData] = []
        var marginByDate: [TimeSeriesData] = []

        let dailyGMVs: [Double] = [
            1245, 980, 1560, 2100, 1890, 1340, 760,
            1420, 1680, 2340, 1950, 1100, 890, 1670,
            2450, 1820, 1390, 2780, 3100, 2560, 1940,
            1250, 1780, 2100, 1650, 2890, 3200, 2100,
            1560, 1890
        ]

        for i in 0..<30 {
            let date = cal.date(byAdding: .day, value: -(29 - i), to: today)!
            let dateStr = DateFormatters.iso.string(from: date)
            let gmv = dailyGMVs[i]
            let profit = gmv * 0.32 + Double.random(in: -50...100)
            let margin = gmv > 0 ? (profit / gmv) * 100 : 0

            profitByDate.append(TimeSeriesData(date: dateStr, value: profit))
            gmvByDate.append(TimeSeriesData(date: dateStr, value: gmv))
            marginByDate.append(TimeSeriesData(date: dateStr, value: margin))
        }

        // Filter to selected period
        let filterFrom = effectiveDateFrom
        let filterTo = effectiveDateTo

        func filterSeries(_ series: [TimeSeriesData]) -> [TimeSeriesData] {
            series.filter { item in
                guard let d = Date.fromISO(item.date) else { return true }
                if let from = filterFrom, d < from { return false }
                if let to = filterTo, d > to { return false }
                return true
            }
        }

        let filteredProfit = filterSeries(profitByDate)
        let filteredGMV = filterSeries(gmvByDate)
        let filteredMargin = filterSeries(marginByDate)

        let totalGMV = filteredGMV.reduce(0) { $0 + $1.value }
        let totalProfit = filteredProfit.reduce(0) { $0 + $1.value }
        let totalVideos = filteredGMV.count * 3
        let totalAds = totalGMV * 0.08
        let totalAffiliate = totalGMV * 0.05
        let totalShipping = totalGMV * 0.04

        metrics = TikTokDashboardMetrics(
            totalGMV: totalGMV,
            totalNetProfit: totalProfit,
            avgMargin: totalGMV > 0 ? (totalProfit / totalGMV) * 100 : 0,
            totalVideos: totalVideos,
            totalViews: totalVideos * 12500,
            totalAds: totalAds,
            totalAffiliate: totalAffiliate,
            totalShipping: totalShipping,
            totalUnitsSold: Int(totalGMV / 18.5),
            entryCount: filteredGMV.count,
            avgViewsPerVideo: 12500,
            revenuePerVideo: totalVideos > 0 ? totalGMV / Double(totalVideos) : 0,
            profitPerVideo: totalVideos > 0 ? totalProfit / Double(totalVideos) : 0,
            roas: totalAds > 0 ? totalGMV / totalAds : nil,
            topProduct: ("Mystery Box - Premium", 4280.50),
            productProfits: [
                "Mystery Box - Premium": ProductProfitData(profit: 4280.50, gmv: 12450.00, unitsSold: 245, revenue: 12450.00, orders: 245),
                "Trading Cards - Booster Pack": ProductProfitData(profit: 3150.25, gmv: 9800.00, unitsSold: 520, revenue: 9800.00, orders: 480),
                "Collectible Figures - Anime": ProductProfitData(profit: 2890.00, gmv: 8900.00, unitsSold: 178, revenue: 8900.00, orders: 178),
                "Vintage Comics - Graded": ProductProfitData(profit: 2340.75, gmv: 7200.00, unitsSold: 45, revenue: 7200.00, orders: 45),
                "Sports Cards - Hobby Box": ProductProfitData(profit: 1560.00, gmv: 5100.00, unitsSold: 89, revenue: 5100.00, orders: 89),
            ]
        )

        // Cost breakdown
        let platformFee = totalGMV * 0.06
        let cogs = totalGMV * 0.25
        let costBreakdown = [
            CostBreakdownItem(label: "Platform", value: platformFee, percentage: 18, color: "#FF5C5C"),
            CostBreakdownItem(label: "COGS", value: cogs, percentage: 25, color: "#FF8F4A"),
            CostBreakdownItem(label: "Shipping", value: totalShipping, percentage: 12, color: "#FFB84A"),
            CostBreakdownItem(label: "Affiliate", value: totalAffiliate, percentage: 8, color: "#4ABAFF"),
            CostBreakdownItem(label: "Ads", value: totalAds, percentage: 5, color: "#C77DFF"),
            CostBreakdownItem(label: "Net Profit", value: totalProfit, percentage: 32, color: "#4AFF8B"),
        ]

        chartData = TikTokChartData(
            profitByDate: filteredProfit,
            gmvByDate: filteredGMV,
            marginByDate: filteredMargin,
            costBreakdown: costBreakdown,
            productCompare: [
                ProductCompareItem(name: "Mystery Box", gmv: 12450, profit: 4280),
                ProductCompareItem(name: "Trading Cards", gmv: 9800, profit: 3150),
                ProductCompareItem(name: "Collectibles", gmv: 8900, profit: 2890),
                ProductCompareItem(name: "Vintage Comics", gmv: 7200, profit: 2340),
                ProductCompareItem(name: "Sports Cards", gmv: 5100, profit: 1560),
            ]
        )

        // Demo products for picker
        let demoProductId = UUID()
        products = [
            TikTokProduct(id: demoProductId, userId: UUID(), name: "All Products", variants: nil, createdAt: Date()),
        ]

        // Monthly forecast for demo
        let now = today
        let monthStart = cal.date(from: DateComponents(year: cal.component(.year, from: now), month: cal.component(.month, from: now)))!
        let range = cal.range(of: .day, in: .month, for: now)!
        let daysInMonth = range.count
        let dayOfMonth = cal.component(.day, from: now)
        let daysRemaining = daysInMonth - dayOfMonth
        let percentThrough = Double(dayOfMonth) / Double(daysInMonth) * 100

        monthlyForecast = MonthlyForecast(
            sales: totalGMV * Double(daysInMonth) / 30,
            unitsSold: Int(totalGMV / 18.5) * daysInMonth / 30,
            videosPosted: totalVideos * daysInMonth / 30,
            affiliateCommission: totalAffiliate * Double(daysInMonth) / 30,
            adCost: totalAds * Double(daysInMonth) / 30,
            estimatedPayout: totalProfit * Double(daysInMonth) / 30 + (totalGMV * 0.06) * Double(daysInMonth) / 30,
            netProfit: totalProfit * Double(daysInMonth) / 30,
            marginPercent: totalGMV > 0 ? (totalProfit / totalGMV) * 100 : 0,
            daysRemaining: daysRemaining,
            percentThroughMonth: percentThrough,
            monthStart: monthStart,
            monthEnd: cal.date(byAdding: .day, value: daysInMonth - 1, to: monthStart)!
        )
        saveMetricsToWidget()
    }

    private func saveMetricsToWidget() {
        WidgetDataStore.saveMetrics(
            gmv: metrics.totalGMV,
            netProfit: metrics.totalNetProfit,
            videosPosted: metrics.totalVideos,
            adSpend: metrics.totalAds
        )
        WidgetCenter.shared.reloadAllTimelines()
    }
}
