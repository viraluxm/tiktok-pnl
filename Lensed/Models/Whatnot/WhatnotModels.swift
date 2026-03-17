import Foundation

struct WhatnotConnection: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let accessToken: String
    let refreshToken: String?
    let tokenExpiresAt: Date?
    let refreshTokenExpiresAt: Date?
    let shopName: String?
    let sellerId: String?
    let isPremierShop: Bool
    let connectionStatus: String
    let connectedAt: Date
    let lastSyncedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenExpiresAt = "token_expires_at"
        case refreshTokenExpiresAt = "refresh_token_expires_at"
        case shopName = "shop_name"
        case sellerId = "seller_id"
        case isPremierShop = "is_premier_shop"
        case connectionStatus = "connection_status"
        case connectedAt = "connected_at"
        case lastSyncedAt = "last_synced_at"
    }
}

struct WhatnotOrder: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let whatnotOrderId: String
    let orderDate: Date
    let salePrice: Double
    let shippingCost: Double
    let whatnotFee: Double
    let units: Int
    let isGiveaway: Bool
    let productId: String?
    let productName: String?
    let variantId: String?
    let variantName: String?
    let listingId: String?
    let livestreamId: String?
    let buyerUsername: String?
    let orderStatus: String
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case whatnotOrderId = "whatnot_order_id"
        case orderDate = "order_date"
        case salePrice = "sale_price"
        case shippingCost = "shipping_cost"
        case whatnotFee = "whatnot_fee"
        case units
        case isGiveaway = "is_giveaway"
        case productId = "product_id"
        case productName = "product_name"
        case variantId = "variant_id"
        case variantName = "variant_name"
        case listingId = "listing_id"
        case livestreamId = "livestream_id"
        case buyerUsername = "buyer_username"
        case orderStatus = "order_status"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct WhatnotProduct: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let whatnotProductId: String
    let name: String
    let category: String?
    let variants: [WhatnotProductVariant]?
    let imageUrl: String?
    let status: String
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case whatnotProductId = "whatnot_product_id"
        case name, category, variants
        case imageUrl = "image_url"
        case status
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct WhatnotProductVariant: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let sku: String?
}

struct WhatnotCogs: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let whatnotProductId: String
    let variantId: String?
    let costPerUnit: Double
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case whatnotProductId = "whatnot_product_id"
        case variantId = "variant_id"
        case costPerUnit = "cost_per_unit"
        case updatedAt = "updated_at"
    }
}

struct WhatnotLivestream: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let whatnotLivestreamId: String
    let title: String?
    let startedAt: Date
    let endedAt: Date?
    let durationMinutes: Double?
    let viewerCount: Int
    let peakViewers: Int
    let status: String
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case whatnotLivestreamId = "whatnot_livestream_id"
        case title
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case durationMinutes = "duration_minutes"
        case viewerCount = "viewer_count"
        case peakViewers = "peak_viewers"
        case status
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct WhatnotSyncLog: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let syncType: String
    let status: String
    let ordersCreated: Int
    let ordersUpdated: Int
    let productsSynced: Int
    let livestreamsSynced: Int
    let errorMessage: String?
    let startedAt: Date
    let completedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case syncType = "sync_type"
        case status
        case ordersCreated = "orders_created"
        case ordersUpdated = "orders_updated"
        case productsSynced = "products_synced"
        case livestreamsSynced = "livestreams_synced"
        case errorMessage = "error_message"
        case startedAt = "started_at"
        case completedAt = "completed_at"
    }
}
