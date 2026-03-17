import SwiftUI

// MARK: - This Month Forecast (inlined to avoid "Cannot find" build error)

private struct ThisMonthForecastView: View {
    let forecast: MonthlyForecast

    private static func monthRangeString(start: Date, end: Date) -> String {
        let cal = Calendar.current
        let startDay = cal.component(.day, from: start)
        let endDay = cal.component(.day, from: end)
        let f = DateFormatter()
        f.dateFormat = "MMMM yyyy"
        let monthYear = f.string(from: end)
        return "\(startDay)-\(endDay) \(monthYear)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.lensedAccent)
                        .frame(width: 6, height: 6)
                    Text("THIS MONTH (FORECAST)")
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.lensedTextPrimary)
                }
                Text("\(Self.monthRangeString(start: forecast.monthStart, end: forecast.monthEnd)) • based on last 30 days avg")
                    .font(.caption2)
                    .foregroundStyle(Color.lensedTextMuted)
            }

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 12) {
                forecastMetric("Sales", value: Fmt.currencyWhole(forecast.sales))
                forecastMetric("Units Sold", value: Fmt.int(forecast.unitsSold))
                forecastMetric("Videos Posted", value: Fmt.int(forecast.videosPosted), valueColor: .lensedAccent)
                forecastMetric("Affiliate Comm.", value: Fmt.currencyWhole(forecast.affiliateCommission), valueColor: .lensedYellow)
                forecastMetric("Adv. cost", value: Fmt.currencyWhole(forecast.adCost))
                forecastMetric("Est. payout", value: Fmt.currencyWhole(forecast.estimatedPayout))
            }

            Divider()
                .overlay(Color.lensedCardBorder)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Net profit")
                        .font(.caption)
                        .foregroundStyle(Color.lensedTextMuted)
                    Text(Fmt.currencyWhole(forecast.netProfit))
                        .font(.title3.bold())
                        .foregroundStyle(Color.lensedGreen)
                    Text("\(String(format: "%.1f", forecast.marginPercent))% margin")
                        .font(.caption2)
                        .foregroundStyle(Color.lensedTextMuted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text("\(Int(forecast.percentThroughMonth))% through month")
                        .font(.caption2)
                        .foregroundStyle(Color.lensedTextMuted)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.lensedCardBackground)
                                .frame(height: 8)
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.lensedAccent)
                                .frame(width: geo.size.width * CGFloat(forecast.percentThroughMonth / 100), height: 8)
                        }
                    }
                    .frame(width: 80, height: 8)
                }
            }
        }
        .padding()
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: LensedTheme.cardCornerRadius)
                    .fill(.ultraThinMaterial)
                    .environment(\.colorScheme, .dark)
                RoundedRectangle(cornerRadius: LensedTheme.cardCornerRadius)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.lensedAccent.opacity(0.15),
                                Color.lensedAccent.opacity(0.05)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: LensedTheme.cardCornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: LensedTheme.cardCornerRadius)
                .stroke(Color.lensedAccent.opacity(0.25), lineWidth: 1)
        )
    }

    private func forecastMetric(_ label: String, value: String, valueColor: Color = .lensedTextPrimary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color.lensedTextMuted)
            Text(value)
                .font(.subheadline.bold())
                .foregroundStyle(valueColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - TikTok Dashboard View

struct TikTokDashboardView: View {
    @State private var viewModel = TikTokDashboardViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.metrics.totalGMV == 0 {
                    LoadingView(message: "Loading dashboard...")
                } else {
                    dashboardContent
                }
            }
            .background(Color.lensedBackground)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    storeDropdown
                }
            }
            .task { await viewModel.loadData() }
            .refreshable { await viewModel.loadData() }
            .onChange(of: viewModel.selectedPeriod) { viewModel.onFilterChange() }
            .onChange(of: viewModel.filterDateFrom) { viewModel.onFilterChange() }
            .onChange(of: viewModel.filterDateTo) { viewModel.onFilterChange() }
            .onChange(of: viewModel.filterProductId) { viewModel.onFilterChange() }
        }
    }

    // MARK: - Store Dropdown

    private var storeDropdown: some View {
        Menu {
            Button {
                // Already selected
            } label: {
                Label(viewModel.selectedStore, systemImage: "checkmark")
            }

            Divider()

            Button {
                if let url = URL(string: "\(AppConfiguration.webAppURL)/connect") {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("Add Store", systemImage: "plus")
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "play.rectangle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.lensedAccent)
                    .frame(width: 28, height: 28)
                    .background(Color.lensedAccent.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                Text(viewModel.selectedStore)
                    .font(.headline)
                    .foregroundStyle(Color.lensedTextPrimary)

                // Connected dot
                Circle()
                    .fill(Color.lensedGreen)
                    .frame(width: 6, height: 6)

                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.lensedTextMuted)
            }
        }
    }

    // MARK: - Dashboard Content

    private var dashboardContent: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                // Sync status
                if let msg = viewModel.syncMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(Color.lensedTextSecondary)
                        .padding(.horizontal)
                }

                // Filters
                QuickFilterBar(
                    selectedPeriod: $viewModel.selectedPeriod,
                    dateFrom: $viewModel.filterDateFrom,
                    dateTo: $viewModel.filterDateTo
                )
                .padding(.horizontal)

                // Summary Cards
                TikTokSummaryCardsView(metrics: viewModel.metrics)
                    .padding(.horizontal)

                // This Month Forecast
                if let forecast = viewModel.monthlyForecast {
                    ThisMonthForecastView(forecast: forecast)
                        .padding(.horizontal)
                }

                // Charts
                TikTokChartsView(chartData: viewModel.chartData)
                    .padding(.horizontal)

                // Product breakdown
                if !viewModel.sortedProducts.isEmpty {
                    TikTokProductListView(products: viewModel.sortedProducts)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical)
            .padding(.bottom, 100)
        }
    }
}
