import Foundation
import Supabase
import Auth

final class AuthService {
    private var client: SupabaseClient { SupabaseService.shared.client }

    func signIn(email: String, password: String) async throws {
        try await client.auth.signIn(email: email, password: password)
    }

    func signUp(email: String, password: String) async throws {
        try await client.auth.signUp(email: email, password: password)
    }

    func signOut() async throws {
        try await client.auth.signOut()
    }

    func session() async throws -> Session {
        try await client.auth.session
    }

    var currentSession: Session? {
        get async {
            try? await client.auth.session
        }
    }

    var currentUserID: UUID? {
        get async {
            try? await client.auth.session.user.id
        }
    }

    var accessToken: String? {
        get async {
            try? await client.auth.session.accessToken
        }
    }

    func authStateChanges() -> AsyncStream<(event: AuthChangeEvent, session: Session?)> {
        AsyncStream { continuation in
            let task = Task {
                for await (event, session) in client.auth.authStateChanges {
                    continuation.yield((event: event, session: session))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
