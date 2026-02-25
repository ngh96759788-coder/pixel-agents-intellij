// IDE bridge — works in VS Code (acquireVsCodeApi) and IntelliJ JCEF (window.__intellijBridge)
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

interface IdeBridge {
  postMessage(msg: unknown): void
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
if (typeof acquireVsCodeApi !== 'function') {
  window.addEventListener('message', (e) => {
    if (e.data?.type === '__bridgeReady') {
      // Bridge is now available — send webviewReady again
      vscode.postMessage({ type: 'webviewReady' })
    }
  })
}
