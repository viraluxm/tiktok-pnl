import SwiftUI

struct WhatnotLivestreamListView: View {
    let livestreams: [WhatnotLivestreamMetrics]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Livestream Breakdown")
                .font(.headline)
                .foregroundStyle(Color.lensedTextPrimary)

            ForEach(livestreams) { ls in
                VStack(spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ls.title)
                                .font(.subheadline.bold())
                                .foregroundStyle(Color.lensedTextPrimary)
                                .lineLimit(1)

                            Text("\(ls.startedAt.displayString) • \(Fmt.hours(ls.durationHours))")
                                .font(.caption)
                                .foregroundStyle(Color.lensedTextMuted)
                        }

                        Spacer()

                        VStack(alignment: .trailing, spacing: 2) {
                            Text(Fmt.currencyWhole(ls.profit))
                                .font(.subheadline.bold())
                                .foregroundStyle(ls.profit >= 0 ? Color.lensedGreen : Color.lensedRed)

                            Text(Fmt.currencyWhole(ls.revenue))
                                .font(.caption)
                                .foregroundStyle(Color.lensedTextSecondary)
                        }
                    }

                    // Per-hour metrics row
                    HStack(spacing: 16) {
                        miniMetric(label: "$/hr", value: Fmt.perHour(ls.profitPerHour))
                        miniMetric(label: "Sales/hr", value: Fmt.perHour(ls.salesPerHour))
                        miniMetric(label: "Units", value: Fmt.int(ls.units))
                        miniMetric(label: "Orders", value: Fmt.int(ls.orders))
                    }
                }
                .padding(.vertical, 4)

                if ls.id != livestreams.last?.id {
                    Divider()
                        .overlay(Color.lensedCardBorder)
                }
            }
        }
        .lensedCard()
    }

    private func miniMetric(label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.caption.bold())
                .foregroundStyle(Color.lensedTextPrimary)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color.lensedTextMuted)
        }
        .frame(maxWidth: .infinity)
    }
}
