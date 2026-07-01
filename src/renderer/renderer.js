const api = window.openclaw;

const elements = {
  nodeVersion: document.querySelector("#nodeVersion"),
  nodeHealth: document.querySelector("#nodeHealth"),
  npmVersion: document.querySelector("#npmVersion"),
  openclawVersion: document.querySelector("#openclawVersion"),
  refreshButton: document.querySelector("#refreshButton"),
  openVSCodeButton: document.querySelector("#openVSCodeButton"),
  installButton: document.querySelector("#installButton"),
  onboardButton: document.querySelector("#onboardButton"),
  agentStatusButton: document.querySelector("#agentStatusButton"),
  doctorButton: document.querySelector("#doctorButton"),
  clearLogButton: document.querySelector("#clearLogButton"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  logOutput: document.querySelector("#logOutput")
};

const actionButtons = [
  elements.refreshButton,
  elements.openVSCodeButton,
  elements.installButton,
  elements.onboardButton,
  elements.agentStatusButton,
  elements.doctorButton
];

function appendLog(message) {
  elements.logOutput.textContent += message;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setBusy(isBusy) {
  for (const button of actionButtons) {
    button.disabled = isBusy;
  }
}

function renderStatus(status) {
  elements.nodeVersion.textContent = status.nodeVersion ?? "Missing";
  elements.nodeHealth.textContent = status.nodeOk
    ? "Compatible"
    : "Needs Node 24 or Node 22.19+";
  elements.nodeHealth.classList.toggle("error", !status.nodeOk);
  elements.npmVersion.textContent = status.npmVersion ?? "Missing";
  elements.openclawVersion.textContent = status.openclawVersion ?? "Not installed";
}

async function refreshStatus() {
  setBusy(true);
  try {
    renderStatus(await api.status());
  } catch (error) {
    appendLog(`Could not read system status: ${String(error)}\n`);
  } finally {
    setBusy(false);
  }
}

async function runAction(label, action) {
  setBusy(true);
  appendLog(`\n== ${label} ==\n`);

  try {
    const result = await action();
    if (result.stdout) {
      appendLog(result.stdout);
    }
    if (result.stderr) {
      appendLog(result.stderr);
    }
    appendLog(result.ok ? "\nDone.\n" : `\nFailed with exit code ${result.code ?? "unknown"}.\n`);
  } catch (error) {
    appendLog(`Unexpected error: ${String(error)}\n`);
  } finally {
    await refreshStatus();
    setBusy(false);
  }
}

elements.refreshButton.addEventListener("click", refreshStatus);
elements.openVSCodeButton.addEventListener("click", () => runAction("Open in VS Code", api.openVSCode));
elements.installButton.addEventListener("click", () => runAction("Install or update", api.install));
elements.onboardButton.addEventListener("click", () => runAction("Finish setup", api.onboard));
elements.agentStatusButton.addEventListener("click", () => runAction("Gateway status", api.agentStatus));
elements.doctorButton.addEventListener("click", () => runAction("Doctor", api.doctor));
elements.clearLogButton.addEventListener("click", () => {
  elements.logOutput.textContent = "";
});

elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction("Send message", () => api.message(elements.messageInput.value));
});

api.onLog(appendLog);
refreshStatus();
