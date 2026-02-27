package com.pixelagents.intellij

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.*

@State(
    name = "PixelAgentsSettings",
    storages = [Storage("pixelAgents.xml")]
)
@Service(Service.Level.APP)
class PixelAgentsSettings : PersistentStateComponent<PixelAgentsSettings.State> {

    data class State(
        var soundEnabled: Boolean = true,
        var persistedAgents: String? = null,
        var agentSeats: String? = null,
        var savedLayout: String? = null,
        var theme: String = Constants.THEME_DEFAULT,
    )

    private var myState = State()

    override fun getState(): State = myState
    override fun loadState(state: State) {
        myState = state
    }

    var soundEnabled: Boolean
        get() = myState.soundEnabled
        set(value) { myState.soundEnabled = value }

    var persistedAgents: String?
        get() = myState.persistedAgents
        set(value) { myState.persistedAgents = value }

    var agentSeats: String?
        get() = myState.agentSeats
        set(value) { myState.agentSeats = value }

    var savedLayout: String?
        get() = myState.savedLayout
        set(value) { myState.savedLayout = value }

    var theme: String
        get() = myState.theme
        set(value) { myState.theme = value }

    companion object {
        fun getInstance(): PixelAgentsSettings =
            ApplicationManager.getApplication().getService(PixelAgentsSettings::class.java)
    }
}
