import Foundation

struct TikTokProduct: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let name: String
    let variants: [TikTokProductVariant]?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case name
        case variants
        case createdAt = "created_at"
    }
}

struct TikTokProductVariant: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let sku: String?
}

struct TikTokEntry: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let productId: UUID
    let date: String
    let gmv: Double
    let videosPosted: Int
    let views: Int
    let shipping: Double
    let affiliate: Double
    let ads: Double
    let unitsSold: Int?
    let variantId: String?
    let source: String?
    let createdAt: Date
    let updatedAt: Date
    var product: TikTokProduct?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case productId = "product_id"
        case date, gmv
        case videosPosted = "videos_posted"
        case views, shipping, affiliate, ads
        case unitsSold = "units_sold"
        case variantId = "variant_id"
        case source
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case product
    }
}

struct TikTokProductCost: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let productId: UUID
    let variantId: String?
    let costPerUnit: Double
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case productId = "product_id"
        case variantId = "variant_id"
        case costPerUnit = "cost_per_unit"
        case updatedAt = "updated_at"
    }
}

struct TikTokSyncLog: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let syncType: String
    let status: String
    let entriesCreated: Int
    let entriesUpdated: Int
    let errorMessage: String?
    let startedAt: Date
    let completedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case syncType = "sync_type"
        case status
        case entriesCreated = "entries_created"
        case entriesUpdated = "entries_updated"
        case errorMessage = "error_message"
        case startedAt = "started_at"
        case completedAt = "completed_at"
    }
}
