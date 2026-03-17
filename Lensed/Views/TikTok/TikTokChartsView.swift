import SwiftUI
import Charts

struct TikTokChartsView: View {
    let chartData: TikTokChartData

    @State private var selectedLineChart: TikTokLineChartType = .profit

    enum TikTokLineChartType: String, CaseIterable {
        case profit = "Profit"
        case revenue = "Revenue"
        case both = "Both"
    }

    var body: some View {
        VStack(spacing: 16) {
            lineChartSection

            if !chartData.costBreakdown.isEmpty {
                costBreakdownSection
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
                    ForEach(TikTokLineChartType.allCases, id: \.self) { type in
                        Text(type.rawValue).tag(type)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
            }

            let data = lineChartData
            let gmvData = chartData.gmvByDate
            if data.isEmpty && (selectedLineChart != .both || gmvData.isEmpty) {
                Text("No data for selected period")
                    .font(.caption)
                    .foregroundStyle(Color.lensedTextMuted)
                    .frame(height: 200)
                    .frame(maxWidth: .infinity)
            } else {
                let xLabels = computeXLabels(from: selectedLineChart == .both ? gmvData : data)
                lineChartView(xLabels: xLabels, data: data, gmvData: gmvData)
                    .frame(height: 200)
            }
        }
        .lensedCard()
    }

    private var isSingleDayMode: Bool {
        chartData.profitByDate.count <= 1 && chartData.gmvByDate.count <= 1
    }

    @ViewBuilder
    private func lineChartView(xLabels: [XLabel], data: [TimeSeriesData], gmvData: [TimeSeriesData]) -> some View {
        if selectedLineChart == .both {
            Chart {
                if isSingleDayMode {
                    ForEach(chartData.profitByDate) { item in
                        PointMark(
                            x: .value("Date", item.date),
                            y: .value("Profit", item.value)
                        )
                        .foregroundStyle(by: .value("Metric", "Profit"))
                        .symbolSize(80)
                    }
                    ForEach(chartData.gmvByDate) { item in
                        PointMark(
                            x: .value("Date", item.date),
                            y: .value("Revenue", item.value)
                        )
                        .foregroundStyle(by: .value("Metric", "Revenue"))
                        .symbolSize(80)
                    }
                } else {
                    ForEach(chartData.profitByDate) { item in
                        LineMark(
                            x: .value("Date", item.date),
                            y: .value("Profit", item.value)
                        )
                        .foregroundStyle(by: .value("Metric", "Profit"))
                        .interpolationMethod(.catmullRom)
                    }
                    ForEach(chartData.gmvByDate) { item in
                        LineMark(
                            x: .value("Date", item.date),
                            y: .value("Revenue", item.value)
                        )
                        .foregroundStyle(by: .value("Metric", "Revenue"))
                        .interpolationMethod(.catmullRom)
                    }
                }
            }
            .chartForegroundStyleScale([
                "Profit": Color.blue,
                "Revenue": Color.red
            ])
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: xLabels.map(\.dateString)) { value in
                    AxisValueLabel {
                        if let dateStr = value.as(String.self),
                           let label = xLabels.first(where: { $0.dateString == dateStr }) {
                            Text(label.displayLabel)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Color.white.opacity(0.3))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                        .foregroundStyle(LensedTheme.cardBorderColor)
                    AxisValueLabel()
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.3))
                }
            }
            .chartPlotStyle { plot in
                plot.padding(.bottom, 8)
            }
        } else {
            let lineColor: Color = selectedLineChart == .profit ? .blue : .red
            singleOrMultiChart(data: data, lineColor: lineColor, xLabels: xLabels)
        }
    }

    @ViewBuilder
    private func singleOrMultiChart(data: [TimeSeriesData], lineColor: Color, xLabels: [XLabel]) -> some View {
        if isSingleDayMode {
            Chart(data) { item in
                PointMark(
                    x: .value("Date", item.date),
                    y: .value(selectedLineChart.rawValue, item.value)
                )
                .foregroundStyle(lineColor)
                .symbolSize(80)
            }
            .chartXAxis {
                AxisMarks(values: xLabels.map(\.dateString)) { value in
                    AxisValueLabel {
                        if let dateStr = value.as(String.self),
                           let label = xLabels.first(where: { $0.dateString == dateStr }) {
                            Text(label.displayLabel)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Color.white.opacity(0.3))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                        .foregroundStyle(LensedTheme.cardBorderColor)
                    AxisValueLabel()
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.3))
                }
            }
            .chartPlotStyle { plot in plot.padding(.bottom, 8) }
        } else {
            Chart(data) { item in
                LineMark(
                    x: .value("Date", item.date),
                    y: .value(selectedLineChart.rawValue, item.value)
                )
                .foregroundStyle(lineColor)
                .interpolationMethod(.catmullRom)

                AreaMark(
                    x: .value("Date", item.date),
                    y: .value(selectedLineChart.rawValue, item.value)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [lineColor.opacity(0.3), lineColor.opacity(0.0)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.catmullRom)
            }
            .chartXAxis {
                AxisMarks(values: xLabels.map(\.dateString)) { value in
                    AxisValueLabel {
                        if let dateStr = value.as(String.self),
                           let label = xLabels.first(where: { $0.dateString == dateStr }) {
                            Text(label.displayLabel)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Color.white.opacity(0.3))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                        .foregroundStyle(LensedTheme.cardBorderColor)
                    AxisValueLabel()
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.3))
                }
            }
            .chartPlotStyle { plot in plot.padding(.bottom, 8) }
        }
    }

    private var lineChartData: [TimeSeriesData] {
        switch selectedLineChart {
        case .profit: return chartData.profitByDate
        case .revenue: return chartData.gmvByDate
        case .both: return chartData.profitByDate
        }
    }

    // MARK: - X-Axis Label Computation

    private struct XLabel {
        let dateString: String
        let displayLabel: String
    }

    private func computeXLabels(from data: [TimeSeriesData]) -> [XLabel] {
        guard data.count > 1 else {
            return data.map { item in
                XLabel(dateString: item.date, displayLabel: formatDateLabel(item.date))
            }
        }

        let maxLabels = min(5, data.count)
        let step = max(1, (data.count - 1) / (maxLabels - 1))
        var indices: [Int] = []
        for i in stride(from: 0, to: data.count, by: step) {
            indices.append(i)
        }
        // Always include the last point
        if indices.last != data.count - 1 {
            indices.append(data.count - 1)
        }
        // Cap at 5
        if indices.count > 5 {
            indices = Array(indices.prefix(5))
        }

        return indices.map { i in
            XLabel(dateString: data[i].date, displayLabel: formatDateLabel(data[i].date))
        }
    }

    private func formatDateLabel(_ isoDate: String) -> String {
        guard let date = Date.fromISO(isoDate) else { return isoDate }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }

    // MARK: - Cost Breakdown Donut (FIX 4)

    private var costBreakdownSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Cost Breakdown")
                .font(.headline)
                .foregroundStyle(Color.lensedTextPrimary)

            HStack(alignment: .top, spacing: 16) {
                Chart(chartData.costBreakdown) { item in
                    SectorMark(
                        angle: .value("Amount", item.percentage),
                        innerRadius: .ratio(0.6),
                        angularInset: 1.5
                    )
                    .foregroundStyle(Color.fromHex(item.color))
                }
                .frame(width: 120, height: 120)

                let totalValue = chartData.costBreakdown.reduce(0) { $0 + $1.value }

                VStack(alignment: .leading, spacing: 14) {
                    ForEach(chartData.costBreakdown) { item in
                        let pct = totalValue > 0 ? (item.value / totalValue) * 100 : 0.0
                        HStack(alignment: .top, spacing: 10) {
                            Circle()
                                .fill(Color.fromHex(item.color))
                                .frame(width: 8, height: 8)
                                .padding(.top, 6)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.label)
                                    .font(.subheadline)
                                    .foregroundStyle(Color.lensedTextPrimary)
                                Text(Fmt.pct(pct))
                                    .font(.caption)
                                    .foregroundStyle(Color.lensedTextMuted)
                            }

                            Spacer()

                            Text(Fmt.currencyWhole(item.value))
                                .font(.caption)
                                .foregroundStyle(Color.lensedTextSecondary)
                        }
                    }
                }
            }
        }
        .lensedCard()
    }
}
