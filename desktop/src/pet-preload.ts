import { contextBridge, ipcRenderer } from "electron";
import type { PetSnapshot } from "./pet-state.js";

export type PetApi = {
  subscribe(callback: (state: PetSnapshot) => void): () => void;
  pointer(action: "start" | "move" | "end" | "cancel", peer?: string): void;
};

let latest: PetSnapshot | undefined;
const listeners = new Set<(state: PetSnapshot) => void>();
ipcRenderer.on("teamhub-pet:state", (_event, state: PetSnapshot) => {
  latest = state;
  for (const listener of listeners) listener(state);
});
const api: PetApi = {
  subscribe(callback) {
    listeners.add(callback);
    if (latest) callback(latest);
    return () => { listeners.delete(callback); };
  },
  pointer(action, peer) { ipcRenderer.send("teamhub-pet:pointer", action, peer); },
};
contextBridge.exposeInMainWorld("teamhubPets", api);
