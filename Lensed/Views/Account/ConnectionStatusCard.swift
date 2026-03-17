import SwiftUI

struct ConnectionStatusCard: View {
    let platform: String
    let icon: String
    let isConnected: Bool
    var shopName: String?
    var lastSynced: Date?
    var accentColor: Color = .lensedAccent

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(isConnected ? accentColor : Color.lensedTextMuted)
                .frame(width: 36)

            VStack(alignment: .leading, spacing: 4) {
                Text(platform)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.lensedTextPrimary)

                if isConnected {
                    if let shopName {
                        Text(shopName)
                            .font(.caption)
                            .foregroundStyle(Color.lensedTextSecondary)
                    }
                    if let lastSynced {
                        Text("Last synced: \(lastSynced.displayString)")
                            .font(.caption2)
                            .foregroundStyle(Color.lensedTextMuted)
                    }
                } else {
                    Text("Not connected")
                        .font(.caption)
                        .foregroundStyle(Color.lensedTextMuted)
                }
            }

            Spacer()

            Circle()
                .fill(isConnected ? Color.lensedGreen : Color.lensedTextMuted.opacity(0.3))
                .frame(width: 10, height: 10)
        }
        .lensedCard()
    }
}
