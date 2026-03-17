import SwiftUI

struct MetricCardView: View {
    let title: String
    let value: String
    var subtitle: String?
    var valueColor: Color = .lensedTextPrimary
    var icon: String?
    var isHero: Bool = false
    var tintBackground: Color? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: isHero ? 10 : 6) {
            HStack(spacing: 4) {
                if let icon {
                    Image(systemName: icon)
                        .font(.caption2)
                        .foregroundStyle(Color.lensedTextMuted)
                }
                Text(title)
                    .font(.caption)
                    .foregroundStyle(Color.lensedTextSecondary)
            }

            Text(value)
                .font(isHero ? .system(size: 30, weight: .bold) : .title3.bold())
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(Color.lensedTextMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: isHero ? 90 : nil)
        .lensedCard(tint: tintBackground ?? .clear)
    }
}

struct MetricCardCompact: View {
    let title: String
    let value: String
    var valueColor: Color = .lensedTextPrimary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(Color.lensedTextSecondary)
            Text(value)
                .font(.subheadline.bold())
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lensedCard()
    }
}
