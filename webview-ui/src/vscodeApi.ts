// IDE bridge — three transport modes:
//   1. VS Code webview: acquireVsCodeApi()
//   2. IntelliJ JCEF: window.__intellijBridge injected by Kotlin
//   3. Standalone browser tab (e.g. the MCP bridge serving the office to
//      Claude Desktop users on http://localhost:PORT) — WebSocket on /ws
//
// The browser path mirrors the postMessage protocol exactly: outgoing
// messages go on the WS as JSON; incoming messages are re-dispatched as
// `window.postMessage` events so all existing useExtensionMessages
// listeners continue to work unchanged.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

interface IdeBridge {
  postMessage(msg: unknown): void
}

function isBrowserStandalone(): boolean {
  // VS Code webview overrides `acquireVsCodeApi`, IntelliJ injects
  // __intellijBridge. If neither exists AND we're on http(s) (not a
  // file:// URL handed to JCEF), assume the MCP bridge browser path.
  if (typeof acquireVsCodeApi === 'function') return false
  if ((window as any).__intellijBridge) return false
  return location.protocol === 'http:' || location.protocol === 'https:'
}

function createBrowserBridge(): IdeBridge {
  const outbox: string[] = []
  let socket: WebSocket | null = null

  function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/ws`
    socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      // Drain anything queued before the socket was ready (mirrors the
      // IntelliJ queue pattern so the React app can postMessage on boot
      // without knowing the transport state).
      while (outbox.length > 0) socket?.send(outbox.shift()!)
    })
    socket.addEventListener('message', (e) => {
      // Re-dispatch onto the window so the existing message handler in
      // useExtensionMessages picks it up without any code changes.
      try {
        const data = JSON.parse(e.data)
        window.postMessage(data, '*')
      } catch (err) {
        console.error('[bridge] bad ws message', err)
      }
    })
    socket.addEventListener('close', () => {
      socket = null
      // Reconnect with a small backoff — the MCP server may briefly drop
      // when Claude Desktop respawns the extension.
      setTimeout(connect, 1500)
    })
  }
  connect()

  return {
    postMessage(msg: unknown) {
      const json = JSON.stringify(msg)
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(json)
      } else {
        outbox.push(json)
      }
    },
  }
}

function createBridge(): IdeBridge {
  // VS Code webview
  if (typeof acquireVsCodeApi === 'function') {
    try {
      return acquireVsCodeApi()
    } catch {
      // acquireVsCodeApi exists but failed — fall through to IntelliJ bridge
    }
  }
  // Standalone browser (MCP bridge surface)
  if (isBrowserStandalone()) {
    return createBrowserBridge()
  }
  // IntelliJ JCEF — bridge injected by Kotlin via JBCefJSQuery
  // Bridge may not be available yet at this point; queue messages until ready
  return {
    postMessage(msg: unknown) {
      const json = JSON.stringify(msg)
      if ((window as any).__intellijBridge) {
        ;(window as any).__intellijBridge(json)
      } else {
        // Queue messages until bridge is injected by onLoadEnd
        const w = window as any
        if (!w.__intellijBridgeQueue) {
          w.__intellijBridgeQueue = []
        }
        w.__intellijBridgeQueue.push(json)
      }
    },
  }
}

export const vscode = createBridge()

// When IntelliJ bridge becomes ready, re-send webviewReady
if (typeof acquireVsCodeApi !== 'function' && !isBrowserStandalone()) {
  window.addEventListener('message', (e) => {
    if (e.data?.type === '__bridgeReady') {
      // Bridge is now available — send webviewReady again
      vscode.postMessage({ type: 'webviewReady' })
    }
  })
}
