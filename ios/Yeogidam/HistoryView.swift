#if LOCAL_BUILD
import SwiftUI

struct HistoryView: View {
    @EnvironmentObject private var appState: AppState

    @State private var reels: [HistoryReelRow] = []
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var activeLoadToken: UUID?
    @State private var loadTask: Task<Void, Never>?
    @State private var nextCursor: HistoryCursor?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading && reels.isEmpty {
                ProgressView("히스토리를 불러오는 중...")
            } else if reels.isEmpty {
                emptyState
            } else {
                historyList
            }
        }
        .navigationTitle("히스토리")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            startLoad(showSpinner: reels.isEmpty)
        }
        .onDisappear {
            activeLoadToken = nil
            loadTask?.cancel()
            loadTask = nil
            isLoading = false
            isLoadingMore = false
        }
        .alert("히스토리를 불러오지 못했어요", isPresented: errorBinding) {
            Button("다시 시도") {
                startLoad(showSpinner: reels.isEmpty)
            }
            Button("확인", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "잠시 후 다시 시도해주세요.")
        }
    }

    private var historyList: some View {
        List {
            ForEach(groupedReels) { group in
                Section(group.title) {
                    ForEach(group.reels) { reel in
                        NavigationLink {
                            HistoryDetailView(initialReel: reel)
                        } label: {
                            HistoryRow(reel: reel)
                        }
                    }
                }
            }

            if nextCursor != nil {
                Section {
                    Button {
                        startLoadMore()
                    } label: {
                        HStack {
                            Spacer()
                            if isLoadingMore {
                                ProgressView()
                            } else {
                                Label("이전 기록 더 보기", systemImage: "chevron.down")
                            }
                            Spacer()
                        }
                    }
                    .disabled(isLoadingMore)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await refresh() }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()

            HistoryMascotView(size: 104)

            Text("아직 공유된 콘텐츠가 없어요")
                .font(.headline)

            Text("공유한 기록이 생기면 표시돼요.\n공유하기를 통해 여기담에 저장해보세요.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            Button {
                startLoad(showSpinner: true)
            } label: {
                Label("새로고침", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .padding(.top, 8)

            Spacer()
        }
        .padding(24)
    }

    private var groupedReels: [HistoryDayGroup] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: reels) { reel in
            reel.createdDate.map(calendar.startOfDay(for:)) ?? .distantPast
        }

        return grouped
            .map { date, reels in
                HistoryDayGroup(
                    date: date,
                    reels: reels.sorted {
                        ($0.createdDate ?? .distantPast) > ($1.createdDate ?? .distantPast)
                    }
                )
            }
            .sorted { $0.date > $1.date }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )
    }

    private func api() throws -> YeogidamAPI {
        guard let accessToken = appState.session?.accessToken else {
            throw YeogidamAPIError.missingSession
        }
        return YeogidamAPI(accessToken: accessToken)
    }

    private func startLoad(showSpinner: Bool) {
        loadTask?.cancel()
        loadTask = Task { await load(showSpinner: showSpinner) }
    }

    private func startLoadMore() {
        loadTask?.cancel()
        loadTask = Task { await loadMore() }
    }

    private func refresh() async {
        loadTask?.cancel()
        loadTask = nil
        await load(showSpinner: false)
    }

    private func load(showSpinner: Bool) async {
        let loadToken = UUID()
        activeLoadToken = loadToken
        isLoadingMore = false
        isLoading = showSpinner && reels.isEmpty

        defer {
            if activeLoadToken == loadToken {
                activeLoadToken = nil
                isLoading = false
            }
        }

        do {
            let page = try await api().fetchHistory()
            guard activeLoadToken == loadToken else { return }
            reels = page.reels
            nextCursor = page.nextCursor
            errorMessage = nil
        } catch {
            guard activeLoadToken == loadToken, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }

        let loadToken = UUID()
        activeLoadToken = loadToken
        isLoadingMore = true

        defer {
            if activeLoadToken == loadToken {
                activeLoadToken = nil
                isLoadingMore = false
            }
        }

        do {
            let page = try await api().fetchHistory(after: cursor)
            guard activeLoadToken == loadToken else { return }

            let existingIDs = Set(reels.map(\.id))
            reels.append(contentsOf: page.reels.filter { !existingIDs.contains($0.id) })
            nextCursor = page.nextCursor
            errorMessage = nil
        } catch {
            guard activeLoadToken == loadToken, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct HistoryDayGroup: Identifiable {
    let date: Date
    let reels: [HistoryReelRow]

    var id: Date { date }

    var title: String {
        guard date != .distantPast else { return "날짜 정보 없음" }
        return Self.formatter.string(from: date)
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "yyyy.MM.dd"
        return formatter
    }()
}

private struct HistoryRow: View {
    let reel: HistoryReelRow

    var body: some View {
        HStack(spacing: 12) {
            QueueRemoteThumbnail(
                urlString: reel.instagramThumbnailURL,
                systemImage: "play.rectangle",
                width: 64,
                height: 78,
                cornerRadius: 8
            )

            VStack(alignment: .leading, spacing: 7) {
                HistoryStatusBadge(status: reel.processingStatus)

                Text(reel.historyTitle)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

struct HistoryStatusBadge: View {
    let status: ProcessingStatus

    var body: some View {
        Text(title)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private var title: String {
        switch status {
        case .completed: "장소 추출 성공"
        case .failed: "장소 추출 실패"
        case .pending, .processing: "분석 중"
        }
    }

    private var color: Color {
        switch status {
        case .completed: .green
        case .failed: .red
        case .pending, .processing: .indigo
        }
    }
}

struct HistoryMascotView: View {
    let size: CGFloat

    var body: some View {
        Image("HistoryMascot")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
            .accessibilityHidden(true)
    }
}
#endif
