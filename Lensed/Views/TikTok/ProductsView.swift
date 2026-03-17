import SwiftUI

struct ProductsView: View {
    @State private var products: [TikTokProduct] = []
    @State private var productProfits: [String: ProductProfitData] = [:]
    @State private var isLoading = false
    @State private var searchText = ""

    private let dataService = TikTokDataService()

    var filteredProducts: [(name: String, data: ProductProfitData)] {
        let sorted = productProfits
            .sorted { $0.value.gmv > $1.value.gmv }
            .map { (name: $0.key, data: $0.value) }
        if searchText.isEmpty { return sorted }
        return sorted.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private func productFor(name: String) -> TikTokProduct? {
        products.first { $0.name == name }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && productProfits.isEmpty {
                    LoadingView(message: "Loading products...")
                } else if productProfits.isEmpty {
                    demoProductList
                } else {
                    productList(products: filteredProducts)
                }
            }
            .background(Color.lensedBackground)
            .navigationTitle("Products")
            .searchable(text: $searchText, prompt: "Search products...")
            .task { await loadData() }
            .refreshable { await loadData() }
        }
    }

    private func productList(products: [(name: String, data: ProductProfitData)]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(products.enumerated()), id: \.offset) { index, product in
                    productRow(name: product.name, data: product.data, rank: index + 1, product: productFor(name: product.name))

                    if index < products.count - 1 {
                        Divider()
                            .overlay(Color.lensedCardBorder)
                            .padding(.horizontal)
                    }
                }
            }
            .padding(.vertical, 8)
        }
    }

    private func productRow(name: String, data: ProductProfitData, rank: Int, product: TikTokProduct? = nil) -> some View {
        let hasVariants = (product?.variants?.isEmpty == false)
        return Group {
            if hasVariants, let product = product {
                ProductRowWithVariants(name: name, data: data, rank: rank, product: product)
            } else {
                ProductRowSimple(name: name, data: data, rank: rank)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }

    private func ProductRowSimple(name: String, data: ProductProfitData, rank: Int) -> some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.caption.bold())
                .foregroundStyle(rank <= 3 ? Color.lensedAccent : Color.lensedTextMuted)
                .frame(width: 24, height: 24)
                .background(
                    (rank <= 3 ? Color.lensedAccent : Color.lensedTextMuted).opacity(0.12)
                )
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(name)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.lensedTextPrimary)
                    .lineLimit(1)
                Text("\(Fmt.int(data.unitsSold)) units")
                    .font(.caption)
                    .foregroundStyle(Color.lensedTextMuted)
            }

            Spacer()

            Text(priceString(for: data))
                .font(.subheadline.bold())
                .foregroundStyle(Color.lensedTextPrimary)
        }
    }

    private func priceString(for data: ProductProfitData) -> String {
        Fmt.priceDisplay(
            min: data.priceMin,
            max: data.priceMax,
            fallbackAvg: data.unitsSold > 0 ? data.revenue / Double(data.unitsSold) : nil
        )
    }

    private func ProductRowWithVariants(name: String, data: ProductProfitData, rank: Int, product: TikTokProduct) -> some View {
        ProductRowExpandableView(name: name, data: data, rank: rank, product: product, priceString: priceString(for: data))
    }

    // MARK: - Demo products when no real data

    private var demoProductList: some View {
        let demoProducts: [(name: String, data: ProductProfitData)] = [
            ("Mystery Box - Premium", ProductProfitData(profit: 4280.50, gmv: 12450.00, unitsSold: 245, revenue: 12450.00, orders: 245, priceMin: 49, priceMax: 52)),
            ("Trading Cards - Booster Pack", ProductProfitData(profit: 3150.25, gmv: 9800.00, unitsSold: 520, revenue: 9800.00, orders: 480, priceMin: 18, priceMax: 20)),
            ("Collectible Figures - Anime", ProductProfitData(profit: 2890.00, gmv: 8900.00, unitsSold: 178, revenue: 8900.00, orders: 178, priceMin: 49, priceMax: 51)),
            ("Vintage Comics - Graded", ProductProfitData(profit: 2340.75, gmv: 7200.00, unitsSold: 45, revenue: 7200.00, orders: 45, priceMin: 158, priceMax: 162)),
            ("Sports Cards - Hobby Box", ProductProfitData(profit: 1560.00, gmv: 5100.00, unitsSold: 89, revenue: 5100.00, orders: 89, priceMin: 56, priceMax: 58)),
            ("Funko Pop - Exclusive", ProductProfitData(profit: 1120.00, gmv: 3400.00, unitsSold: 156, revenue: 3400.00, orders: 156, priceMin: 21, priceMax: 22)),
            ("Pokemon Cards - ETB", ProductProfitData(profit: 980.00, gmv: 2800.00, unitsSold: 67, revenue: 2800.00, orders: 67, priceMin: 41, priceMax: 42)),
            ("Sealed Product - Vintage", ProductProfitData(profit: 750.50, gmv: 2100.00, unitsSold: 12, revenue: 2100.00, orders: 12, priceMin: 173, priceMax: 178)),
        ]

        let filtered = searchText.isEmpty ? demoProducts : demoProducts.filter {
            $0.name.localizedCaseInsensitiveContains(searchText)
        }

        return productList(products: filtered)
    }

    // MARK: - Expandable Product Row (with variants)

    private struct ProductRowExpandableView: View {
        let name: String
        let data: ProductProfitData
        let rank: Int
        let product: TikTokProduct
        let priceString: String
        @State private var isExpanded = false

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: 12) {
                        Text("\(rank)")
                            .font(.caption.bold())
                            .foregroundStyle(rank <= 3 ? Color.lensedAccent : Color.lensedTextMuted)
                            .frame(width: 24, height: 24)
                            .background(
                                (rank <= 3 ? Color.lensedAccent : Color.lensedTextMuted).opacity(0.12)
                            )
                            .clipShape(Circle())

                        VStack(alignment: .leading, spacing: 4) {
                            Text(name)
                                .font(.subheadline.bold())
                                .foregroundStyle(Color.lensedTextPrimary)
                                .lineLimit(1)
                            Text("\(Fmt.int(data.unitsSold)) units")
                                .font(.caption)
                                .foregroundStyle(Color.lensedTextMuted)
                        }

                        Spacer()

                        HStack(spacing: 6) {
                            Text(priceString)
                                .font(.subheadline.bold())
                                .foregroundStyle(Color.lensedTextPrimary)
                            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                                .font(.caption.bold())
                                .foregroundStyle(Color.lensedTextMuted)
                        }
                    }
                }
                .buttonStyle(.plain)

                if isExpanded {
                    let variantNames = !data.variantUnits.isEmpty
                        ? Array(data.variantUnits.keys.sorted())
                        : (product.variants?.map(\.name) ?? [])
                    if !variantNames.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Divider()
                                .overlay(Color.lensedCardBorder)
                                .padding(.leading, 36)
                            ForEach(variantNames, id: \.self) { variantName in
                                HStack {
                                    Text(variantName)
                                        .font(.caption)
                                        .foregroundStyle(Color.lensedTextSecondary)
                                    Spacer()
                                    Text("\(Fmt.int(data.variantUnits[variantName] ?? 0)) units")
                                        .font(.caption)
                                        .foregroundStyle(Color.lensedTextMuted)
                                }
                                .padding(.leading, 36)
                            }
                        }
                        .padding(.top, 4)
                        .padding(.bottom, 4)
                    }
                }
            }
        }
    }

    private func loadData() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let entries = try await dataService.fetchEntries()
            let costs = try await dataService.fetchProductCosts()
            let costsMap = dataService.buildCostsMap(from: costs)

            let metrics = TikTokCalculations.computeMetrics(entries, costsMap: costsMap)
            productProfits = metrics.productProfits
            products = try await dataService.fetchProducts()
        } catch {
            // Will show demo products
        }
    }
}
