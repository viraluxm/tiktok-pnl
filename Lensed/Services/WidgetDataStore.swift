import Foundation

/// Shared storage for widget data. Uses App Group so both the main app and widget can access.
/// Call `saveMetrics` when dashboard metrics are loaded/updated.
enum WidgetDataStore {
    static let appGroupId = "group.com.lensed.Lensed"

    enum Keys {
        static let gmv = "widget_gmv"
        static let netProfit = "widget_netProfit"
        static let videosPosted = "widget_videosPosted"
        static let adSpend = "widget_adSpend"
        static let lastUpdated = "widget_lastUpdated"
    }

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupId)
    }

    /// Call this when dashboard metrics are loaded or recomputed (30-day period).
    static func saveMetrics(gmv: Double, netProfit: Double, videosPosted: Int, adSpend: Double) {
        defaults?.set(gmv, forKey: Keys.gmv)
        defaults?.set(netProfit, forKey: Keys.netProfit)
        defaults?.set(videosPosted, forKey: Keys.videosPosted)
        defaults?.set(adSpend, forKey: Keys.adSpend)
        defaults?.set(Date(), forKey: Keys.lastUpdated)
    }

    /// Widget reads these values.
    static func loadMetrics() -> (gmv: Double, netProfit: Double, videosPosted: Int, adSpend: Double)? {
        guard let d = defaults else { return nil }
        let gmv = d.double(forKey: Keys.gmv)
        let netProfit = d.double(forKey: Keys.netProfit)
        let videosPosted = d.integer(forKey: Keys.videosPosted)
        let adSpend = d.double(forKey: Keys.adSpend)
        guard d.object(forKey: Keys.gmv) != nil else { return nil }
        return (gmv, netProfit, videosPosted, adSpend)
    }
}
