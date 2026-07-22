package com.pixelagents.intellij

import com.intellij.openapi.components.*

/**
 * Application-level settings shared across all IntelliJ projects and
 * windows. Use this for toggles that need a single source of truth
 * for the whole IDE installation — e.g. the "share layout across
 * projects" switch, which must produce the same answer regardless of
 * which project asks. Per-project preferences live in
 * [PixelAgentsSettings] (`Service.Level.PROJECT`).
 */
@State(
    name = "PixelAgentsAppSettings",
    storages = [Storage("pixelAgents.app.xml")]
)
@Service(Service.Level.APP)
class PixelAgentsAppSettings : PersistentStateComponent<PixelAgentsAppSettings.State> {

    data class State(
        // When true, every IntelliJ window/project reads & writes the
        // same layout file (~/.pixel-agents/shared/layout.json) so
        // changes propagate across all windows. When false (default),
        // each project has its own scope dir to prevent cross-window
        // stomping (the safer default that ships since 2af35f8).
        var sharedLayoutAcrossProjects: Boolean = false,
        // BEHAVIOR_SPEC §4 "통합 보기". When false (default) this window shows
        // only its own Claude sessions. When true it ALSO surfaces sessions
        // from other sources (other IntelliJ windows' CLI, other
        // ~/.claude/projects activity) as EXTERNAL agents rendered faded
        // (85% opacity) by the webview. App-level so the toggle is a single
        // source of truth for the whole IDE installation.
        var unifiedView: Boolean = false,
    )

    private var myState = State()

    override fun getState(): State = myState
    override fun loadState(state: State) {
        myState = state
    }

    var sharedLayoutAcrossProjects: Boolean
        get() = myState.sharedLayoutAcrossProjects
        set(value) { myState.sharedLayoutAcrossProjects = value }

    var unifiedView: Boolean
        get() = myState.unifiedView
        set(value) { myState.unifiedView = value }

    companion object {
        fun getInstance(): PixelAgentsAppSettings =
            service<PixelAgentsAppSettings>()
    }
}
