import Foundation

struct WhatnotSyncResult: Codable, Sendable {
    let ordersCreated: Int
    let ordersUpdated: Int
    let productsSynced: Int
    let livestreamsSynced: Int
    let errors: [String]?

    enum CodingKeys: String, CodingKey {
        case ordersCreated = "orders_created"
        case ordersUpdated = "orders_updated"
        case productsSynced = "products_synced"
        case livestreamsSynced = "livestreams_synced"
        case errors
    }
}

final class WhatnotSyncService: Sendable {
    private let authService = AuthService()

    func sync() async throws -> WhatnotSyncResult {
        guard let token = await authService.accessToken else {
            throw SyncError.notAuthenticated
        }

        let url = AppConfiguration.webAppURL.appendingPathComponent("api/whatnot/sync")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw SyncError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw SyncError.serverError(statusCode: httpResponse.statusCode, message: body)
        }

        let decoder = JSONDecoder()
        let syncResponse = try decoder.decode(SyncResponse<WhatnotSyncResult>.self, from: data)

        if let summary = syncResponse.summary {
            return summary
        } else {
            throw SyncError.serverError(statusCode: 200, message: syncResponse.error ?? "Unknown error")
        }
    }
}
