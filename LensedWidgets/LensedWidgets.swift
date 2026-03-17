import WidgetKit
import SwiftUI

// MARK: - Shared formatting (widget can't import main app modules)

private enum WidgetFmt {
    static func currencyWhole(_ n: Double) -> String {
        guard !n.isNaN else { return "$0" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_US")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: Int(round(n)))) ?? "$0"
    }
}

// MARK: - Data

struct WidgetMetrics {
    let gmv: Double
    let netProfit: Double
    let videosPosted: Int
    let adSpend: Double

    static let preview = WidgetMetrics(gmv: 55_385, netProfit: 18_419, videosPosted: 90, adSpend: 4_431)

    static func load() -> WidgetMetrics? {
        guard let d = UserDefaults(suiteName: "group.com.lensed.Lensed"),
              d.object(forKey: "widget_gmv") != nil else { return nil }
        return WidgetMetrics(
            gmv: d.double(forKey: "widget_gmv"),
            netProfit: d.double(forKey: "widget_netProfit"),
            videosPosted: d.integer(forKey: "widget_videosPosted"),
            adSpend: d.double(forKey: "widget_adSpend")
        )
    }
}

// MARK: - Glass effect (liquid glass on iOS 26+, material fallback on older)

private struct GlassBackgroundModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOSApplicationExtension 26.0, *) {
            content
                .background {
                    Color.clear
                        .glassEffect(in: .rect(cornerRadius: 12))
                }
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

// MARK: - Colors (match main app dark theme)

private extension Color {
    static let widgetBg = Color(red: 0.04, green: 0.04, blue: 0.04)
    static let widgetCard = Color(red: 0.09, green: 0.09, blue: 0.09)
    static let widgetText = Color.white
    static let widgetMuted = Color.white.opacity(0.6)
    static let widgetAccent = Color(red: 0.41, green: 0.79, blue: 0.82)  // lensedAccent
    static let widgetGreen = Color(red: 0.13, green: 0.77, blue: 0.37)  // lensedGreen
}

// MARK: - Small Widget (GMV + Net Profit)

struct LensedSmallWidget: Widget {
    let kind: String = "LensedSmallWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LensedWidgetProvider()) { entry in
            LensedSmallWidgetView(entry: entry)
        }
        .configurationDisplayName("Lensed Overview")
        .description("GMV and Net Profit at a glance.")
        .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryInline])
        .contentMarginsDisabled()
    }
}

struct LensedSmallWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: LensedWidgetEntry

    var body: some View {
        switch family {
        case .accessoryRectangular:
            accessoryRectangularView
        case .accessoryInline:
            accessoryInlineView
        default:
            homeScreenView
        }
    }

    private var homeScreenView: some View {
        ZStack {
            Color.widgetBg
            if let m = entry.metrics {
                VStack(alignment: .leading, spacing: 8) {
                    Spacer().frame(height: 26)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sales")
                            .font(.caption)
                            .foregroundStyle(Color.widgetMuted)
                        Text(WidgetFmt.currencyWhole(m.gmv))
                            .font(.title.bold())
                            .foregroundStyle(Color.widgetText)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Profit")
                            .font(.caption)
                            .foregroundStyle(Color.widgetMuted)
                        Text(WidgetFmt.currencyWhole(m.netProfit))
                            .font(.title.bold())
                            .foregroundStyle(Color.widgetGreen)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .padding()
                .overlay(alignment: .topTrailing) {
                    Image("Logo")
                        .resizable()
                        .renderingMode(.original)
                        .scaledToFit()
                        .frame(width: 28, height: 28)
                        .padding(10)
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "chart.bar.fill")
                        .font(.title)
                        .foregroundStyle(Color.widgetMuted)
                    Text("Open Lensed to see your metrics")
                        .font(.caption)
                        .foregroundStyle(Color.widgetMuted)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
        }
        .containerBackground(Color.widgetBg, for: .widget)
    }

    @ViewBuilder private var accessoryRectangularView: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let m = entry.metrics {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sales \(WidgetFmt.currencyWhole(m.gmv))")
                        .font(.caption)
                    Text("Profit \(WidgetFmt.currencyWhole(m.netProfit))")
                        .font(.caption)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                Text("Open Lensed to see metrics")
                    .font(.caption)
            }
        }
    }

    @ViewBuilder private var accessoryInlineView: some View {
        if let m = entry.metrics {
            Text("Sales \(WidgetFmt.currencyWhole(m.gmv)) · Profit \(WidgetFmt.currencyWhole(m.netProfit))")
        } else {
            Text("Open Lensed for metrics")
        }
    }
}

