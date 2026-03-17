import SwiftUI

struct MainTabView: View {
    @State private var selectedTab = 0

    init() {
        let inactive = UITabBarAppearance()
        inactive.configureWithOpaqueBackground()
        inactive.backgroundColor = UIColor(Color.lensedBackground)

        // Inactive icon/text at 0.35 opacity
        let normalAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: UIColor.white.withAlphaComponent(0.35)
        ]
        inactive.stackedLayoutAppearance.normal.titleTextAttributes = normalAttrs
        inactive.stackedLayoutAppearance.normal.iconColor = UIColor.white.withAlphaComponent(0.35)

        UITabBar.appearance().standardAppearance = inactive
        UITabBar.appearance().scrollEdgeAppearance = inactive
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            TikTokDashboardView()
                .tabItem {
                    Label("Dashboard", systemImage: "chart.bar.fill")
                }
                .tag(0)

            ProductsView()
                .tabItem {
                    Label("Products", systemImage: "shippingbox.fill")
                }
                .tag(1)

            AccountView()
                .tabItem {
                    Label("Account", systemImage: "person.circle.fill")
                }
                .tag(2)
        }
        .tint(Color.lensedAccent)
    }
}
