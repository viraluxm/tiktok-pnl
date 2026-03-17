import Foundation

struct TikTokConnection: Codable, Identifiable, Sendable {
    let id: UUID
    let userId: UUID
    let accessToken: String
    let refreshToken: String?
    let tokenExpiresAt: Date?
    let advertiserIds: [String]?
    let shopCipher: String?
    let shopName: String?
    let connectedAt: Date
    let lastSyncedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenExpiresAt = "token_expires_at"
        case advertiserIds = "advertiser_ids"
        case shopCipher = "shop_cipher"
        case shopName = "shop_name"
        case connectedAt = "connected_at"
        case lastSyncedAt = "last_synced_at"
    }
}
