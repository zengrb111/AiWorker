import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * 龙虾从服务器本地磁盘交给平台的路径，统一在这里做白名单校验。
 *
 * 抽成共享模块的原因：视频成片（content-ingest-video.ts）和 huashu 项目目录
 * （agent-studio.ts）都要校验，规则必须一致；且不能让两个模块互相 import
 * 形成循环依赖。
 *
 * 默认允许：平台 public/、huashu-motion 仓库、OpenClaw workspace；
 * 部署到别的路径时用 AGENT_VIDEO_IMPORT_DIRS（分号或冒号分隔）追加。
 */

export function allowedSourceDirs(): string[] {
  const dirs: string[] = [
    join(process.cwd(), "public"),
    process.env.HUASHU_MOTION_ROOT || "",
    process.env.OPENCLAW_WORKSPACE_ROOT || join(homedir(), ".openclaw", "workspace"),
    // 多 agent 之后每个用户 agent 的工作区在 workspaces/<agentId>/（复数），
    // 只放单数 workspace 会让 agent 传自己生成的参考图被白名单拒掉。
    join(homedir(), ".openclaw", "workspaces")
  ];
  const extra = (process.env.AGENT_VIDEO_IMPORT_DIRS || "")
    .split(/[;:]/)
    .map((d) => d.trim())
    .filter(Boolean);
  return [...dirs, ...extra]
    .filter(Boolean)
    .map((d) => {
      try {
        return realpathSync(resolve(d));
      } catch {
        return resolve(d);
      }
    });
}

/** realpath 后必须落在白名单目录内，防 `..` 穿越与符号链接逃逸。 */
export function assertPathAllowed(abs: string, label = "文件"): void {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`找不到这个${label}，或无法读取：${abs}`);
  }
  const normalized = real.toLowerCase();
  const ok = allowedSourceDirs().some((root) => {
    const r = root.toLowerCase();
    return normalized === r || normalized.startsWith(r.endsWith(sep) ? r : r + sep);
  });
  if (!ok) {
    throw new Error(
      `${label}不在允许的目录内：${real}。可用目录：平台 public、huashu-motion 仓库、OpenClaw workspace` +
        `（也可设 AGENT_VIDEO_IMPORT_DIRS 追加）。`
    );
  }
}

/** 平台自己托管的 huashu 项目目录（与 huashu.ts::projectDirFor 保持同一约定）。 */
export function projectDirFor(token: string): string {
  return join(process.cwd(), "public", "uploads", "huashu", token);
}
