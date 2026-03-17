import Foundation

typealias CostsMap = [String: Double]

enum TikTokCalculations {
    struct EntryCalc {
        let grossRevPerVideo: Double
        let cogs: Double
        let totalNetProfit: Double
        let netProfitPerVideo: Double
        let margin: Double
    }

    /// Calculate profit for a single TikTok entry.
    static func calcEntry(_ entry: TikTokEntry, costsMap: CostsMap? = nil) -> EntryCalc {
        let gmv = entry.gmv
        let videos = Double(entry.videosPosted)
        let shipping = entry.shipping
        let affiliate = entry.affiliate
        let ads = entry.ads
        let unitsSold = Double(entry.unitsSold ?? 0)

        // Platform fee is always 6%
        let platformFee = gmv * 0.06

        // Look up user-entered cost per unit
        var costPerUnit: Double = 0
        if let costsMap {
            if let variantId = entry.variantId {
                costPerUnit = costsMap["\(entry.productId)-\(variantId)"]
                    ?? costsMap[entry.productId.uuidString]
                    ?? 0
            } else {
                costPerUnit = costsMap[entry.productId.uuidString] ?? 0
            }
        }

        let totalCogs = costPerUnit * unitsSold
        let totalNetProfit = gmv - platformFee - shipping - affiliate - ads - totalCogs
        let grossRevPerVideo = videos > 0 ? gmv / videos : 0
        let netProfitPerVideo = videos > 0 ? totalNetProfit / videos : 0
        let margin = gmv > 0 ? (totalNetProfit / gmv) * 100 : 0

        return EntryCalc(
            grossRevPerVideo: grossRevPerVideo,
            cogs: platformFee + totalCogs,
            totalNetProfit: totalNetProfit,
            netProfitPerVideo: netProfitPerVideo,
            margin: margin
        )
    }

    /// Compute aggregated dashboard metrics from all entries.
    static func computeMetrics(_ entries: [TikTokEntry], costsMap: CostsMap? = nil) -> TikTokDashboardMetrics {
        var totalGMV: Double = 0
        var totalVideos = 0
        var totalViews = 0
        var totalShipping: Double = 0
        var totalAffiliate: Double = 0
        var totalAds: Double = 0
        var totalCogs: Double = 0
        var totalNetProfit: Double = 0
        var totalUnitsSold = 0
        var productProfits: [String: ProductProfitData] = [:]

        for e in entries {
            let c = calcEntry(e, costsMap: costsMap)
            let gmv = e.gmv
            let units = e.unitsSold ?? 0
            totalGMV += gmv
            totalVideos += e.videosPosted
            totalViews += e.views
            totalShipping += e.shipping
            totalAffiliate += e.affiliate
            totalAds += e.ads
            totalCogs += c.cogs
            totalNetProfit += c.totalNetProfit
            totalUnitsSold += units

            let productName = e.product?.name ?? "Unknown"
            var pp = productProfits[productName] ?? ProductProfitData()
            pp.profit += c.totalNetProfit
            pp.gmv += gmv
            pp.unitsSold += units
            if let vid = e.variantId, let variantName = e.product?.variants?.first(where: { $0.id == vid })?.name {
                pp.variantUnits[variantName, default: 0] += units
            }
            productProfits[productName] = pp
        }

        let avgMargin = totalGMV > 0 ? (totalNetProfit / totalGMV) * 100 : 0
        let avgViewsPerVideo = totalVideos > 0 ? Double(totalViews) / Double(totalVideos) : 0
        let revenuePerVideo = totalVideos > 0 ? totalGMV / Double(totalVideos) : 0
        let profitPerVideo = totalVideos > 0 ? totalNetProfit / Double(totalVideos) : 0
        let roas: Double? = totalAds > 0 ? totalGMV / totalAds : nil

        var topProduct: (name: String, profit: Double)?
        for (name, data) in productProfits {
            if topProduct == nil || data.profit > (topProduct?.profit ?? 0) {
                topProduct = (name, data.profit)
            }
        }

        return TikTokDashboardMetrics(
            totalGMV: totalGMV,
            totalNetProfit: totalNetProfit,
            avgMargin: avgMargin,
            totalVideos: totalVideos,
            totalViews: totalViews,
            totalAds: totalAds,
            totalAffiliate: totalAffiliate,
            totalShipping: totalShipping,
            totalUnitsSold: totalUnitsSold,
            entryCount: entries.count,
            avgViewsPerVideo: avgViewsPerVideo,
            revenuePerVideo: revenuePerVideo,
            profitPerVideo: profitPerVideo,
            roas: roas,
            topProduct: topProduct,
            productProfits: productProfits
        )
    }

