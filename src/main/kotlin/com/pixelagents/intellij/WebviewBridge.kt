package com.pixelagents.intellij

import com.google.gson.Gson
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefDisplayHandler
import org.cef.handler.CefLoadHandlerAdapter

class WebviewBridge(
    private val browser: JBCefBrowser,
    private val onMessage: (Map<String, Any?>) -> Unit,
) {
    private val gson = Gson()
    private val jsQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)

    companion object {
        private val LOG = Logger.getInstance(WebviewBridge::class.java)
    }

    init {
        // Register handler for messages from webview JS -> Kotlin
        jsQuery.addHandler { jsonString ->
            try {
                @Suppress("UNCHECKED_CAST")
                val message = gson.fromJson(jsonString, Map::class.java) as Map<String, Any?>
                LOG.info("Received webview message: ${message["type"]}")
                ApplicationManager.getApplication().invokeLater {
                    onMessage(message)
                }
            } catch (e: Exception) {
                LOG.error("Error parsing webview message", e)
            }
            JBCefJSQuery.Response(null)
        }

        // Capture JS console output for debugging
        browser.jbCefClient.addDisplayHandler(object : CefDisplayHandler {
            override fun onAddressChange(b: CefBrowser, f: CefFrame, url: String) {}
            override fun onTitleChange(b: CefBrowser, title: String) {}
            override fun onTooltip(b: CefBrowser, text: String): Boolean = false
            override fun onStatusMessage(b: CefBrowser, value: String) {}
            override fun onConsoleMessage(b: CefBrowser, level: org.cef.CefSettings.LogSeverity, message: String, source: String, line: Int): Boolean {
                LOG.info("JS Console [$level] $source:$line — $message")
                return false
            }
            override fun onCursorChange(b: CefBrowser, cursorType: Int): Boolean = false
            override fun onFullscreenModeChange(b: CefBrowser, fullscreen: Boolean) {}
        }, browser.cefBrowser)

        // Inject the bridge function after page loads
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain) {
                    LOG.info("Page loaded (status=$httpStatusCode), injecting bridge")
                    injectBridge(cefBrowser)
                }
            }
        }, browser.cefBrowser)
    }

    private fun injectBridge(cefBrowser: CefBrowser) {
        // DPR override is now handled via ?dpr= URL parameter in index.html
        // so it takes effect before React initializes (see PixelAgentsPanel.init).

        val injection = jsQuery.inject("msg")
        val js = """
            window.__intellijBridge = function(msg) {
                $injection
            };
            // Flush any messages queued before bridge was ready
            if (window.__intellijBridgeQueue) {
                window.__intellijBridgeQueue.forEach(function(msg) {
                    window.__intellijBridge(msg);
                });
                delete window.__intellijBridgeQueue;
            }
            // Signal bridge is ready — webview re-sends webviewReady on this event
            window.postMessage({type: '__bridgeReady'}, '*');
        """.trimIndent()
        cefBrowser.executeJavaScript(js, cefBrowser.url, 0)
    }

    fun sendToWebview(type: String, payload: Map<String, Any?>) {
        val message = payload.toMutableMap()
        message["type"] = type
        val json = gson.toJson(message)
        ApplicationManager.getApplication().invokeLater {
            browser.cefBrowser.executeJavaScript(
                "window.postMessage($json, '*');",
                browser.cefBrowser.url, 0
            )
        }
    }

    fun dispose() {
        jsQuery.dispose()
    }
}
