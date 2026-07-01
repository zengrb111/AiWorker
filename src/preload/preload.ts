import { contextBridge, ipcRenderer } from "electron";
import type { CommandResult, RuntimeStatus } from "../main/types.js";

export interface OpenClawApi {
  status: () => Promise<RuntimeStatus>;
  install: () => Promise<CommandResult>;
  onboard: () => Promise<CommandResult>;
  agentStatus: () => Promise<CommandResult>;
  doctor: () => Promise<CommandResult>;
  openVSCode: () => Promise<CommandResult>;
  message: (message: string) => Promise<CommandResult>;
  onLog: (callback: (message: string) => void) => () => void;
}

const api: OpenClawApi = {
  status: () => ipcRenderer.invoke("openclaw:status"),
  install: () => ipcRenderer.invoke("openclaw:install"),
  onboard: () => ipcRenderer.invoke("openclaw:onboard"),
  agentStatus: () => ipcRenderer.invoke("openclaw:agent-status"),
  doctor: () => ipcRenderer.invoke("openclaw:doctor"),
  openVSCode: () => ipcRenderer.invoke("openclaw:open-vscode"),
  message: (message: string) => ipcRenderer.invoke("openclaw:message", message),
  onLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string): void => {
      callback(message);
    };

    ipcRenderer.on("openclaw:log", listener);
    return () => ipcRenderer.removeListener("openclaw:log", listener);
  }
};

contextBridge.exposeInMainWorld("openclaw", api);
