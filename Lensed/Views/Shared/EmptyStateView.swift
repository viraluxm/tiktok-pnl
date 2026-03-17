import SwiftUI

struct EmptyStateView: View {
    let icon: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 48))
                .foregroundStyle(Color.lensedTextMuted)

            Text(title)
                .font(.headline)
                .foregroundStyle(Color.lensedTextPrimary)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color.lensedTextSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(.subheadline.bold())
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                        .background(Color.lensedAccent)
                        .foregroundStyle(.black)
                        .clipShape(Capsule())
                }
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

struct LoadingView: View {
    var message: String = "Loading..."

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(Color.lensedAccent)
                .scaleEffect(1.2)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color.lensedTextSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
