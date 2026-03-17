import Foundation

enum WhatnotCalculations {

    /// Calculate profit for a single Whatnot order.
    static func calcOrderProfit(
        _ order: WhatnotOrder,
        costsMap: CostsMap,
        isPremier: Bool
    ) -> Double {
        if order.isGiveaway { return 0 }

        let salePrice = order.salePrice
        let shippingCost = order.shippingCost
        let feeRate = WhatnotFees.feeRate(isPremier: isPremier)
        let whatnotFee = salePrice * feeRate
        let units = Double(order.units)

        var costPerUnit: Double = 0
        if let variantId = order.variantId, let productId = order.productId {
            costPerUnit = costsMap["\(productId)-\(variantId)"] ?? costsMap[productId] ?? 0
        } else if let productId = order.productId {
            costPerUnit = costsMap[productId] ?? 0
        }

        let totalCogs = costPerUnit * units
        return salePrice - whatnotFee - shippingCost - totalCogs
    }

    /// Compute aggregated dashboard metrics.
    static func computeMetrics(
        orders: [WhatnotOrder],
        livestreams: [WhatnotLivestream],
        costsMap: CostsMap,
        isPremier: Bool
    ) -> WhatnotDashboardMetrics {
        let feeRate = WhatnotFees.feeRate(isPremier: isPremier)
        var totalRevenue: Double = 0
        var totalProfit: Double = 0
        var totalShipping: Double = 0
        var totalFees: Double = 0
        var totalCogs: Double = 0
        var totalUnits = 0
        var totalOrders = 0
        var totalOrdersExGiveaways = 0
        var totalGiveaways = 0
        var productProfits: [String: ProductProfitData] = [:]
        var orderDays = Set<String>()

        for order in orders {
            totalOrders += 1

            let isoDate: String
            let calendar = Calendar.current
            let components = calendar.dateComponents([.year, .month, .day], from: order.orderDate)
            isoDate = String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)
            orderDays.insert(isoDate)

            if order.isGiveaway {
                totalGiveaways += 1
                continue
            }

            totalOrdersExGiveaways += 1
            let salePrice = order.salePrice
            let shippingCost = order.shippingCost
            let units = order.units
            let whatnotFee = salePrice * feeRate

            var costPerUnit: Double = 0
            if let variantId = order.variantId, let productId = order.productId {
                costPerUnit = costsMap["\(productId)-\(variantId)"] ?? costsMap[productId] ?? 0
            } else if let productId = order.productId {
                costPerUnit = costsMap[productId] ?? 0
            }
            let cogs = costPerUnit * Double(units)

            totalRevenue += salePrice
            totalShipping += shippingCost
            totalFees += whatnotFee
            totalCogs += cogs
            totalUnits += units
            totalProfit += salePrice - whatnotFee - shippingCost - cogs

            let productName = order.productName ?? "Unknown"
            var pp = productProfits[productName] ?? ProductProfitData()
            pp.revenue += salePrice
            pp.profit += salePrice - whatnotFee - shippingCost - cogs
            pp.unitsSold += units
            pp.orders += 1
            productProfits[productName] = pp
        }

        let totalLivestreamHours = livestreams.reduce(0.0) { acc, ls in
            acc + (ls.durationMinutes ?? 0) / 60
        }

        let daysCount = max(orderDays.count, 1)
        let avgOrderValue = totalOrdersExGiveaways > 0 ? totalRevenue / Double(totalOrdersExGiveaways) : 0
        let avgOrderSize = totalOrdersExGiveaways > 0 ? Double(totalUnits) / Double(totalOrdersExGiveaways) : 0
        let profitMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0

        var topProduct: (name: String, profit: Double)?
        for (name, data) in productProfits {
            if topProduct == nil || data.profit > (topProduct?.profit ?? 0) {
                topProduct = (name, data.profit)
            }
        }

