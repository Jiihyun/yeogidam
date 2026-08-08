import SwiftUI

struct RootTabView: View {
    var body: some View {
        TabView {
            SavedPlacesView()
                .tabItem { Label("저장됨", systemImage: "bookmark.fill") }

            MapPlaceholderView()
                .tabItem { Label("지도", systemImage: "map.fill") }

            MyPageView()
                .tabItem { Label("마이", systemImage: "person.fill") }
        }
    }
}
