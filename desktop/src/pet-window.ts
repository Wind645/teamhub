import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type Point } from "electron";
import { join } from "node:path";
import { petLayout, type PetMember, type PetPreferences } from "./pet-state.js";

type Drag = { peer: string; cursor: Point; origin: Point; moved: boolean };
const pointerChannel = "teamhub-pet:pointer";
const stateChannel = "teamhub-pet:state";

export class PetWindow {
  private window?: BrowserWindow;
  private loaded = false;
  private published = "";
  private position?: Point;
  private width = 0;
  private height = 0;
  private drag?: Drag;
  private timer?: NodeJS.Timeout;
  private members: PetMember[] = [];

  constructor(
    private readonly preferences: () => PetPreferences,
    private readonly savePosition: (position: Point) => void,
    private readonly focusMember: (peer: string) => void,
    private readonly refresh: () => void,
  ) {}

  update(members: PetMember[], until?: number) {
    this.members = members;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!members.length || !this.preferences().enabled) { this.close(); return; }
    if (!this.window) this.open();
    this.render();
    if (until !== undefined) this.timer = setTimeout(this.refresh, Math.max(1, until - Date.now()));
  }

  private open() {
    this.position = this.preferences().position;
    this.loaded = false;
    this.published = "";
    const window = this.window = new BrowserWindow({
      title: "TeamHub 桌宠", width: 150, height: 154, show: false, transparent: true, frame: false,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false,
      webPreferences: {
        preload: join(__dirname, "pet-preload.cjs"), nodeIntegration: false, contextIsolation: true,
        sandbox: true, backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.on("page-title-updated", event => event.preventDefault());
    window.on("closed", () => {
      if (this.window === window) this.release();
    });
    ipcMain.on(pointerChannel, this.pointer);
    screen.on("display-added", this.displaysChanged);
    screen.on("display-removed", this.displaysChanged);
    screen.on("display-metrics-changed", this.displaysChanged);
    void window.loadFile(join(__dirname, "ui", "pet.html")).then(() => {
      if (this.window !== window) return;
      this.loaded = true;
      this.render();
      window.showInactive();
    }).catch(cause => {
      if (this.window !== window) return;
      console.error("Could not open desktop pets", cause);
      this.close();
    });
  }

  private render(displayPoint = this.position) {
    const window = this.window;
    if (!window || !this.members.length) return;
    const area = (displayPoint ? screen.getDisplayNearestPoint(displayPoint) : screen.getPrimaryDisplay()).workArea;
    const { width, height } = petLayout(this.members.length, area.width);
    const visibleHeight = Math.min(height, area.height);
    const position = this.position ?? { x: area.x + area.width - width - 16, y: area.y + area.height - visibleHeight - 16 };
    const x = Math.max(area.x, Math.min(position.x, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(position.y, area.y + area.height - visibleHeight));
    if (this.position && !this.drag) this.position = { x, y };
    const current = window.getBounds();
    if (current.x !== x || current.y !== y || this.width !== width || this.height !== visibleHeight) {
      this.width = width;
      this.height = visibleHeight;
      window.setBounds({ x, y, width, height: visibleHeight });
    }
    const state = { members: this.members };
    const serialized = JSON.stringify(state);
    if (this.loaded && serialized !== this.published) {
      this.published = serialized;
      window.webContents.send(stateChannel, state);
    }
  }

  private displaysChanged = () => {
    this.drag = undefined;
    this.render();
  };

  private pointer = (event: IpcMainEvent, action: string, peer?: string) => {
    const window = this.window;
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
    if (action === "start") {
      if (this.drag || !peer || !this.members.some(member => member.peer === peer)) return;
      const { x, y } = window.getBounds();
      this.drag = { peer, cursor: screen.getCursorScreenPoint(), origin: { x, y }, moved: false };
      return;
    }
    const drag = this.drag;
    if (!drag) return;
    if (action === "cancel") { this.drag = undefined; return; }
    if (action !== "move" && action !== "end") return;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - drag.cursor.x;
    const dy = cursor.y - drag.cursor.y;
    if (drag.moved || Math.hypot(dx, dy) >= 6) {
      drag.moved = true;
      this.position = { x: drag.origin.x + dx, y: drag.origin.y + dy };
      this.render(cursor);
    }
    if (action !== "end") return;
    this.drag = undefined;
    if (drag.moved) {
      const { x, y } = window.getBounds();
      this.position = { x, y };
      this.savePosition(this.position);
    } else {
      this.focusMember(drag.peer);
    }
  };

  private release() {
    this.window = undefined;
    this.loaded = false;
    this.width = this.height = 0;
    this.drag = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    ipcMain.off(pointerChannel, this.pointer);
    screen.off("display-added", this.displaysChanged);
    screen.off("display-removed", this.displaysChanged);
    screen.off("display-metrics-changed", this.displaysChanged);
  }

  close() {
    const window = this.window;
    if (!window) return;
    this.release();
    window.destroy();
  }
}
