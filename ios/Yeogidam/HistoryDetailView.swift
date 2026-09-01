#if LOCAL_BUILD
import SwiftUI

struct HistoryDetailView: View {
    @EnvironmentObject private var appState: AppState

    @State private var reel: HistoryReelRow
    @State private var isDetailLoaded: Bool
    @State private var isLoadingDetail = false
    @State private var isRefreshing = false
    @State private var isRetrying = false
    @State private var isReporting = false
    @State private var activeRefreshToken: UUID?
    @State private var activeRetryToken: UUID?
    @State private var activeReportToken: UUID?
    @State private var pendingRetrySubmission: ReelSubmission?
    @State private var refreshTask: Task<Void, Never>?
    @State private var retryTask: Task<Void, Never>?
    @State private var reportTask: Task<Void, Never>?
    @State private var activeAlert: HistoryAlert?

    init(initialReel: HistoryReelRow) {
        _reel = State(initialValue: initialReel)
        _isDetailLoaded = State(initialValue: initialReel.extraction != nil)
    }

    var body: some View {
        ScrollView {
            Group {
                if isLoadingDetail && !isDetailLoaded {
                    ProgressView("상세 기록을 불러오는 중...")
                        .frame(maxWidth: .infinity, minHeight: 280)
                } else if !isDetailLoaded {
                    detailUnavailableContent
                } else {
                    statusContent
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 28)
            .padding(.bottom, 36)
        }
        .navigationTitle("히스토리")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !isDetailLoaded else { return }
            startRefresh(showSpinner: true)
        }
        .onDisappear {
            activeRefreshToken = nil
            activeRetryToken = nil
            activeReportToken = nil
            refreshTask?.cancel()
            retryTask?.cancel()
            reportTask?.cancel()
            refreshTask = nil
            retryTask = nil
            reportTask = nil
            isLoadingDetail = false
            isRefreshing = false
            isRetrying = false
            isReporting = false
        }
        .alert(item: $activeAlert) { alert in
            switch alert {
            case .retryConfirmation:
                Alert(
                    title: Text("다시 시도하시겠습니까?"),
                    primaryButton: .cancel(Text("취소")),
                    secondaryButton: .default(Text("확인"), action: startRetry)
                )
            case .reportConfirmation:
                Alert(
                    title: Text("신고 / 제보 하시겠습니까?"),
                    primaryButton: .cancel(Text("취소")),
                    secondaryButton: .default(Text("확인"), action: startReport)
                )
            case .notice(let title, let message):
                Alert(
                    title: Text(title),
                    message: message.map(Text.init),
                    dismissButton: .default(Text("확인"))
                )
            }
        }
    }

    @ViewBuilder
    private var statusContent: some View {
        switch reel.processingStatus {
        case .completed:
            successContent
        case .failed:
            failureContent
        case .pending, .processing:
            processingContent
        }
    }

    private var detailUnavailableContent: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                .font(.system(size: 46))
                .foregroundStyle(.secondary)

            Text("상세 기록을 표시하지 못했어요")
                .font(.headline)

            Button {
                startRefresh(showSpinner: true)
            } label: {
                Label("다시 불러오기", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, minHeight: 280)
    }

