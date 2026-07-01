import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { CommandResult } from "./types.js";

const isWindows = platform() === "win32";

export function runCommand(
  command: string,
  args: string[],
  onData?: (chunk: string) => void
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: isWindows,
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: "0"
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      onData?.(chunk);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      onData?.(chunk);
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`
      });
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr
      });
    });
  });
}

export async function commandOutput(command: string, args: string[]): Promise<string | null> {
  const result = await runCommand(command, args);
  if (!result.ok) {
    return null;
  }

  return result.stdout.trim() || result.stderr.trim() || null;
}
