#if LOCAL_BUILD
import SwiftUI

struct WaitingQueueView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.scenePhase) private var scenePhase

    @State private var reels: [QueueReelRow] = []
    @State private var expandedReelIDs: Set<UUID> = []
    @State private var selectedItemIDs: Set<UUID> = []
    @State private var isLoading = false
    @State private var isResolving = false
    @State private var isPolling = false
    @State private var activePollToken: UUID?
    @State private var activeLoadToken: UUID?
    @State private var trackedReelIDs: Set<UUID> = []
    @State private var announcedAutoSaveReelIDs: Set<UUID> = []
    @State private var showsAddSheet = false
    @State private var activeAlert: QueueAlert?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && reels.isEmpty {
                    ProgressView("대기함을 불러오는 중...")
                } else if reels.isEmpty {
                    emptyState
                } else {
                    queueList
                }
            }
            .navigationTitle("대기함")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsAddSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(appState.session == nil || isResolving)
                    .accessibilityLabel("릴스 URL 추가")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !selectedItemIDs.isEmpty {
                    actionBar
                }
            }
            .sheet(isPresented: $showsAddSheet) {
                if let accessToken = appState.session?.accessToken {
                    AddByURLSheet(accessToken: accessToken) { response in
                        await handleSubmittedReel(response)
                    }
                }
            }
            .alert(item: $activeAlert) { alert in
                switch alert {
                case .confirmation(let action):
                    Alert(
                        title: Text(action.confirmationTitle(count: selectedItemIDs.count)),
                        primaryButton: .cancel(Text("취소")),
                        secondaryButton: .default(Text("확인")) {
                            Task { await resolve(action) }
                        }
                    )
                case .error(let message):
                    Alert(
                        title: Text("요청을 완료하지 못했어요"),
                        message: Text(message),
                        dismissButton: .default(Text("확인"))
                    )
                case .notice(let title, let message):
                    Alert(
                        title: Text(title),
                        message: Text(message),
                        dismissButton: .default(Text("확인"))
                    )
                }
            }
            .onAppear {
                Task { await refreshAndPoll(showSpinner: reels.isEmpty) }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await refreshAndPoll() }
            }
        }
    }

    private var queueList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(reels) { reel in
                    QueueReelCard(
                        reel: reel,
                        isExpanded: expandedReelIDs.contains(reel.id),
                        selectedItemIDs: selectedItemIDs,
                        onToggleExpanded: { toggleExpanded(reel.id) },
                        onToggleReelSelection: { toggleReelSelection(reel) },
                        onTogglePlaceSelection: togglePlaceSelection
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 20)
        }
        .refreshable { await refreshAndPoll() }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()

            if isPolling {
                ProgressView()
                    .controlSize(.large)
                Text("릴스에서 장소를 찾고 있어요")
                    .font(.headline)
                Text("분석이 끝나면 장소가 이곳에 나타나요.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "tray")
                    .font(.system(size: 58))
                    .foregroundStyle(.secondary)
                Text("대기 중인 장소가 없어요")
                    .font(.headline)
                Text("Instagram 릴스를 공유하거나 URL을 입력하면\n분석된 장소가 먼저 이곳에 도착해요.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }

            Button {
                showsAddSheet = true
            } label: {
                Label("릴스 URL로 테스트", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(.indigo)
            .padding(.top, 8)

            Button {
                Task { await refreshAndPoll(showSpinner: true) }
            } label: {
                Label("새로고침", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)

            Spacer()
        }
        .padding(24)
    }

    private var actionBar: some View {
        VStack(spacing: 10) {
            Text("장소 \(selectedItemIDs.count)개 선택")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button {
                    activeAlert = .confirmation(.discard)
                } label: {
                    Label("삭제", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)
                .tint(.primary)

                Button {
                    activeAlert = .confirmation(.save)
                } label: {
                    Label("저장", systemImage: "bookmark.fill")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(.indigo)
            }
            .disabled(isResolving)
            .overlay {
                if isResolving {
                    ProgressView()
                        .padding(8)
                        .background(.regularMaterial, in: Circle())
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Divider() }
    }

    private func api() throws -> YeogidamAPI {
        guard let accessToken = appState.session?.accessToken else {
            throw YeogidamAPIError.missingSession
        }
        return YeogidamAPI(accessToken: accessToken)
    }

    @discardableResult
    private func load(showSpinner: Bool) async -> Bool {
        let loadToken = UUID()
        activeLoadToken = loadToken
        isLoading = showSpinner && reels.isEmpty

        defer {
            if activeLoadToken == loadToken {
                activeLoadToken = nil
                isLoading = false
            }
        }

        do {
            let loadedReels = try await api().fetchWaitingQueue()
            guard activeLoadToken == loadToken else { return false }

            reels = loadedReels
            let availableIDs = Set(loadedReels.flatMap { $0.pendingPlaces.map(\.id) })
            selectedItemIDs.formIntersection(availableIDs)
            expandedReelIDs.formIntersection(Set(loadedReels.map(\.id)))
            return true
        } catch {
            guard activeLoadToken == loadToken else { return false }
            activeAlert = .error(error.localizedDescription)
            return false
        }
    }

    private func refreshAndPoll(showSpinner: Bool = false) async {
        let pollToken = UUID()
        activePollToken = pollToken
        isPolling = false

        guard await load(showSpinner: showSpinner) else { return }
        guard activePollToken == pollToken else { return }

        defer {
            if activePollToken == pollToken {
                activePollToken = nil
                isPolling = false
            }
        }

        if !trackedReelIDs.isEmpty {
            await pollTrackedReels(pollToken: pollToken)
        }

        guard activePollToken == pollToken else { return }
        if trackedReelIDs.isEmpty {
            await pollAnyProcessingReel(pollToken: pollToken)
        }
    }

    private func pollAnyProcessingReel(pollToken: UUID) async {
        do {
            let processingReelIDs = try await api().fetchProcessingQueueReelIDs()
            guard activePollToken == pollToken else { return }

            guard !processingReelIDs.isEmpty else {
                await load(showSpinner: false)
                return
            }

            trackedReelIDs.formUnion(processingReelIDs)
            await pollTrackedReels(pollToken: pollToken)
        } catch {
            guard activePollToken == pollToken else { return }
            activeAlert = .error(error.localizedDescription)
        }
    }

    private func pollTrackedReels(pollToken: UUID) async {
        isPolling = true

        do {
            for attempt in 0...20 {
                guard activePollToken == pollToken else { return }

                let requestedIDs = trackedReelIDs.sorted {
                    $0.uuidString < $1.uuidString
                }
                guard !requestedIDs.isEmpty else { return }

                let states = try await api().fetchQueueReelStates(ids: requestedIDs)
                guard activePollToken == pollToken else { return }

                guard await load(showSpinner: false) else { return }
                guard activePollToken == pollToken else { return }

                var statesByID = Dictionary(uniqueKeysWithValues: states.map { ($0.id, $0) })
                let terminalIDs = states.compactMap { state in
                    switch state.processingStatus {
                    case .completed, .failed:
                        return state.id
                    case .pending, .processing:
                        return nil
                    }
                }

                // A legacy v1 request can promote a completed queue reel to AUTO_SAVE
                // while the queue itself is loading. Confirm terminal rows once more so
                // an older REVIEW_QUEUE snapshot never ends polling silently.
                if !terminalIDs.isEmpty {
                    let confirmedStates = try await api().fetchQueueReelStates(ids: terminalIDs)
                    guard activePollToken == pollToken else { return }
                    for reelID in terminalIDs {
                        statesByID.removeValue(forKey: reelID)
                    }
                    for state in confirmedStates {
                        statesByID[state.id] = state
                    }
                }

                var alertEvents: [QueueAlertEvent] = []
                for reelID in requestedIDs {
                    guard let state = statesByID[reelID] else {
                        clearTrackedReel(reelID)
                        alertEvents.append(
                            QueueAlertEvent(
                                alert: .error("방금 요청한 릴스의 처리 상태를 찾지 못했어요."),
                                priority: 3
                            )
                        )
                        continue
                    }
                    if let event = finishTrackedReelIfNeeded(state) {
                        alertEvents.append(event)
                    }
                }

                if attempt == 20 && !trackedReelIDs.isEmpty {
                    alertEvents.append(
                        QueueAlertEvent(
                            alert: .notice(
                                title: "분석이 계속 진행 중이에요",
                                message: "조금 뒤 새로고침하면 완료된 장소를 확인할 수 있어요."
                            ),
                            priority: 0
                        )
                    )
                }

                if let preferredAlert = alertEvents.max(by: { $0.priority < $1.priority }) {
                    activeAlert = preferredAlert.alert
                }

                guard !trackedReelIDs.isEmpty else { return }
                guard attempt < 20 else { return }

                try await Task.sleep(nanoseconds: 1_500_000_000)
            }
        } catch {
            guard activePollToken == pollToken else { return }
            activeAlert = .error(error.localizedDescription)
        }
    }

    private func finishTrackedReelIfNeeded(_ state: QueueReelStateRow) -> QueueAlertEvent? {
        if state.processingStatus == .failed {
            clearTrackedReel(state.id)
            return QueueAlertEvent(
                alert: .error(
                    state.failureReason?.displayText ?? "릴스에서 장소를 찾지 못했어요."
                ),
                priority: 3
            )
        }

        if state.saveMode == .autoSave {
            if state.processingStatus == .completed {
                clearTrackedReel(state.id)
                return QueueAlertEvent(
                    alert: .notice(
                        title: "보관함에 저장됐어요",
                        message: "기존 버전의 요청이 먼저 반영되어 대기함 대신 보관함에 바로 저장했어요."
                    ),
                    priority: 2
                )
            } else if announcedAutoSaveReelIDs.insert(state.id).inserted {
                return QueueAlertEvent(
                    alert: .notice(
                        title: "보관함에서 처리 중이에요",
                        message: "기존 버전의 요청이 먼저 반영되어 대기함이 아닌 보관함 흐름으로 처리하고 있어요."
                    ),
                    priority: 1
                )
            }
            return nil
        }

        if state.processingStatus == .completed {
            clearTrackedReel(state.id)
        }
        return nil
    }

    private func handleSubmittedReel(_ response: SaveInstagramReelResponse) async {
        guard let saveMode = response.saveMode,
              let responseStatus = response.status.flatMap(ProcessingStatus.init(rawValue:)) else {
            activeAlert = .error("개발용 저장 API의 응답 형식을 확인하지 못했어요.")
            return
        }

        trackedReelIDs.insert(response.reelId)

        if responseStatus == .failed {
            clearTrackedReel(response.reelId)
            activeAlert = .error("릴스에서 장소를 찾지 못했어요.")
            return
        }

        if saveMode == .autoSave {
            if responseStatus == .completed {
                clearTrackedReel(response.reelId)
                activeAlert = .notice(
                    title: "보관함에 저장됐어요",
                    message: "같은 릴스를 기존 버전에서 먼저 처리해 대기함 대신 보관함에 바로 저장했어요."
                )
                return
            }

            announcedAutoSaveReelIDs.insert(response.reelId)
            activeAlert = .notice(
                title: "보관함에서 처리 중이에요",
                message: "같은 릴스를 기존 버전에서 먼저 요청해 대기함이 아닌 보관함 흐름으로 처리하고 있어요."
            )
        }

        await refreshAndPoll()
    }

    private func clearTrackedReel(_ reelID: UUID) {
        trackedReelIDs.remove(reelID)
        announcedAutoSaveReelIDs.remove(reelID)
    }

    private func resolve(_ action: QueueAction) async {
        let ids = Array(selectedItemIDs)
        guard !ids.isEmpty else { return }

        activePollToken = nil
        activeLoadToken = UUID()
        isPolling = false
        isResolving = true
        defer { isResolving = false }

        do {
            try await api().resolveQueueItems(ids: ids, action: action)
            selectedItemIDs.subtract(ids)
        } catch {
            activeAlert = .error(error.localizedDescription)
        }

        await load(showSpinner: false)
        Task { await refreshAndPoll() }
    }

    private func toggleExpanded(_ reelID: UUID) {
        if expandedReelIDs.contains(reelID) {
            expandedReelIDs.remove(reelID)
        } else {
            expandedReelIDs.insert(reelID)
        }
    }

    private func toggleReelSelection(_ reel: QueueReelRow) {
        let ids = Set(reel.pendingPlaces.map(\.id))
        if ids.isSubset(of: selectedItemIDs) {
            selectedItemIDs.subtract(ids)
        } else {
            selectedItemIDs.formUnion(ids)
        }
    }

    private func togglePlaceSelection(_ itemID: UUID) {
        if selectedItemIDs.contains(itemID) {
            selectedItemIDs.remove(itemID)
        } else {
            selectedItemIDs.insert(itemID)
        }
    }
}

private enum QueueAlert: Identifiable {
    case confirmation(QueueAction)
    case error(String)
    case notice(title: String, message: String)

    var id: String {
        switch self {
        case .confirmation(let action): return "confirmation-\(action.rawValue)"
        case .error(let message): return "error-\(message)"
        case .notice(let title, let message): return "notice-\(title)-\(message)"
        }
    }
}

private struct QueueAlertEvent {
    let alert: QueueAlert
    let priority: Int
}

private struct QueueReelCard: View {
    let reel: QueueReelRow
    let isExpanded: Bool
    let selectedItemIDs: Set<UUID>
    let onToggleExpanded: () -> Void
    let onToggleReelSelection: () -> Void
    let onTogglePlaceSelection: (UUID) -> Void

    private var selectionState: QueueSelectionState {
        let ids = Set(reel.pendingPlaces.map(\.id))
        let selectedCount = ids.intersection(selectedItemIDs).count
        if selectedCount == 0 { return .none }
        if selectedCount == ids.count { return .all }
        return .partial
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button(action: onToggleExpanded) {
                    HStack(spacing: 12) {
                        QueueRemoteThumbnail(
                            urlString: reel.instagramThumbnailURL,
                            systemImage: "play.rectangle",
                            width: 72,
                            height: 86,
                            cornerRadius: 9
                        )

                        VStack(alignment: .leading, spacing: 5) {
                            Text(reel.caption)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                                .lineLimit(2)

                            Text(reel.author)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)

                            Text("대기 중 장소 \(reel.pendingPlaces.count)개")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.indigo)

                            Label(
                                isExpanded ? "접기" : "펼치기",
                                systemImage: isExpanded ? "chevron.up" : "chevron.down"
                            )
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                        }

                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                QueueSelectionButton(
                    state: selectionState,
                    accessibilityLabel: "릴스의 모든 장소 선택",
                    action: onToggleReelSelection
                )
            }
            .padding(12)

            if isExpanded {
                Divider()
                    .padding(.leading, 12)

                ForEach(reel.pendingPlaces) { reelPlace in
                    Button {
                        onTogglePlaceSelection(reelPlace.id)
                    } label: {
                        HStack(spacing: 8) {
                            QueuePlaceSummaryRow(place: reelPlace.place)

                            QueueSelectionButton(
                                state: selectedItemIDs.contains(reelPlace.id) ? .all : .none,
                                accessibilityLabel: "\(reelPlace.place.name) 선택",
                                action: { onTogglePlaceSelection(reelPlace.id) }
                            )
                            .allowsHitTesting(false)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if reelPlace.id != reel.pendingPlaces.last?.id {
                        Divider()
                            .padding(.leading, 92)
                    }
                }
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        }
    }
}
#endif
