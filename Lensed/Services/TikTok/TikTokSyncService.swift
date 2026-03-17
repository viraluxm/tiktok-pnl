import Foundation

struct TikTokSyncResult: Codable, Sendable {
    let entriesCreated: Int
    let entriesUpdated: Int

    enum CodingKeys: String, CodingKey {
        case entriesCreated = "entries_created"
        case entriesUpdated = "entries_updated"
    }
}

struct SyncResponse<T: Codable>: Codable {
    let success: Bool
    let summary: T?
    let error: String?
}

final class TikTokSyncService: Sendable {
    private let authService = AuthService()

    func sync() async throws -> TikTokSyncResult {
        guard let token = await authService.accessToken else {
            throw SyncError.notAuthenticated
        }

        let url = AppConfiguration.webAppURL.appendingPathComponent("api/tiktok/sync")
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
        let syncResponse = try decoder.decode(SyncResponse<TikTokSyncResult>.self, from: data)

        if let summary = syncResponse.summary {
            return summary
        } else {
            throw SyncError.serverError(statusCode: 200, message: syncResponse.error ?? "Unknown error")
        }
    }
}

enum SyncError: LocalizedError {
    case notAuthenticated
    case invalidResponse
    case serverError(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Not authenticated. Please sign in again."
        case .invalidResponse:
            return "Invalid response from server."
        case .serverError(let code, let message):
            return "Server error (\(code)): \(message)"
        }
    }
}
