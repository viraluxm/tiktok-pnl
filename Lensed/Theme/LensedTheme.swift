import SwiftUI

enum LensedTheme {
    static let cardCornerRadius: CGFloat = 14
    static let cardBorderColor = Color.white.opacity(0.06)
}

// MARK: - View Modifiers

struct CardModifier: ViewModifier {
    var extraBackground: Color? = nil

    func body(content: Content) -> some View {
        content
            .padding()
            .background(
                ZStack {
                    Color.lensedCardBackground
                    if let extraBackground {
                        extraBackground
                    }
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: LensedTheme.cardCornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: LensedTheme.cardCornerRadius)
                    .stroke(LensedTheme.cardBorderColor, lineWidth: 1)
            )
    }
}

extension View {
    func lensedCard() -> some View {
        modifier(CardModifier())
    }

    func lensedCard(tint: Color) -> some View {
        modifier(CardModifier(extraBackground: tint))
    }
}
