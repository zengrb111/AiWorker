import { commandOutput, runCommand } from "./command.js";
import type { CommandResult, RuntimeStatus } from "./types.js";

type LogSink = (chunk: string) => void;

function parseNodeMajorMinor(version: string | null): { major: number; minor: number } | null {
  if (!version) {
    return null;
  }

  const match = version.match(/v?(\d+)\.(\d+)\./);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2])
  };
}

export function isNodeCompatible(version: string | null): boolean {
  const parsed = parseNodeMajorMinor(version);
  if (!parsed) {
    return false;
  }

  if (parsed.major >= 24) {
    return true;
  }

  return parsed.major === 22 && parsed.minor >= 19;
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const [nodeVersion, npmVersion, openclawVersion] = await Promise.all([
    commandOutput("node", ["--version"]),
    commandOutput("npm", ["--version"]),
    commandOutput("openclaw", ["--version"])
  ]);

  return {
    nodeVersion,
    nodeOk: isNodeCompatible(nodeVersion),
    npmVersion,
    openclawVersion
  };
}

export async function installOpenClaw(onData: LogSink): Promise<CommandResult> {
  return runCommand("npm", ["install", "-g", "openclaw@latest"], onData);
}

export async function runOnboarding(onData: LogSink): Promise<CommandResult> {
  return runCommand("openclaw", ["onboard", "--install-daemon"], onData);
}

export async function getOpenClawStatus(onData: LogSink): Promise<CommandResult> {
  return runCommand("openclaw", ["gateway", "status"], onData);
}

export async function doctorOpenClaw(onData: LogSink): Promise<CommandResult> {
  return runCommand("openclaw", ["doctor"], onData);
}

export async function sendOpenClawAgentMessage(message: string, onData: LogSink): Promise<CommandResult> {
  return runCommand("openclaw", ["agent", "--message", message], onData);
}

export async function openProjectInVSCode(projectPath: string, onData: LogSink): Promise<CommandResult> {
  const result = await runCommand("code", [projectPath], onData);
  if (result.ok) {
    return result;
  }

  return {
    ...result,
    stderr:
      `${result.stderr.trim() ? `${result.stderr.trim()}\n\n` : ""}` +
      "Could not find the VS Code command line tool. Install Visual Studio Code, then enable the 'code' command from the Command Palette."
  };
}
