import Foundation
import Supabase

final class WhatnotDataService: Sendable {
    private var client: SupabaseClient { SupabaseService.shared.client }

    func fetchOrders() async throws -> [WhatnotOrder] {
        try await client
            .from("whatnot_orders")
            .select()
            .order("order_date", ascending: false)
            .execute()
            .value
    }

    func fetchProducts() async throws -> [WhatnotProduct] {
        try await client
            .from("whatnot_products")
            .select()
            .order("name")
            .execute()
            .value
    }

    func fetchLivestreams() async throws -> [WhatnotLivestream] {
        try await client
            .from("whatnot_livestreams")
            .select()
            .order("started_at", ascending: false)
            .execute()
            .value
    }

    func fetchCogs() async throws -> [WhatnotCogs] {
        try await client
            .from("whatnot_cogs")
            .select()
            .execute()
            .value
    }

    func fetchConnection() async throws -> WhatnotConnection? {
        let connections: [WhatnotConnection] = try await client
            .from("whatnot_connections")
            .select()
            .limit(1)
            .execute()
            .value
        return connections.first
    }

    func fetchLatestSyncLog() async throws -> WhatnotSyncLog? {
        let logs: [WhatnotSyncLog] = try await client
            .from("whatnot_sync_logs")
            .select()
            .order("started_at", ascending: false)
            .limit(1)
            .execute()
            .value
        return logs.first
    }

    /// Build a costs map from COGS: "productId" or "productId-variantId" → costPerUnit
    func buildCostsMap(from cogs: [WhatnotCogs]) -> [String: Double] {
        var map: [String: Double] = [:]
        for c in cogs {
            if let variantId = c.variantId {
                map["\(c.whatnotProductId)-\(variantId)"] = c.costPerUnit
            } else {
                map[c.whatnotProductId] = c.costPerUnit
            }
        }
        return map
    }
}
