import SwiftUI

struct DateRangePickerView: View {
    @Binding var dateFrom: Date?
    @Binding var dateTo: Date?
    @State private var showFromPicker = false
    @State private var showToPicker = false

    var body: some View {
        HStack(spacing: 12) {
            dateButton(
                label: "From",
                date: dateFrom,
                showPicker: $showFromPicker
            )

            Image(systemName: "arrow.right")
                .font(.caption)
                .foregroundStyle(Color.lensedTextMuted)

            dateButton(
                label: "To",
                date: dateTo,
                showPicker: $showToPicker
            )

            if dateFrom != nil || dateTo != nil {
                Button {
                    dateFrom = nil
                    dateTo = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.lensedTextMuted)
                }
            }
        }
        .sheet(isPresented: $showFromPicker) {
            datePickerSheet(title: "Start Date", selection: Binding(
                get: { dateFrom ?? Date() },
                set: { dateFrom = $0; showFromPicker = false }
            ))
        }
        .sheet(isPresented: $showToPicker) {
            datePickerSheet(title: "End Date", selection: Binding(
                get: { dateTo ?? Date() },
                set: { dateTo = $0; showToPicker = false }
            ))
        }
    }

    private func dateButton(label: String, date: Date?, showPicker: Binding<Bool>) -> some View {
        Button { showPicker.wrappedValue = true } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(Color.lensedTextMuted)
                Text(date?.shortDisplayString ?? "Any")
                    .font(.caption.bold())
                    .foregroundStyle(date != nil ? Color.lensedTextPrimary : Color.lensedTextMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.lensedCardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.lensedCardBorder, lineWidth: 1)
            )
        }
    }

    private func datePickerSheet(title: String, selection: Binding<Date>) -> some View {
        NavigationStack {
            DatePicker(title, selection: selection, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .padding()
                .background(Color.lensedBackground)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            showFromPicker = false
                            showToPicker = false
                        }
                    }
                }
        }
        .presentationDetents([.medium])
        .preferredColorScheme(.dark)
    }
}