    /// Compute chart data from entries.
    static func computeChartData(_ entries: [TikTokEntry], costsMap: CostsMap? = nil) -> TikTokChartData {
        var profitByDateMap: [String: Double] = [:]
        var gmvByDateMap: [String: Double] = [:]
        var profitByDateMapForMargin: [String: Double] = [:]
        var productProfitsMap: [String: (profit: Double, gmv: Double)] = [:]

        var totalPlatformFee: Double = 0
        var totalUserCogs: Double = 0
        var totalShipping: Double = 0
        var totalAffiliate: Double = 0
        var totalAds: Double = 0
        var totalProfit: Double = 0

        for e in entries {
            let c = calcEntry(e, costsMap: costsMap)
            let gmv = e.gmv
            let unitsSold = Double(e.unitsSold ?? 0)

            // Calculate user COGS separately for breakdown
            var costPerUnit: Double = 0
            if let costsMap {
                if let variantId = e.variantId {
                    costPerUnit = costsMap["\(e.productId)-\(variantId)"]
                        ?? costsMap[e.productId.uuidString]
                        ?? 0
                } else {
                    costPerUnit = costsMap[e.productId.uuidString] ?? 0
                }
            }
            let userCogs = costPerUnit * unitsSold
            let platformFee = gmv * 0.06

            profitByDateMap[e.date, default: 0] += c.totalNetProfit
            gmvByDateMap[e.date, default: 0] += gmv
            profitByDateMapForMargin[e.date, default: 0] += c.totalNetProfit

            let productName = e.product?.name ?? "Unknown"
            var pp = productProfitsMap[productName] ?? (profit: 0, gmv: 0)
            pp.profit += c.totalNetProfit
            pp.gmv += gmv
            productProfitsMap[productName] = pp

            totalPlatformFee += platformFee
            totalUserCogs += userCogs
            totalShipping += e.shipping
            totalAffiliate += e.affiliate
            totalAds += e.ads
            totalProfit += c.totalNetProfit
        }

        // Profit by date
        let sortedDates = profitByDateMap.keys.sorted()
        let profitByDate = sortedDates.map { TimeSeriesData(date: $0, value: profitByDateMap[$0]!) }
        let gmvByDate = sortedDates.map { TimeSeriesData(date: $0, value: gmvByDateMap[$0] ?? 0) }

        // Margin by date
        let marginByDate = sortedDates.map { date -> TimeSeriesData in
            let gmv = gmvByDateMap[date] ?? 0
            let profit = profitByDateMapForMargin[date] ?? 0
            let margin = gmv > 0 ? (profit / gmv) * 100 : 0
            return TimeSeriesData(date: date, value: margin)
        }

        // Product compare
        let productCompare = productProfitsMap
            .sorted { $0.value.gmv > $1.value.gmv }
            .map { ProductCompareItem(name: $0.key, gmv: $0.value.gmv, profit: $0.value.profit) }

        // Cost breakdown
        let hasUserCogs = totalUserCogs > 0
        var breakdownItems: [CostBreakdownItem] = []
        var rawAmounts: [(String, Double, String)] = []

        rawAmounts.append(("Platform", max(0, totalPlatformFee), "#FF5C5C"))
        if hasUserCogs {
            rawAmounts.append(("COGS", max(0, totalUserCogs), "#FF8F4A"))
        }
        rawAmounts.append(("Shipping", max(0, totalShipping), "#FFB84A"))
        rawAmounts.append(("Affiliate", max(0, totalAffiliate), "#4ABAFF"))
        rawAmounts.append(("Ads", max(0, totalAds), "#C77DFF"))
        rawAmounts.append(("Net Profit", max(0, totalProfit), "#4AFF8B"))

        let totalCosts = rawAmounts.reduce(0.0) { $0 + $1.1 }
        for (label, amount, color) in rawAmounts {
            let pct = totalCosts > 0 ? (amount / totalCosts) * 100 : 0
            breakdownItems.append(CostBreakdownItem(label: label, value: amount, percentage: pct, color: color))
        }

        return TikTokChartData(
            profitByDate: profitByDate,
            gmvByDate: gmvByDate,
            marginByDate: marginByDate,
            costBreakdown: breakdownItems,
            productCompare: productCompare
        )
    }

    /// Compute monthly forecast based on last 30 days average.
    static func computeMonthlyForecast(entries: [TikTokEntry], costsMap: CostsMap?) -> MonthlyForecast? {
        let cal = Calendar.current
        let now = Date()
        let thirtyDaysAgo = cal.date(byAdding: .day, value: -30, to: now)!
        let last30 = entries.filter { e in
            guard let d = Date.fromISO(e.date) else { return false }
            return d >= thirtyDaysAgo && d <= now
        }
        guard !last30.isEmpty else { return nil }

        let m = computeMetrics(last30, costsMap: costsMap)
        let daysInMonth = cal.range(of: .day, in: .month, for: now)!.count
        let dayOfMonth = cal.component(.day, from: now)
        let daysRemaining = max(0, daysInMonth - dayOfMonth)
        let percentThrough = Double(dayOfMonth) / Double(daysInMonth) * 100

        let scale = Double(daysInMonth) / 30.0
        let monthStart = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        let monthEnd = cal.date(byAdding: .day, value: daysInMonth - 1, to: monthStart)!

        let platformFee = m.totalGMV * 0.06
        let estPayout = m.totalGMV - platformFee

        return MonthlyForecast(
            sales: m.totalGMV * scale,
            unitsSold: Int(Double(m.totalUnitsSold) * scale),
            videosPosted: Int(Double(m.totalVideos) * scale),
            affiliateCommission: m.totalAffiliate * scale,
            adCost: m.totalAds * scale,
            estimatedPayout: estPayout * scale,
            netProfit: m.totalNetProfit * scale,
            marginPercent: m.avgMargin,
            daysRemaining: daysRemaining,
            percentThroughMonth: percentThrough,
            monthStart: monthStart,
            monthEnd: monthEnd
        )
    }
}
