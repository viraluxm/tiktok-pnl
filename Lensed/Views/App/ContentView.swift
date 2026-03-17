import SwiftUI

struct ContentView: View {
    @Environment(AuthViewModel.self) private var authVM

    var body: some View {
        Group {
            if authVM.isLoading && !authVM.isAuthenticated {
                // Splash / loading state
                ZStack {
                    Color.lensedBackground.ignoresSafeArea()
                    VStack(spacing: 16) {
                        Image(systemName: "chart.line.uptrend.xyaxis.circle.fill")
                            .font(.system(size: 72))
                            .foregroundStyle(Color.lensedAccent)
                        ProgressView()
                            .tint(Color.lensedAccent)
                    }
                }
            } else if authVM.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut(duration: 0.3), value: authVM.isAuthenticated)
    }
}
