import Foundation
import Observation
import Supabase

@Observable
@MainActor
final class AuthViewModel {
    var isAuthenticated = false
    var isLoading = true
    var email = ""
    var password = ""
    var errorMessage: String?
    var isSignUp = false

    private let authService = AuthService()

    init() {
        Task { await checkSession() }
    }

    func checkSession() async {
        isLoading = true
        defer { isLoading = false }
        if let _ = await authService.currentSession {
            isAuthenticated = true
        }
        listenForAuthChanges()
    }

    func signIn() async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Please enter email and password."
            return
        }
        errorMessage = nil
        isLoading = true
        defer { isLoading = false }
        do {
            try await authService.signIn(email: email, password: password)
            isAuthenticated = true
            clearForm()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signUp() async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Please enter email and password."
            return
        }
        guard password.count >= 6 else {
            errorMessage = "Password must be at least 6 characters."
            return
        }
        errorMessage = nil
        isLoading = true
        defer { isLoading = false }
        do {
            try await authService.signUp(email: email, password: password)
            isAuthenticated = true
            clearForm()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        do {
            try await authService.signOut()
            isAuthenticated = false
            clearForm()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearForm() {
        email = ""
        password = ""
        errorMessage = nil
    }

    private func listenForAuthChanges() {
        Task {
            for await (event, _) in authService.authStateChanges() {
                switch event {
                case .signedIn:
                    isAuthenticated = true
                case .signedOut:
                    isAuthenticated = false
                default:
                    break
                }
            }
        }
    }
}
