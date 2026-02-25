package com.pixelagents.intellij

import java.util.concurrent.*

class TimerManager(
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
    private val agents: ConcurrentHashMap<Int, AgentState>,
) {
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-TimerManager").apply { isDaemon = true }
    }
    private val waitingTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    private val permissionTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()

    companion object {
        val PERMISSION_EXEMPT_TOOLS = setOf("Task", "AskUserQuestion")
    }

    fun clearAgentActivity(agent: AgentState, agentId: Int) {
        agent.activeToolIds.clear()
        agent.activeToolStatuses.clear()
        agent.activeToolNames.clear()
        agent.activeSubagentToolIds.clear()
        agent.activeSubagentToolNames.clear()
        agent.isWaiting = false
        agent.permissionSent = false
        cancelPermissionTimer(agentId)
        sendToWebview("agentToolsClear", mapOf("id" to agentId))
        sendToWebview("agentStatus", mapOf("id" to agentId, "status" to "active"))
    }

    fun cancelWaitingTimer(agentId: Int) {
        waitingTimers.remove(agentId)?.cancel(false)
    }

    fun startWaitingTimer(agentId: Int, delayMs: Long) {
        cancelWaitingTimer(agentId)
        val future = scheduler.schedule({
            waitingTimers.remove(agentId)
            val agent = agents[agentId]
            if (agent != null) {
                agent.isWaiting = true
            }
            sendToWebview("agentStatus", mapOf("id" to agentId, "status" to "waiting"))
        }, delayMs, TimeUnit.MILLISECONDS)
        waitingTimers[agentId] = future
    }

    fun cancelPermissionTimer(agentId: Int) {
        permissionTimers.remove(agentId)?.cancel(false)
    }

    fun startPermissionTimer(agentId: Int) {
        cancelPermissionTimer(agentId)
        val future = scheduler.schedule({
            permissionTimers.remove(agentId)
            val agent = agents[agentId] ?: return@schedule

            var hasNonExempt = false
            for (toolId in agent.activeToolIds) {
                val toolName = agent.activeToolNames[toolId]
                if (toolName != null && toolName !in PERMISSION_EXEMPT_TOOLS) {
                    hasNonExempt = true
                    break
                }
            }

            val stuckSubagentParentToolIds = mutableListOf<String>()
            for ((parentToolId, subToolNames) in agent.activeSubagentToolNames) {
                for ((_, toolName) in subToolNames) {
                    if (toolName !in PERMISSION_EXEMPT_TOOLS) {
                        stuckSubagentParentToolIds.add(parentToolId)
                        hasNonExempt = true
                        break
                    }
                }
            }

            if (hasNonExempt) {
                agent.permissionSent = true
                sendToWebview("agentToolPermission", mapOf("id" to agentId))
                for (parentToolId in stuckSubagentParentToolIds) {
                    sendToWebview(
                        "subagentToolPermission",
                        mapOf("id" to agentId, "parentToolId" to parentToolId)
                    )
                }
            }
        }, Constants.PERMISSION_TIMER_DELAY_MS, TimeUnit.MILLISECONDS)
        permissionTimers[agentId] = future
    }

    fun dispose() {
        scheduler.shutdownNow()
    }
}
