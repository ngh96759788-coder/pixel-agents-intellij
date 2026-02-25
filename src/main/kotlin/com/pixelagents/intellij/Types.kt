package com.pixelagents.intellij

data class AgentState(
    val id: Int,
    val terminalName: String,
    val projectDir: String,
    var jsonlFile: String,
    var fileOffset: Long = 0,
    var lineBuffer: String = "",
    val activeToolIds: MutableSet<String> = mutableSetOf(),
    val activeToolStatuses: MutableMap<String, String> = mutableMapOf(),
    val activeToolNames: MutableMap<String, String> = mutableMapOf(),
    val activeSubagentToolIds: MutableMap<String, MutableSet<String>> = mutableMapOf(),
    val activeSubagentToolNames: MutableMap<String, MutableMap<String, String>> = mutableMapOf(),
    var isWaiting: Boolean = false,
    var permissionSent: Boolean = false,
    var hadToolsInTurn: Boolean = false,
)

data class PersistedAgent(
    val id: Int,
    val terminalName: String,
    val jsonlFile: String,
    val projectDir: String,
)
