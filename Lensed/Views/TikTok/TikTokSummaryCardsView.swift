import SwiftUI

struct TikTokSummaryCardsView: View {
    let metrics: TikTokDashboardMetrics

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        VStack(spacing: 12) {
            // Hero row — GMV and Net Profit (taller, bigger numbers)
            LazyVGrid(columns: columns, spacing: 12) {
                MetricCardView(
                    title: "GMV (Sales)",
                    value: Fmt.currencyWhole(metrics.totalGMV),
                    icon: "dollarsign.circle",
                    isHero: true
                )

                MetricCardView(
                    title: "Net Profit",
                    value: Fmt.currencyWhole(metrics.totalNetProfit),
                    valueColor: metrics.totalNetProfit >= 0 ? .lensedGreen : .lensedRed,
                    icon: "chart.line.uptrend.xyaxis",
                    isHero: true
                )
            }

            // Middle row — Videos & Ad Spend
            LazyVGrid(columns: columns, spacing: 12) {
                MetricCardView(
                    title: "Videos Posted",
                    value: Fmt.int(metrics.totalVideos),
                    icon: "play.rectangle"
                )

                MetricCardView(
                    title: "Ad Spend",
                    value: Fmt.currencyWhole(metrics.totalAds),
                    icon: "megaphone"
                )
            }

            // Bottom row — Affiliate & Profit/Video (with subtle green tint)
            LazyVGrid(columns: columns, spacing: 12) {
                MetricCardView(
                    title: "Affiliate Fees",
                    value: Fmt.currencyWhole(metrics.totalAffiliate),
                    icon: "person.2"
                )

                MetricCardView(
                    title: "Profit/Video",
                    value: Fmt.currencyWhole(metrics.profitPerVideo),
                    valueColor: metrics.profitPerVideo >= 0 ? .lensedGreen : .lensedRed,
                    icon: "play.circle",
                    tintBackground: Color(red: 74/255, green: 255/255, blue: 139/255).opacity(0.04)
                )
            }
        }
    }
}
