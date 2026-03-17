import WidgetKit
import SwiftUI

@main
struct LensedWidgetsBundle: WidgetBundle {
    var body: some Widget {
        LensedSmallWidget()
        LensedLargeWidget()
    }
}
