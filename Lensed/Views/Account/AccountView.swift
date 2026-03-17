import SwiftUI

struct AccountView: View {
    @Environment(AuthViewModel.self) private var authVM
    @State private var viewModel = AccountViewModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    // Profile card
                    profileSection

                    // Connected Stores
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Connected Stores")
                            .font(.headline)
                            .foregroundStyle(Color.lensedTextPrimary)

                        VStack(spacing: 0) {
                            if let name = viewModel.tiktokShopName {
                                connectedStoreRow(name: name, icon: "play.rectangle.fill")
                            }
                            if let name = viewModel.whatnotShopName {
                                if viewModel.tiktokShopName != nil {
                                    Divider().overlay(Color.lensedCardBorder).padding(.horizontal)
                                }
                                connectedStoreRow(name: name, icon: "video.fill")
                            }
                            Divider().overlay(Color.lensedCardBorder).padding(.horizontal)
                            Button {
                                if let url = URL(string: "\(AppConfiguration.webAppURL.absoluteString)/connect") {
                                    UIApplication.shared.open(url)
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "plus.circle.fill")
                                        .foregroundStyle(Color.lensedAccent)
                                    Text("Add new store")
                                        .font(.subheadline)
                                        .foregroundStyle(Color.lensedAccent)
                                    Spacer()
                                }
                                .padding(.vertical, 12)
                                .padding(.horizontal)
                            }
                            .buttonStyle(.plain)
                        }
                        .lensedCard()
                    }
                    .padding(.horizontal)

                    // COGS management notice
                    cogsNotice

                    // Sign out
                    Button {
                        Task { await authVM.signOut() }
                    } label: {
                        HStack {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                            Text("Sign Out")
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.lensedCardBackground)
                        .foregroundStyle(Color.lensedRed)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.lensedCardBorder, lineWidth: 1)
                        )
                    }
                    .padding(.horizontal)
                    .padding(.top, 8)
                }
                .padding(.vertical)
            }
            .background(Color.lensedBackground)
            .navigationTitle("Account")
            .task { await viewModel.loadData() }
            .refreshable { await viewModel.loadData() }
        }
    }

    private var profileSection: some View {
        HStack(spacing: 16) {
            Image(systemName: "person.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.lensedAccent)

            VStack(alignment: .leading, spacing: 4) {
                Text(viewModel.displayName)
                    .font(.title3.bold())
                    .foregroundStyle(Color.lensedTextPrimary)

                Text(viewModel.userEmail)
                    .font(.subheadline)
                    .foregroundStyle(Color.lensedTextSecondary)
            }

            Spacer()
        }
        .padding(.horizontal)
        .lensedCard()
        .padding(.horizontal)
    }

    private func connectedStoreRow(name: String, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Color.lensedAccent)
                .frame(width: 28)
            Text(name)
                .font(.subheadline)
                .foregroundStyle(Color.lensedTextPrimary)
            Spacer()
            Circle()
                .fill(Color.lensedGreen)
                .frame(width: 8, height: 8)
        }
        .padding(.vertical, 12)
        .padding(.horizontal)
    }

    private var cogsNotice: some View {
        HStack(spacing: 12) {
            Image(systemName: "info.circle")
                .foregroundStyle(Color.lensedAccent)

            VStack(alignment: .leading, spacing: 4) {
                Text("COGS Management")
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.lensedTextPrimary)
                Text("Edit your cost of goods on the web app. The iOS app displays COGS data in read-only mode.")
                    .font(.caption)
                    .foregroundStyle(Color.lensedTextSecondary)
            }
        }
        .lensedCard()
        .padding(.horizontal)
    }
}
