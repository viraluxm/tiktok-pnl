import SwiftUI

struct WhatnotDashboardView: View {
    @State private var viewModel = WhatnotDashboardViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.orders.isEmpty {
                    LoadingView(message: "Loading Whatnot data...")
                } else if viewModel.orders.isEmpty && !viewModel.isLoading {
                    EmptyStateView(
                        icon: "video",
                        title: "No Whatnot Data",
                        message: "Connect your Whatnot account on the web app and sync your data.",
                        actionTitle: "Sync Now",
                        action: { Task { await viewModel.sync() } }
                    )
                } else {
                    dashboardContent
                }
            }
            .background(Color.lensedBackground)
            .navigationTitle("Whatnot")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    syncButton
                }
            }
            .task { await viewModel.loadData() }
            .refreshable { await viewModel.loadData() }
            .onChange(of: viewModel.selectedPeriod) { viewModel.onFilterChange() }
            .onChange(of: viewModel.filterDateFrom) { viewModel.onFilterChange() }
            .onChange(of: viewModel.filterDateTo) { viewModel.onFilterChange() }
            .onChange(of: viewModel.filterLivestreamId) { viewModel.onFilterChange() }
        }
    }

    private var syncButton: some View {
        Button {
            Task { await viewModel.sync() }
        } label: {
            if viewModel.isSyncing {
                ProgressView()
                    .tint(Color.lensedAccent)
            } else {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundStyle(Color.lensedAccent)
            }
        }
        .disabled(viewModel.isSyncing)
    }

    private var dashboardContent: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                if let msg = viewModel.syncMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(Color.lensedTextSecondary)
                        .padding(.horizontal)
                }

                // Filters
                VStack(spacing: 12) {
                    QuickFilterBar(
                        selectedPeriod: $viewModel.selectedPeriod,
                        dateFrom: $viewModel.filterDateFrom,
                        dateTo: $viewModel.filterDateTo
                    )
                    if !viewModel.livestreams.isEmpty {
                        livestreamPicker
                    }
                }
                .padding(.horizontal)

                // Summary Cards
                WhatnotSummaryCardsView(metrics: viewModel.metrics)
                    .padding(.horizontal)

                // Charts
                WhatnotChartsView(chartData: viewModel.chartData)
                    .padding(.horizontal)

                // Livestream breakdown
                if !viewModel.livestreamMetrics.isEmpty {
                    WhatnotLivestreamListView(livestreams: viewModel.livestreamMetrics)
                        .padding(.horizontal)
                }

                // Product breakdown
                if !viewModel.sortedProducts.isEmpty {
                    WhatnotProductListView(products: viewModel.sortedProducts)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
    }

    private var livestreamPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip(label: "All Streams", isSelected: viewModel.filterLivestreamId == "all") {
                    viewModel.filterLivestreamId = "all"
                }
                ForEach(viewModel.livestreams) { ls in
                    filterChip(
                        label: ls.title ?? ls.startedAt.shortDisplayString,
                        isSelected: viewModel.filterLivestreamId == ls.whatnotLivestreamId
                    ) {
                        viewModel.filterLivestreamId = ls.whatnotLivestreamId
                    }
                }
            }
        }
    }

    private func filterChip(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isSelected ? Color.lensedAccent : Color.lensedCardBackground)
                .foregroundStyle(isSelected ? .black : Color.lensedTextSecondary)
                .clipShape(Capsule())
                .overlay(
                    Capsule().stroke(isSelected ? Color.clear : Color.lensedCardBorder, lineWidth: 1)
                )
        }
    }
}
