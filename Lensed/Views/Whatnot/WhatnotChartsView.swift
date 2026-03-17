import SwiftUI
import Charts

struct WhatnotChartsView: View {
    let chartData: WhatnotChartData

    @State private var selectedLineChart: WhatnotLineChartType = .profit

    enum WhatnotLineChartType: String, CaseIterable {
        case profit = "Profit"
        case revenue = "Revenue"
        case salesPerHour = "$/Hr"
    }

    var body: some View {
        VStack(spacing: 16) {
            lineChartSection

            if !chartData.feeBreakdown.isEmpty {
                feeBreakdownSection
            }
        }
    }

    // MARK: - Line Chart

    private var lineChartSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Trend")
                    .font(.headline)
                    .foregroundStyle(Color.lensedTextPrimary)
                Spacer()
                Picker("Chart", selection: $selectedLineChart) {
                    ForEach(WhatnotLineChartType.allCases, id: \.self) { type in
                        Text(type.rawValue).tag(type)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
            }

            let data = lineChartData
            if data.isEmpty {
                Text("No data for selected period")
                    .font(.caption)
                    .foregroundStyle(Color.lensedTextMuted)
                    .frame(height: 200)
                    .frame(maxWidth: .infinity)
            } else {
                Chart(data) { item in
                    LineMark(
                        x: .value("Date", item.date),
                        y: .value(selectedLineChart.rawValue, item.value)
                    )
                    .foregroundStyle(Color.lensedAccent)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Date", item.date),
                        y: .value(selectedLineChart.rawValue, item.value)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Color.lensedAccent.opacity(0.3), Color.lensedAccent.opacity(0.0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                        AxisValueLabel()
                            .foregroundStyle(Color.lensedTextMuted)
                    }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                            .foregroundStyle(Color.lensedCardBorder)
                        AxisValueLabel()
                            .foregroundStyle(Color.lensedTextMuted)
                    }
                }
                .frame(height: 200)
            }
        }
        .lensedCard()
    }

    private var lineChartData: [TimeSeriesData] {
        switch selectedLineChart {
        case .profit: return chartData.profitByDate
        case .revenue: return chartData.revenueByDate
        case .salesPerHour: return chartData.salesPerHourByDate
        }
    }

    // MARK: - Fee Breakdown Donut

    private var feeBreakdownSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Fee Breakdown")
                .font(.headline)
                .foregroundStyle(Color.lensedTextPrimary)

            HStack(spacing: 20) {
                Chart(chartData.feeBreakdown) { item in
                    SectorMark(
                        angle: .value("Amount", item.percentage),
                        innerRadius: .ratio(0.6),
                        angularInset: 1.5
                    )
                    .foregroundStyle(Color.fromHex(item.color))
                }
                .frame(width: 120, height: 120)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(chartData.feeBreakdown) { item in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(Color.fromHex(item.color))
                                .frame(width: 8, height: 8)
                            Text(item.label)
                                .font(.caption2)
                                .foregroundStyle(Color.lensedTextSecondary)
                            Spacer()
                            Text(Fmt.currencyWhole(item.value))
                                .font(.caption2.bold())
                                .foregroundStyle(Color.lensedTextPrimary)
                        }
                    }
                }
            }
        }
        .lensedCard()
    }
}
