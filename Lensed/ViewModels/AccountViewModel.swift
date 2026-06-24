import Foundation
import Observation

@Observable
@MainActor
final class AccountViewModel {
    var profile: Profile?
    var tiktokConnection: TikTokConnection?
    var whatnotConnection: WhatnotConnection?
    var isLoading = false
    var errorMessage: String?

    private let tiktokDataService = TikTokDataService()
    private let whatnotDataService = WhatnotDataService()

    var userEmail: String {
        profile?.email ?? "Unknown"
    }

    var displayName: String {
        profile?.displayName ?? profile?.email ?? "User"
    }

    var tiktokConnected: Bool {
        tiktokConnection != nil
    }

    var whatnotConnected: Bool {
        whatnotConnection != nil
    }

    var tiktokShopName: String? {
        tiktokConnection?.shopName
    }

    var whatnotShopName: String? {
        whatnotConnection?.shopName
    }

    var tiktokLastSynced: Date? {
        tiktokConnection?.lastSyncedAt
    }

    var whatnotLastSynced: Date? {
        whatnotConnection?.lastSyncedAt
    }

    func loadData() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let client = SupabaseService.shared.client

            let profiles: [Profile] = try await client
                .from("profiles")
                .select()
                .limit(1)
                .execute()
                .value
            profile = profiles.first

            tiktokConnection = try await tiktokDataService.fetchConnection()
        } catch {
            errorMessage = error.localizedDescription
        }

        // Whatnot tables may not exist yet — fetch separately so it can't break TikTok
        do {
            whatnotConnection = try await whatnotDataService.fetchConnection()
        } catch {
            whatnotConnection = nil
        }
    }
}