// MARK: - Large Widget (GMV, Net Profit, Videos, Ad Spend)

struct LensedLargeWidget: Widget {
    let kind: String = "LensedLargeWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LensedWidgetProvider()) { entry in
            LensedLargeWidgetView(entry: entry)
        }
        .configurationDisplayName("Lensed Dashboard")
        .description("GMV, Net Profit, Videos Posted, and Ad Spend.")
        .supportedFamilies([.systemMedium, .accessoryRectangular, .accessoryInline])
        .contentMarginsDisabled()
    }
}

struct LensedLargeWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: LensedWidgetEntry

    var body: some View {
        switch family {
        case .accessoryRectangular:
            largeAccessoryRectangularView
        case .accessoryInline:
            largeAccessoryInlineView
        default:
            largeHomeScreenView
        }
    }

    private var largeHomeScreenView: some View {
        ZStack {
            Color.widgetBg
            if let m = entry.metrics {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image("Logo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 32, height: 32)
                            .padding(.leading, 4)
                            .padding(.top, 12)
                        Spacer()
                    }
                    HStack(spacing: 12) {
                        metricRow(label: "Sales", value: WidgetFmt.currencyWhole(m.gmv), color: .widgetText)
                        metricRow(label: "Profit", value: WidgetFmt.currencyWhole(m.netProfit), color: .widgetGreen)
                    }
                    HStack(spacing: 12) {
                        metricRow(label: "Videos Posted", value: "\(m.videosPosted)", color: .widgetAccent)
                        metricRow(label: "Ad Spend", value: WidgetFmt.currencyWhole(m.adSpend), color: .widgetText)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 14)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "chart.bar.fill")
                        .font(.title)
                        .foregroundStyle(Color.widgetMuted)
                    Text("Open Lensed to see your metrics")
                        .font(.caption)
                        .foregroundStyle(Color.widgetMuted)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
        }
        .containerBackground(Color.widgetBg, for: .widget)
    }

    @ViewBuilder private var largeAccessoryRectangularView: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let m = entry.metrics {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sales \(WidgetFmt.currencyWhole(m.gmv))")
                        .font(.caption)
                    Text("Profit \(WidgetFmt.currencyWhole(m.netProfit))")
                        .font(.caption)
                    Text("Videos \(m.videosPosted) · Ads \(WidgetFmt.currencyWhole(m.adSpend))")
                        .font(.caption2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                Text("Open Lensed to see metrics")
                    .font(.caption)
            }
        }
    }

    @ViewBuilder private var largeAccessoryInlineView: some View {
        if let m = entry.metrics {
            Text("Sales \(WidgetFmt.currencyWhole(m.gmv)) · Profit \(WidgetFmt.currencyWhole(m.netProfit))")
        } else {
            Text("Open Lensed for metrics")
        }
    }

    private func metricRow(label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Color.widgetMuted)
            Text(value)
                .font(.title3.bold())
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Provider & Entry

struct LensedWidgetEntry: TimelineEntry {
    let date: Date
    let metrics: WidgetMetrics?
}

struct LensedWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> LensedWidgetEntry {
        LensedWidgetEntry(date: Date(), metrics: WidgetMetrics.preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (LensedWidgetEntry) -> Void) {
        let metrics = WidgetMetrics.load() ?? WidgetMetrics.preview
        completion(LensedWidgetEntry(date: Date(), metrics: metrics))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LensedWidgetEntry>) -> Void) {
        let metrics = WidgetMetrics.load() ?? WidgetMetrics.preview
        let entry = LensedWidgetEntry(date: Date(), metrics: metrics)
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 60, to: Date()) ?? Date()
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }
}
