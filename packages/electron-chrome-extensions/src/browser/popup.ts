import { BrowserWindow, Session } from 'electron'
import {ExtensionStore} from "./store";

const debug = require('debug')('electron-chrome-extensions:popup')

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

interface PopupViewOptions {
  extensionId: string
  session: Session
  parent: BrowserWindow
  anchorWindow: BrowserWindow
  url: string
  anchorRect: PopupAnchorRect
  store: ExtensionStore
}

export class PopupView {
  static BOUNDS = {
    minWidth: 25,
    minHeight: 25,
    maxWidth: 800,
    maxHeight: 600,
  }

  browserWindow?: BrowserWindow
  parent?: BrowserWindow
  anchorWindow?: BrowserWindow
  anchorWindowBounds: Electron.Rectangle | null
  extensionId: string
  store: ExtensionStore

  private anchorRect: PopupAnchorRect
  private destroyed: boolean = false

  /** Preferred size changes are only received in Electron v12+ */
  private usingPreferredSize = false

  constructor(opts: PopupViewOptions) {
    this.parent = opts.parent
    this.extensionId = opts.extensionId
    this.anchorWindow = opts.anchorWindow
    this.anchorRect = opts.anchorRect
    this.store = opts.store

    this.anchorWindowBounds = this.anchorWindow ? this.anchorWindow.getBounds() : this.parent ?
      this.parent.getBounds() : null;

    this.browserWindow = new BrowserWindow({
      show: false,
      frame: false,
      parent: opts.parent,
      movable: false,
      maximizable: false,
      minimizable: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: opts.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nativeWindowOpen: true,
        worldSafeExecuteJavaScript: true,
        contextIsolation: true,
        ...({
          enablePreferredSizeMode: true,
        } as any),
      },
    })

    const untypedWebContents = this.browserWindow.webContents as any
    untypedWebContents.on('preferred-size-changed', this.updatePreferredSize)

    this.browserWindow.webContents.on('devtools-closed', this.maybeClose)
    this.browserWindow.on('blur', this.maybeClose)
    this.browserWindow.on('closed', this.destroy)
    this.parent.once('closed', this.destroy)

    this.browserWindow.webContents.on('new-window', (event, url) => {
      event.preventDefault()
      return this.store.newWindow({url: url})
    });

    this.load(opts.url)
  }

  private async load(url: string) {
    const win = this.browserWindow!

    try {
      await win.webContents.loadURL(url)
    } catch (e) {
      console.error(e)
    }

    if (this.destroyed) return

    const hasChildNodes = await this.browserWindow!.webContents.executeJavaScript(
      `((${() => {
        return document.body.hasChildNodes();
      }})())`
    )

    if (!hasChildNodes) {
      this.destroy()
      return
    }

    if (!this.usingPreferredSize) {
      this.setSize({width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight});

      // Wait for content and layout to load
      // Ideally we would wait for DOM to finish loading instead of a timeout which doesn't work reliably
      // E.g.: grammarly depending on machine speed will not show up correctly, and will be locked at a smaller size cutting off content.
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (this.destroyed) return

      await this.queryPreferredSize()
      if (this.destroyed) return
    }

    win.show()
  }

  destroy = () => {
    if (this.destroyed) return

    this.destroyed = true

    debug(`destroying ${this.extensionId}`)

    if (this.parent) {
      if (!this.parent.isDestroyed()) {
        this.parent.off('closed', this.destroy)
      }
      this.parent = undefined
    }

    if (this.browserWindow) {
      if (!this.browserWindow.isDestroyed()) {
        const { webContents } = this.browserWindow

        if (!webContents.isDestroyed() && webContents.isDevToolsOpened()) {
          webContents.closeDevTools()
        }

        this.browserWindow.off('closed', this.destroy)
        this.browserWindow.destroy()
      }

      this.browserWindow = undefined
    }
  }

  isDestroyed() {
    return this.destroyed
  }

  setSize(rect: Partial<Electron.Rectangle>) {
    if (!this.browserWindow || !this.parent) return

    const width = Math.floor(
      Math.min(PopupView.BOUNDS.maxWidth, Math.max(rect.width || 0, PopupView.BOUNDS.minWidth))
    )

    const height = Math.floor(
      Math.min(PopupView.BOUNDS.maxHeight, Math.max(rect.height || 0, PopupView.BOUNDS.minHeight))
    )

    debug(`setSize`, { width, height })

    this.browserWindow?.setBounds({
      ...this.browserWindow.getBounds(),
      width,
      height,
    })
  }

  private maybeClose = () => {
    // Keep open if webContents is being inspected
    if (!this.browserWindow?.isDestroyed() && this.browserWindow?.webContents.isDevToolsOpened()) {
      debug('preventing close due to DevTools being open')
      return
    }

    // For extension popups with a login form, the user may need to access a
    // program outside of the app. Closing the popup would then add
    // inconvenience.
    if (!BrowserWindow.getFocusedWindow()) {
      debug('preventing close due to focus residing outside of the app')
      return
    }

    this.destroy()
  }

  private updatePosition() {
    if (!this.browserWindow || !this.anchorWindowBounds) return

    const viewBounds = this.browserWindow.getBounds()

    let x = this.anchorWindowBounds.x + this.anchorRect.x
    let y = this.anchorWindowBounds.y + this.anchorRect.y

    // Convert to ints
    x = Math.floor(x)
    y = Math.floor(y)

    debug(`updatePosition`, { x, y })

    this.browserWindow.setBounds({
      ...this.browserWindow.getBounds(),
      x,
      y,
    })
  }

  /** Backwards compat for Electron <12 */
  private async queryPreferredSize() {
    if (this.usingPreferredSize || this.destroyed) return

    const rect = await this.browserWindow!.webContents.executeJavaScript(
      `((${() => {

        // rect here will not always reflect truely what the content is, and sometimes
        // reflects what the size of the client window was instead
        // prior to this call, we'll set our window width/height to the minimum and if our bounding rect here is unchanged from that
        // we will manually calculate children to get a more accurate width or height
        let rect = document.body.getBoundingClientRect()
        var children = document.body.children

        const defaultMinWidth = 25;
        const defaultMinHeight = 25;

        if (rect.width == defaultMinWidth) {
          rect.width = 0;
          for (var i = 0; i < children.length; i++) {
            //@ts-ignore
            rect.width += children[i].offsetWidth;
          }
        }

        if (rect.height == defaultMinHeight) {
          rect.height = 0;
          for (var i = 0; i < children.length; i++) {
            //@ts-ignore
            rect.height += children[i].offsetHeight;
          }
        }

        return { width: rect.width, height: rect.height }
      }})())`
    )

    if (this.destroyed) return

    this.setSize({ width: rect.width, height: rect.height })
    this.updatePosition()
  }

  private updatePreferredSize = (event: Electron.Event, size: Electron.Size) => {
    debug('updatePreferredSize', size)
    this.usingPreferredSize = true
    this.setSize(size)
    this.updatePosition()
  }
}
