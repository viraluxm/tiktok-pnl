import SwiftUI

struct WhatnotSummaryCardsView: View {
    let metrics: WhatnotDashboardMetrics

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            MetricCardCompact(
                title: "Sales/Hr",
                value: Fmt.perHour(metrics.salesPerHour)
            )

            MetricCardCompact(
                title: "Profit/Hr",
                value: Fmt.perHour(metrics.profitPerHour),
                valueColor: metrics.profitPerHour >= 0 ? .lensedGreen : .lensedRed
            )

            MetricCardCompact(
                title: "Units/Hr",
                value: Fmt.int(metrics.unitsPerHour)
            )

            MetricCardCompact(
                title: "Revenue",
                value: Fmt.currencyWhole(metrics.totalRevenue)
            )

            MetricCardCompact(
                title: "Net Profit",
                value: Fmt.currencyWhole(metrics.totalProfit),
                valueColor: metrics.totalProfit >= 0 ? .lensedGreen : .lensedRed
            )

            MetricCardCompact(
                title: "AOV",
                value: Fmt.currencyWhole(metrics.avgOrderValue)
            )

            MetricCardCompact(
                title: "Orders",
                value: Fmt.int(metrics.totalOrdersExGiveaways)
            )

            MetricCardCompact(
                title: "Total Fees",
                value: Fmt.currencyWhole(metrics.totalFees)
            )

            MetricCardCompact(
                title: "Shipping",
                value: Fmt.currencyWhole(metrics.totalShipping)
            )
        }
    }
}
