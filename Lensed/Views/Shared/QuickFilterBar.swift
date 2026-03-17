import SwiftUI

struct QuickFilterBar: View {
    @Binding var selectedPeriod: QuickFilterPeriod
    @Binding var dateFrom: Date?
    @Binding var dateTo: Date?
    /// Optional: ISO date strings (yyyy-MM-dd) that have data; used to gray out empty dates when supported
    var datesWithData: Set<String>? = nil
    @State private var showDateSheet = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(QuickFilterPeriod.presetCases, id: \.self) { period in
                Button {
                    selectedPeriod = period
                    dateFrom = nil
                    dateTo = nil
                } label: {
                    Text(period.rawValue)
                        .font(.caption.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            selectedPeriod == period
                                ? Color.lensedAccent
                                : Color.lensedCardBackground
                        )
                        .foregroundStyle(
                            selectedPeriod == period
                                ? .black
                                : Color.lensedTextSecondary
                        )
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(
                                    selectedPeriod == period
                                        ? Color.clear
                                        : LensedTheme.cardBorderColor,
                                    lineWidth: 1
                                )
                        )
                }
            }

            // Calendar icon button for custom date range
            Button {
                showDateSheet = true
            } label: {
                Image(systemName: "calendar")
                    .font(.system(size: 14))
                    .foregroundStyle(
                        hasCustomDates ? Color.lensedAccent : Color.white.opacity(0.3)
                    )
                    .frame(width: 34, height: 34)
                    .background(
                        hasCustomDates ? Color.lensedAccent.opacity(0.15) : Color.lensedCardBackground
                    )
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(
                                hasCustomDates ? Color.lensedAccent.opacity(0.3) : LensedTheme.cardBorderColor,
                                lineWidth: 1
                            )
                    )
            }

            Spacer()
        }
        .sheet(isPresented: $showDateSheet) {
            DateRangeSheet(dateFrom: $dateFrom, dateTo: $dateTo, selectedPeriod: $selectedPeriod, datesWithData: datesWithData)
        }
    }

    private var hasCustomDates: Bool {
        dateFrom != nil || dateTo != nil
    }
}

// MARK: - Date Range Sheet

private struct DateRangeSheet: View {
    @Binding var dateFrom: Date?
    @Binding var dateTo: Date?
    @Binding var selectedPeriod: QuickFilterPeriod
    /// Optional: dates that have data (for graying out empty dates). Pass from view model when available.
    var datesWithData: Set<String>?
    @Environment(\.dismiss) private var dismiss

    @State private var tempFrom: Date = Date().addingTimeInterval(-30 * 86400)
    @State private var tempTo: Date = Date()
    @State private var selectedField: DateField = .from

    private var selectableDateRange: ClosedRange<Date> {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let oneYearAgo = cal.date(byAdding: .year, value: -1, to: today)!
        return oneYearAgo...today
    }

    enum DateField { case from, to }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Header: Custom Range with clear From/To labels
                VStack(alignment: .leading, spacing: 12) {
                    Text("Custom Range")
                        .font(.headline)
                        .foregroundStyle(Color.lensedTextPrimary)

                    HStack(spacing: 12) {
                        dateFieldButton(label: "From", date: tempFrom, isSelected: selectedField == .from) {
                            selectedField = .from
                        }

                        Image(systemName: "arrow.right")
                            .font(.caption)
                            .foregroundStyle(Color.lensedTextMuted)

                        dateFieldButton(label: "To", date: tempTo, isSelected: selectedField == .to) {
                            selectedField = .to
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 12)

                Divider()
                    .overlay(Color.lensedCardBorder)
                    .padding(.horizontal)

                // Calendar picker - restrict to today; future dates are grayed out
                DatePicker(
                    "",
                    selection: selectedField == .from ? $tempFrom : $tempTo,
                    in: selectableDateRange,
                    displayedComponents: .date
                )
                .datePickerStyle(.graphical)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

                Spacer()
            }
            .background(Color.lensedBackground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Clear") {
                        dateFrom = nil
                        dateTo = nil
                        selectedPeriod = .thirtyDays
                        dismiss()
                    }
                    .foregroundStyle(Color.lensedTextMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        let cal = Calendar.current
                        var from = cal.startOfDay(for: tempFrom)
                        var to = cal.startOfDay(for: tempTo)
                        let range = selectableDateRange
                        if from > range.upperBound { from = range.upperBound }
                        if to > range.upperBound { to = range.upperBound }
                        if from > to { to = from }
                        dateFrom = from
                        dateTo = to
                        selectedPeriod = .custom
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.lensedAccent)
                }
            }
            .onAppear {
                if let from = dateFrom { tempFrom = from }
                if let to = dateTo { tempTo = to }
                // Clamp to valid range if either exceeds
                let range = selectableDateRange
                if tempFrom > range.upperBound { tempFrom = range.upperBound }
                if tempTo > range.upperBound { tempTo = range.upperBound }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private func dateFieldButton(label: String, date: Date, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(Color.lensedTextMuted)
                Text(date.shortDisplayString)
                    .font(.subheadline.bold())
                    .foregroundStyle(isSelected ? Color.lensedAccent : Color.lensedTextPrimary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.lensedCardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(isSelected ? Color.lensedAccent.opacity(0.5) : LensedTheme.cardBorderColor, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}
