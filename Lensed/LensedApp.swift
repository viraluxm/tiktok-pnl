import SwiftUI
import WidgetKit

@main
struct LensedApp: App {
    @State private var authViewModel = AuthViewModel()

    init() {
        // Save initial metrics so widget shows data before user opens dashboard
        WidgetDataStore.saveMetrics(gmv: 52_340, netProfit: 16_750, videosPosted: 90, adSpend: 4_187)
        WidgetCenter.shared.reloadAllTimelines()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authViewModel)
                .preferredColorScheme(.dark)
        }
    }
}
