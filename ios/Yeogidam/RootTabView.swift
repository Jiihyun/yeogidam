import SwiftUI

struct RootTabView: View {
    var body: some View {
        TabView {
            #if LOCAL_BUILD
            WaitingQueueView()
                .tabItem { Label("대기함", systemImage: "tray.full.fill") }

            SavedPlacesView()
                .tabItem { Label("보관함", systemImage: "bookmark.fill") }
            #else
            SavedPlacesView()
                .tabItem { Label("저장됨", systemImage: "bookmark.fill") }
            #endif

            MapPlaceholderView()
                .tabItem { Label("지도", systemImage: "map.fill") }

            MyPageView()
                .tabItem { Label("마이", systemImage: "person.fill") }
        }
    }
}
