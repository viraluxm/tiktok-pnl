import SwiftUI

struct WhatnotProductListView: View {
    let products: [(name: String, data: ProductProfitData)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Product Breakdown")
                .font(.headline)
                .foregroundStyle(Color.lensedTextPrimary)

            ForEach(Array(products.enumerated()), id: \.offset) { _, product in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(product.name)
                            .font(.subheadline.bold())
                            .foregroundStyle(Color.lensedTextPrimary)
                            .lineLimit(1)

                        HStack(spacing: 8) {
                            Text("\(Fmt.int(product.data.unitsSold)) units")
                            Text("•")
                            Text("\(Fmt.int(product.data.orders)) orders")
                        }
                        .font(.caption)
                        .foregroundStyle(Color.lensedTextMuted)
                    }

                    Spacer()

                    VStack(alignment: .trailing, spacing: 2) {
                        Text(Fmt.currencyWhole(product.data.profit))
                            .font(.subheadline.bold())
                            .foregroundStyle(product.data.profit >= 0 ? Color.lensedGreen : Color.lensedRed)

                        Text("Rev: \(Fmt.currencyWhole(product.data.revenue))")
                            .font(.caption)
                            .foregroundStyle(Color.lensedTextMuted)
                    }
                }
                .padding(.vertical, 4)

                if product.name != products.last?.name {
                    Divider()
                        .overlay(Color.lensedCardBorder)
                }
            }
        }
        .lensedCard()
    }
}
