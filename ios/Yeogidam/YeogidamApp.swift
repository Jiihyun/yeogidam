import SwiftUI

@main
struct YeogidamApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            Group {
                if appState.isLoading {
                    ProgressView()
                } else if appState.session == nil {
                    LoginView()
                } else {
                    RootTabView()
                }
            }
            .environmentObject(appState)
            .task { await appState.start() }
        }
    }
}
