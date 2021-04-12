import { BrowserWindow, Session } from 'electron'

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

  private anchorRect: PopupAnchorRect
  private destroyed: boolean = false

  /** Preferred size changes are only received in Electron v12+ */
  private usingPreferredSize = false

  constructor(opts: PopupViewOptions) {
    this.parent = opts.parent
    this.extensionId = opts.extensionId
    this.anchorWindow = opts.anchorWindow
    this.anchorRect = opts.anchorRect

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
    this.browserWindow.webContents.on('dom-ready', this.domReady)
    this.browserWindow.on('blur', this.maybeClose)
    this.browserWindow.on('closed', this.destroy)
    this.parent.once('closed', this.destroy)

    this.load(opts.url)
  }

  private async load(url: string) {
    const win = this.browserWindow!

    try {
      await win.webContents.loadURL(url)
    } catch (e) {
      console.error(e)
    }
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

  private domReady = async () => {
    const win = this.browserWindow!

    if (!this.usingPreferredSize) {
      this.setSize({width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight});
      await new Promise((resolve) => setTimeout(resolve, 200))
      await this.queryPreferredSize()
    }

    win.show()
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

        var rect = {
          width: 0,
          height: 0
        };

        var body = document.body,
            html = document.documentElement;

          rect.width = Math.max( body.scrollWidth, body.offsetWidth,
            html.clientWidth, html.scrollWidth, html.offsetWidth );

          rect.height = Math.max( body.scrollHeight, body.offsetHeight,
            html.clientHeight, html.scrollHeight, html.offsetHeight );
        return rect;
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
