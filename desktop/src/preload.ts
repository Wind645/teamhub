import { contextBridge, ipcRenderer } from "electron";
import type { Api, Snapshot } from "./protocol.js";

const invoke = async (name: string, ...args: unknown[]) => {
  const reply = await ipcRenderer.invoke("teamhub:" + name, ...args);
  if (!reply.ok) throw new Error(reply.issue.detail);
  return reply.value;
};
const api: Api = {
  members: () => invoke("members"),
  openMember: peer => invoke("openMember", peer),
  memberPicker: () => invoke("memberPicker"),
  setPetsEnabled: enabled => invoke("setPetsEnabled", enabled),
  state: () => invoke("state"),
  subscribe(callback) {
    const handler = (_event: Electron.IpcRendererEvent, state: Snapshot) => callback(state);
    ipcRenderer.on("teamhub:state", handler);
    return () => ipcRenderer.off("teamhub:state", handler);
  },
  folder: () => invoke("folder"),
  create: path => invoke("create", path),
  importSession: () => invoke("importSession"),
  select: id => invoke("select", id),
  command: (id, command) => invoke("command", id, command),
  retry: id => invoke("retry", id),
  peers: id => invoke("peers", id),
  importProfile: () => invoke("importProfile"),
  saveProfile: (profile, key, persist, clear) => invoke("saveProfile", profile, key, persist, clear),
  artifact: (id, seq, action) => invoke("artifact", id, seq, action),
  confirm: (title, detail) => invoke("confirm", title, detail),
};
contextBridge.exposeInMainWorld("teamhub", api);
