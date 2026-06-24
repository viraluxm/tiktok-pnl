import Foundation
import Supabase

final class TikTokDataService: Sendable {
    private var client: SupabaseClient { SupabaseService.shared.client }

    func fetchEntries() async throws -> [TikTokEntry] {
        let entries: [TikTokEntry] = try await client
            .from("entries")
            .select("*, product:products(*)")
            .order("date", ascending: false)
            .execute()
            .value
        return entries
    }

    func fetchProducts() async throws -> [TikTokProduct] {
        try await client
            .from("products")
            .select()
            .order("name")
            .execute()
            .value
    }

    func fetchProductCosts() async throws -> [TikTokProductCost] {
        try await client
            .from("product_costs")
            .select()
            .execute()
            .value
    }

    func fetchConnection() async throws -> TikTokConnection? {
        let connections: [TikTokConnection] = try await client
            .from("tiktok_connections")
            .select()
            .limit(1)
            .execute()
            .value
        return connections.first
    }

    func fetchLatestSyncLog() async throws -> TikTokSyncLog? {
        let logs: [TikTokSyncLog] = try await client
            .from("sync_logs")
            .select()
            .order("started_at", ascending: false)
            .limit(1)
            .execute()
            .value
        return logs.first
    }

    func fetchSyncedOrders() async throws -> [SyncedOrder] {
        let pageSize = 1000
        var allOrders: [SyncedOrder] = []
        var offset = 0

        while true {
            let page: [SyncedOrder] = try await client
                .from("synced_order_ids")
                .select("tiktok_product_id, sku_id, sku_name, gmv, shipping, affiliate, platform_fee, units, order_date")
                .range(from: offset, to: offset + pageSize - 1)
                .execute()
                .value
            allOrders.append(contentsOf: page)
            if page.count < pageSize { break }
            offset += pageSize
        }

        return allOrders
    }

    /// Build a costs map from product costs: "productId" or "productId-variantId" → costPerUnit
    func buildCostsMap(from costs: [TikTokProductCost]) -> [String: Double] {
        var map: [String: Double] = [:]
        for cost in costs {
            if let variantId = cost.variantId {
                map["\(cost.productId)-\(variantId)"] = cost.costPerUnit
            } else {
                map[cost.productId.uuidString] = cost.costPerUnit
            }
        }
        return map
    }
}
