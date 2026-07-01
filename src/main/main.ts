import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  doctorOpenClaw,
  getOpenClawStatus,
  getRuntimeStatus,
  installOpenClaw,
  openProjectInVSCode,
  runOnboarding,
  sendOpenClawAgentMessage
} from "./openclaw.js";

let mainWindow: BrowserWindow | null = null;

function sendLog(message: string): void {
  mainWindow?.webContents.send("openclaw:log", message);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: "OpenClaw Desktop",
    backgroundColor: "#f6f3ed",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("openclaw:status", async () => getRuntimeStatus());

ipcMain.handle("openclaw:install", async () => {
  sendLog("Installing or updating openclaw@latest...\n");
  return installOpenClaw(sendLog);
});

ipcMain.handle("openclaw:onboard", async () => {
  sendLog("Running OpenClaw onboarding...\n");
  return runOnboarding(sendLog);
});

ipcMain.handle("openclaw:agent-status", async () => {
  sendLog("Reading OpenClaw gateway status...\n");
  return getOpenClawStatus(sendLog);
});

ipcMain.handle("openclaw:doctor", async () => {
  sendLog("Running OpenClaw doctor...\n");
  return doctorOpenClaw(sendLog);
});

ipcMain.handle("openclaw:open-vscode", async () => {
  sendLog("Opening this project in VS Code...\n");
  return openProjectInVSCode(process.cwd(), sendLog);
});

ipcMain.handle("openclaw:message", async (_event, message: string) => {
  const safeMessage = message.trim();
  if (!safeMessage) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: "Please enter a message before sending."
    };
  }

  sendLog(`Sending message: ${safeMessage}\n`);
  return sendOpenClawAgentMessage(safeMessage, sendLog);
});
