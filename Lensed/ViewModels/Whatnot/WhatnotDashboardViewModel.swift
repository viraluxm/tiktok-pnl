import Foundation
import Observation

@Observable
@MainActor
final class WhatnotDashboardViewModel {
    var orders: [WhatnotOrder] = []
    var products: [WhatnotProduct] = []
    var livestreams: [WhatnotLivestream] = []
    var costsMap: CostsMap = [:]
    var connection: WhatnotConnection?
    var latestSyncLog: WhatnotSyncLog?

    var metrics = WhatnotDashboardMetrics()
    var chartData = WhatnotChartData()
    var livestreamMetrics: [WhatnotLivestreamMetrics] = []

    var selectedPeriod: QuickFilterPeriod = .thirtyDays
    var filterDateFrom: Date?
    var filterDateTo: Date?
    var filterLivestreamId: String = "all"

    var isLoading = false
    var isSyncing = false
    var errorMessage: String?
    var syncMessage: String?

    var isPremier: Bool { connection?.isPremierShop ?? false }

    private let dataService = WhatnotDataService()
    private let syncService = WhatnotSyncService()

    var filteredOrders: [WhatnotOrder] {
        orders.filter { order in
            if let from = effectiveDateFrom {
                guard order.orderDate >= from else { return false }
            }
            if let to = effectiveDateTo {
                guard order.orderDate <= to else { return false }
            }
            if filterLivestreamId != "all" {
                guard order.livestreamId == filterLivestreamId else { return false }
            }
            return true
        }
    }

    var filteredLivestreams: [WhatnotLivestream] {
        livestreams.filter { ls in
            if let from = effectiveDateFrom {
                guard ls.startedAt >= from else { return false }
            }
            if let to = effectiveDateTo {
                guard ls.startedAt <= to else { return false }
            }
            if filterLivestreamId != "all" {
                guard ls.whatnotLivestreamId == filterLivestreamId else { return false }
            }
            return true
        }
    }

    private var effectiveDateFrom: Date? {
        if let offset = selectedPeriod.dateOffset {
            return Calendar.current.date(byAdding: .day, value: offset, to: Date())
        }
        return filterDateFrom
    }

    private var effectiveDateTo: Date? {
        guard let offset = selectedPeriod.dateOffset else { return filterDateTo }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let from = cal.date(byAdding: .day, value: offset, to: today)!
        let toDay = selectedPeriod.isSingleDay ? from : today
        return cal.date(byAdding: .day, value: 1, to: toDay)?.addingTimeInterval(-1)
    }

    var sortedProducts: [(name: String, data: ProductProfitData)] {
        metrics.productProfits
            .sorted { $0.value.revenue > $1.value.revenue }
            .map { (name: $0.key, data: $0.value) }
    }

    func loadData() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            async let ordersTask = dataService.fetchOrders()
            async let productsTask = dataService.fetchProducts()
            async let livestreamsTask = dataService.fetchLivestreams()
            async let cogsTask = dataService.fetchCogs()
            async let connectionTask = dataService.fetchConnection()
            async let syncLogTask = dataService.fetchLatestSyncLog()

            let (fetchedOrders, fetchedProducts, fetchedLivestreams, fetchedCogs, fetchedConnection, fetchedSyncLog) =
                try await (ordersTask, productsTask, livestreamsTask, cogsTask, connectionTask, syncLogTask)

            orders = fetchedOrders
            products = fetchedProducts
            livestreams = fetchedLivestreams
            costsMap = dataService.buildCostsMap(from: fetchedCogs)
            connection = fetchedConnection
            latestSyncLog = fetchedSyncLog

            recomputeMetrics()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func recomputeMetrics() {
        let filtered = filteredOrders
        let filteredLS = filteredLivestreams
        metrics = WhatnotCalculations.computeMetrics(
            orders: filtered, livestreams: filteredLS,
            costsMap: costsMap, isPremier: isPremier
        )
        chartData = WhatnotCalculations.computeChartData(
            orders: filtered, livestreams: filteredLS,
            costsMap: costsMap, isPremier: isPremier
        )
        livestreamMetrics = filteredLS.map { ls in
            WhatnotCalculations.computeLivestreamMetrics(
                livestream: ls, orders: filtered,
                costsMap: costsMap, isPremier: isPremier
            )
        }
    }

    func sync() async {
        isSyncing = true
        syncMessage = nil
        defer { isSyncing = false }

        do {
            let result = try await syncService.sync()
            syncMessage = "Synced: \(result.ordersCreated) orders, \(result.productsSynced) products"
            await loadData()
        } catch {
            syncMessage = "Sync failed: \(error.localizedDescription)"
        }
    }

    func onFilterChange() {
        recomputeMetrics()
    }
}