        return WhatnotDashboardMetrics(
            totalRevenue: totalRevenue,
            totalProfit: totalProfit,
            totalOrders: totalOrders,
            totalOrdersExGiveaways: totalOrdersExGiveaways,
            totalUnits: totalUnits,
            totalShipping: totalShipping,
            totalFees: totalFees,
            totalCogs: totalCogs,
            totalGiveaways: totalGiveaways,
            avgSellingPrice: totalUnits > 0 ? totalRevenue / Double(totalUnits) : 0,
            avgOrderValue: avgOrderValue,
            avgOrderSize: avgOrderSize,
            profitMargin: profitMargin,
            salesPerHour: totalLivestreamHours > 0 ? totalRevenue / totalLivestreamHours : 0,
            profitPerHour: totalLivestreamHours > 0 ? totalProfit / totalLivestreamHours : 0,
            unitsPerHour: totalLivestreamHours > 0 ? Double(totalUnits) / totalLivestreamHours : 0,
            profitPerDay: totalProfit / Double(daysCount),
            ordersPerDay: Double(totalOrdersExGiveaways) / Double(daysCount),
            productProfits: productProfits,
            topProduct: topProduct
        )
    }

    /// Compute chart data for Whatnot dashboard.
    static func computeChartData(
        orders: [WhatnotOrder],
        livestreams: [WhatnotLivestream],
        costsMap: CostsMap,
        isPremier: Bool
    ) -> WhatnotChartData {
        let feeRate = WhatnotFees.feeRate(isPremier: isPremier)
        var profitByDateMap: [String: Double] = [:]
        var revenueByDateMap: [String: Double] = [:]

        var totalFees: Double = 0
        var totalCogs: Double = 0
        var totalShipping: Double = 0
        var totalProfit: Double = 0

        for order in orders {
            if order.isGiveaway { continue }

            let calendar = Calendar.current
            let components = calendar.dateComponents([.year, .month, .day], from: order.orderDate)
            let date = String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)

            let salePrice = order.salePrice
            let shippingCost = order.shippingCost
            let units = Double(order.units)
            let whatnotFee = salePrice * feeRate

            var costPerUnit: Double = 0
            if let variantId = order.variantId, let productId = order.productId {
                costPerUnit = costsMap["\(productId)-\(variantId)"] ?? costsMap[productId] ?? 0
            } else if let productId = order.productId {
                costPerUnit = costsMap[productId] ?? 0
            }
            let cogs = costPerUnit * units
            let profit = salePrice - whatnotFee - shippingCost - cogs

            profitByDateMap[date, default: 0] += profit
            revenueByDateMap[date, default: 0] += salePrice

            totalFees += whatnotFee
            totalCogs += cogs
            totalShipping += shippingCost
            totalProfit += profit
        }

        let sortedDates = profitByDateMap.keys.sorted()
        let profitByDate = sortedDates.map { TimeSeriesData(date: $0, value: profitByDateMap[$0]!) }
        let revenueByDate = sortedDates.map { TimeSeriesData(date: $0, value: revenueByDateMap[$0] ?? 0) }

        // Sales per hour by livestream date
        var livestreamByDate: [String: (revenue: Double, hours: Double)] = [:]
        for ls in livestreams {
            let calendar = Calendar.current
            let components = calendar.dateComponents([.year, .month, .day], from: ls.startedAt)
            let date = String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)
            let hours = (ls.durationMinutes ?? 0) / 60
            var entry = livestreamByDate[date] ?? (revenue: 0, hours: 0)
            entry.hours += hours
            livestreamByDate[date] = entry
        }
        for order in orders {
            if order.isGiveaway { continue }
            let calendar = Calendar.current
            let components = calendar.dateComponents([.year, .month, .day], from: order.orderDate)
            let date = String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)
            if livestreamByDate[date] != nil {
                livestreamByDate[date]!.revenue += order.salePrice
            }
        }
        let salesPerHourDates = livestreamByDate.keys
            .filter { livestreamByDate[$0]!.hours > 0 }
            .sorted()
        let salesPerHourByDate = salesPerHourDates.map { date in
            TimeSeriesData(date: date, value: livestreamByDate[date]!.revenue / livestreamByDate[date]!.hours)
        }

        // Fee breakdown
        let hasCogs = totalCogs > 0
        var breakdownItems: [CostBreakdownItem] = []
        var rawAmounts: [(String, Double, String)] = []
        let feeLabel = isPremier ? "Whatnot Fee (7.2%)" : "Whatnot Fee (8%)"

        rawAmounts.append((feeLabel, max(0, totalFees), "#ff6384"))
        if hasCogs {
            rawAmounts.append(("COGS", max(0, totalCogs), "#f97316"))
        }
        rawAmounts.append(("Shipping", max(0, totalShipping), "#ff9f40"))
        rawAmounts.append(("Net Profit", max(0, totalProfit), "#69C9D0"))

        let totalAll = rawAmounts.reduce(0.0) { $0 + $1.1 }
        for (label, amount, color) in rawAmounts {
            let pct = totalAll > 0 ? (amount / totalAll) * 100 : 0
            breakdownItems.append(CostBreakdownItem(label: label, value: amount, percentage: pct, color: color))
        }

        // Profit by livestream
        var ordersByLivestream: [String: [WhatnotOrder]] = [:]
        for order in orders {
            if order.isGiveaway || order.livestreamId == nil { continue }
            ordersByLivestream[order.livestreamId!, default: []].append(order)
        }

        var livestreamProfitEntries: [(id: String, label: String, profit: Double, startedAt: Date)] = []
        for ls in livestreams {
            let lsOrders = ordersByLivestream[ls.whatnotLivestreamId] ?? []
            var profit: Double = 0
            for order in lsOrders {
                let sp = order.salePrice
                let sc = order.shippingCost
                let u = Double(order.units)
                let fee = sp * feeRate
                var cpu: Double = 0
                if let variantId = order.variantId, let productId = order.productId {
                    cpu = costsMap["\(productId)-\(variantId)"] ?? costsMap[productId] ?? 0
                } else if let productId = order.productId {
                    cpu = costsMap[productId] ?? 0
                }
                profit += sp - fee - sc - cpu * u
            }
            let label = ls.title ?? DateFormatters.display.string(from: ls.startedAt)
            livestreamProfitEntries.append((ls.whatnotLivestreamId, label, profit, ls.startedAt))
        }
        livestreamProfitEntries.sort { $0.startedAt < $1.startedAt }
        let profitByLivestream = livestreamProfitEntries.map {
            TimeSeriesData(date: $0.label, value: $0.profit)
        }

        return WhatnotChartData(
            profitByDate: profitByDate,
            revenueByDate: revenueByDate,
            salesPerHourByDate: salesPerHourByDate,
            feeBreakdown: breakdownItems,
            profitByLivestream: profitByLivestream
        )
    }

    /// Compute metrics for a specific livestream.
    static func computeLivestreamMetrics(
        livestream: WhatnotLivestream,
        orders: [WhatnotOrder],
        costsMap: CostsMap,
        isPremier: Bool
    ) -> WhatnotLivestreamMetrics {
        let feeRate = WhatnotFees.feeRate(isPremier: isPremier)
        let durationHours = (livestream.durationMinutes ?? 0) / 60

        let lsOrders = orders.filter { $0.livestreamId == livestream.whatnotLivestreamId }
        let salesOrders = lsOrders.filter { !$0.isGiveaway }
        let giveawayCount = lsOrders.filter { $0.isGiveaway }.count

        var revenue: Double = 0
        var profit: Double = 0
        var units = 0

        for order in salesOrders {
            let salePrice = order.salePrice
            let shippingCost = order.shippingCost
            let orderUnits = order.units
            let whatnotFee = salePrice * feeRate

            var costPerUnit: Double = 0
            if let variantId = order.variantId, let productId = order.productId {
                costPerUnit = costsMap["\(productId)-\(variantId)"] ?? costsMap[productId] ?? 0
            } else if let productId = order.productId {
                costPerUnit = costsMap[productId] ?? 0
            }

            revenue += salePrice
            profit += salePrice - whatnotFee - shippingCost - costPerUnit * Double(orderUnits)
            units += orderUnits
        }

        return WhatnotLivestreamMetrics(
            id: livestream.whatnotLivestreamId,
            title: livestream.title ?? DateFormatters.display.string(from: livestream.startedAt),
            startedAt: livestream.startedAt,
            endedAt: livestream.endedAt,
            durationHours: durationHours,
            revenue: revenue,
            profit: profit,
            orders: salesOrders.count,
            units: units,
            giveaways: giveawayCount,
            salesPerHour: durationHours > 0 ? revenue / durationHours : 0,
            profitPerHour: durationHours > 0 ? profit / durationHours : 0,
            unitsPerHour: durationHours > 0 ? Double(units) / durationHours : 0,
            viewsPerHour: durationHours > 0 && livestream.viewerCount > 0
                ? Double(livestream.viewerCount) / durationHours : nil,
            avgSellingPrice: units > 0 ? revenue / Double(units) : 0
        )
    }
}