    private var successContent: some View {
        VStack(spacing: 22) {
            stateHeader(
                title: "장소 분석이 완료되었어요!",
                subtitle: "총 \(reel.orderedPlaces.count)개의 장소를 찾았어요"
            )

            originalReelButton

            VStack(alignment: .leading, spacing: 14) {
                Text("발견한 장소")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity, alignment: .leading)

                if reel.orderedPlaces.isEmpty {
                    Text("표시할 장소 정보가 없어요.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 100)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(spacing: 12) {
                            ForEach(reel.orderedPlaces) { reelPlace in
                                HistoryPlaceCard(reelPlace: reelPlace)
                            }
                        }
                    }
                }
            }
        }
    }

    private var failureContent: some View {
        VStack(spacing: 20) {
            stateHeader(
                title: "장소 분석에 실패했어요ㅠ",
                subtitle: reel.failureReason?.displayText
                    ?? "릴스에서 장소 정보를 찾지 못했어요."
            )

            originalReelButton

            Button {
                activeAlert = .retryConfirmation
            } label: {
                Label("다시 시도하기", systemImage: "arrow.clockwise")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .buttonBorderShape(.roundedRectangle(radius: 10))
            .disabled(isRetrying || isReporting || isRefreshing)

            Button {
                activeAlert = .reportConfirmation
            } label: {
                Label("신고 / 제보하기", systemImage: "exclamationmark.bubble")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .buttonBorderShape(.roundedRectangle(radius: 10))
            .disabled(isRetrying || isReporting || isRefreshing)

            if isRetrying || isReporting {
                ProgressView(isRetrying ? "다시 분석하는 중..." : "제보를 보내는 중...")
                    .font(.footnote)
            }
        }
    }

    private var processingContent: some View {
        VStack(spacing: 22) {
            stateHeader(
                title: "장소를 분석하고 있어요",
                subtitle: "분석이 끝나면 장소가 \(destinationName)에 표시돼요."
            )

            ProgressView()
                .controlSize(.large)

            originalReelButton

            Button {
                startRefresh(showSpinner: false)
            } label: {
                if isRefreshing {
                    ProgressView()
                } else {
                    Label("상태 새로고침", systemImage: "arrow.clockwise")
                }
            }
            .buttonStyle(.bordered)
            .disabled(isRefreshing || isRetrying)
        }
    }

    private var destinationName: String {
        reel.saveMode == .reviewQueue ? "대기함" : "보관함"
    }

    private func stateHeader(
        title: String,
        subtitle: String
    ) -> some View {
        VStack(spacing: 12) {
            HistoryMascotView(size: 104)

            Text(title)
                .font(.title3.bold())
                .multilineTextAlignment(.center)

            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    @ViewBuilder
    private var originalReelButton: some View {
        if let url = URL(string: reel.instagramURL) {
            Link(destination: url) {
                HStack {
                    InstagramGlyph()
                    Text("원본 릴스로 이동")
                        .font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 16)
                .frame(height: 52)
                .background(Color(uiColor: .secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
    }

    private func api() throws -> YeogidamAPI {
        guard let accessToken = appState.session?.accessToken else {
            throw YeogidamAPIError.missingSession
        }
        return YeogidamAPI(accessToken: accessToken)
    }

    private func startRetry() {
        activeRefreshToken = nil
        refreshTask?.cancel()
        refreshTask = nil
        retryTask?.cancel()
        retryTask = Task { await retry() }
    }

    private func startRefresh(showSpinner: Bool) {
        refreshTask?.cancel()
        refreshTask = Task { await refreshDetail(showSpinner: showSpinner) }
    }

    private func startReport() {
        reportTask?.cancel()
        reportTask = Task { await report() }
    }

    private func retry() async {
        guard !isRetrying else { return }

        let retryToken = UUID()
        activeRetryToken = retryToken
        activeRefreshToken = nil
        isRefreshing = false
        isRetrying = true

        defer {
            if activeRetryToken == retryToken {
                activeRetryToken = nil
                isRetrying = false
                retryTask = nil
            }
        }

        do {
            let client = try api()
            let submission: ReelSubmission
            if let pendingRetrySubmission,
               pendingRetrySubmission.instagramURL == reel.instagramURL {
                submission = pendingRetrySubmission
            } else {
                submission = ReelSubmission(instagramURL: reel.instagramURL)
                pendingRetrySubmission = submission
            }

            let response = try await client.saveInstagramReel(submission)
            guard isActiveRetry(retryToken) else { return }
            pendingRetrySubmission = nil

            if let updated = try await client.fetchHistoryReel(id: response.reelId) {
                guard isActiveRetry(retryToken) else { return }
                reel = updated
                isDetailLoaded = true
            }

            for attempt in 0...20 {
                guard isActiveRetry(retryToken) else { return }

                let states = try await client.fetchQueueReelStates(ids: [response.reelId])
                guard isActiveRetry(retryToken) else { return }
                guard let state = states.first else {
                    throw YeogidamAPIError.server("다시 요청한 릴스의 상태를 찾지 못했어요.")
                }

                switch state.processingStatus {
                case .completed, .failed:
                    guard let updated = try await client.fetchHistoryReel(id: response.reelId) else {
                        throw YeogidamAPIError.server("완료된 분석 기록을 찾지 못했어요.")
                    }
                    guard isActiveRetry(retryToken) else { return }
                    reel = updated
                    isDetailLoaded = true
                    return
                case .pending, .processing:
                    break
                }

                if attempt == 20 {
                    activeAlert = .notice(
                        title: "다시 분석 중이에요",
                        message: "분석이 계속되고 있어요. 잠시 후 상태를 새로고침해주세요."
                    )
                    return
                }

                try await Task.sleep(nanoseconds: 1_500_000_000)
            }
        } catch is CancellationError {
            return
        } catch {
            guard isActiveRetry(retryToken) else { return }
            activeAlert = .notice(
                title: "다시 시도하지 못했어요",
                message: error.localizedDescription
            )
        }
    }

    private func isActiveRetry(_ token: UUID) -> Bool {
        activeRetryToken == token && !Task.isCancelled
    }

    private func refreshDetail(showSpinner: Bool) async {
        guard !isRetrying else { return }

        let refreshToken = UUID()
        activeRefreshToken = refreshToken
        isLoadingDetail = showSpinner && !isDetailLoaded
        isRefreshing = !isLoadingDetail

        defer {
            if activeRefreshToken == refreshToken {
                activeRefreshToken = nil
                isLoadingDetail = false
                isRefreshing = false
            }
        }

        do {
            guard let updated = try await api().fetchHistoryReel(id: reel.id) else {
                throw YeogidamAPIError.server("분석 기록을 찾지 못했어요.")
            }
            guard activeRefreshToken == refreshToken else { return }
            reel = updated
            isDetailLoaded = true
        } catch {
            guard activeRefreshToken == refreshToken, !Task.isCancelled else { return }
            activeAlert = .notice(
                title: "상태를 확인하지 못했어요",
                message: error.localizedDescription
            )
        }
    }

    private func report() async {
        guard !isReporting else { return }

        let reportToken = UUID()
        activeReportToken = reportToken
        isReporting = true
        defer {
            if activeReportToken == reportToken {
                activeReportToken = nil
                isReporting = false
                reportTask = nil
            }
        }

        do {
            try await api().reportReel(id: reel.id)
            guard activeReportToken == reportToken, !Task.isCancelled else { return }
            activeAlert = .notice(
                title: "제보를 접수했어요",
                message: "같은 릴스는 중복으로 접수되지 않아요."
            )
        } catch {
            guard activeReportToken == reportToken, !Task.isCancelled else { return }
            activeAlert = .notice(
                title: "제보를 보내지 못했어요",
                message: error.localizedDescription
            )
        }
    }
}

private struct InstagramGlyph: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(
                    LinearGradient(
                        colors: [.purple, .pink, .orange],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            Circle()
                .stroke(.white, lineWidth: 1.8)
                .frame(width: 10, height: 10)

            Circle()
                .fill(.white)
                .frame(width: 2.5, height: 2.5)
                .offset(x: 6, y: -6)
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}

private struct HistoryPlaceCard: View {
    let reelPlace: ExtractedPlaceRow

    var body: some View {
        Group {
            if let urlString = reelPlace.place.kakaoPlaceURL,
               let url = URL(string: urlString) {
                Link(destination: url) { cardContent }
                    .buttonStyle(.plain)
            } else {
                cardContent
            }
        }
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 5) {
            QueueRemoteThumbnail(
                urlString: reelPlace.place.thumbnailURL,
                systemImage: "mappin.and.ellipse",
                width: 104,
                height: 86,
                cornerRadius: 8
            )

            Text(reelPlace.place.name)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)

            Text(shortAddress)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(width: 104, alignment: .leading)
    }

    private var shortAddress: String {
        let address = reelPlace.place.queueDisplayAddress
        let components = address.split(whereSeparator: { $0.isWhitespace })
        guard components.count > 2 else { return address }
        return components.prefix(2).joined(separator: " ")
    }
}

private enum HistoryAlert: Identifiable {
    case retryConfirmation
    case reportConfirmation
    case notice(title: String, message: String?)

    var id: String {
        switch self {
        case .retryConfirmation: "retry-confirmation"
        case .reportConfirmation: "report-confirmation"
        case .notice(let title, _): "notice-\(title)"
        }
    }
}
#endif
