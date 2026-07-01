export type StepState = "idle" | "running" | "success" | "error";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RuntimeStatus {
  nodeVersion: string | null;
  nodeOk: boolean;
  npmVersion: string | null;
  openclawVersion: string | null;
}
