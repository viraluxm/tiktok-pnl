import SwiftUI

struct LoginView: View {
    @Environment(AuthViewModel.self) private var authVM

    var body: some View {
        @Bindable var vm = authVM

        NavigationStack {
            ScrollView {
                VStack(spacing: 32) {
                    // Logo / Header
                    VStack(spacing: 8) {
                        Image("Logo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 80, height: 80)

                        Text("Lensed")
                            .font(.largeTitle.bold())
                            .foregroundStyle(Color.lensedTextPrimary)

                        Text("Your P&L Dashboard")
                            .font(.subheadline)
                            .foregroundStyle(Color.lensedTextSecondary)
                    }
                    .padding(.top, 60)

                    // Form
                    VStack(spacing: 16) {
                        TextField("Email", text: $vm.email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .padding()
                            .background(Color.lensedCardBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(Color.lensedCardBorder, lineWidth: 1)
                            )

                        SecureField("Password", text: $vm.password)
                            .textContentType(.password)
                            .padding()
                            .background(Color.lensedCardBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(Color.lensedCardBorder, lineWidth: 1)
                            )

                        if let error = vm.errorMessage {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(Color.lensedRed)
                                .multilineTextAlignment(.center)
                        }

                        Button {
                            Task { await vm.signIn() }
                        } label: {
                            Group {
                                if vm.isLoading {
                                    ProgressView()
                                        .tint(.black)
                                } else {
                                    Text("Sign In")
                                        .fontWeight(.semibold)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.lensedAccent)
                            .foregroundStyle(.black)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .disabled(vm.isLoading)

                        Button {
                            if let url = URL(string: "\(AppConfiguration.webAppURL.absoluteString)/signup") {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            Text("Don't have an account? Sign Up")
                                .font(.subheadline)
                                .foregroundStyle(Color.lensedAccent)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .background(Color.lensedBackground)
            .scrollDismissesKeyboard(.interactively)
        }
    }
}
