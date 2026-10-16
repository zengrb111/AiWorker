/**
 * Python 解释器解析。
 *
 * 项目里有两处需要 Python：
 * - TTS（edge-tts）：src/lib/tts.ts
 * - DSH 分镜规划：scripts/dsh-storyboard/main.py（需要 Python 3.10+）
 *
 * 原本只有 tts.ts 内联了一个 resolvePythonPath()，DSH 接入时抽到这里共用，
 * 顺带修掉两个问题：
 * 1. 原实现硬编码了另一个用户名的家目录路径（.workbuddy\binaries\...），换机器就找不到；
 * 2. 没有区分「要 3.10+」和「能用就行」两种需求。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 托管 Python 的位置。同一台机器上有多套解释器，各自装不同的包，
 * 所以 TTS 与 DSH 必须用**不同的优先顺序**：
 * - TTS 依赖 edge-tts，装在托管的 default 环境里；
 * - DSH 依赖 deepseek-harness-sdk，装在仓库内的 .dsh-venv 里。
 * 顺序混用会导致「解释器找到了但 import 不到模块」这类很难查的问题。
 */
function managedCandidates(): string[] {
  const managedRoot = join(homedir(), ".workbuddy", "binaries", "python");
  return [
    // 托管的 default 环境（已装 edge-tts 等常用包）
    join(managedRoot, "envs", "default", "Scripts", "python.exe"),
    join(managedRoot, "envs", "default", "bin", "python"),
    // 托管的解释器本体
    join(managedRoot, "versions", "3.13.12", "python.exe"),
  ];
}

/** DSH 专用 venv（在仓库内，见 scripts/dsh-storyboard/requirements.txt）。 */
function dshVenvCandidates(): string[] {
  return [
    join(process.cwd(), ".dsh-venv", "Scripts", "python.exe"),
    join(process.cwd(), ".dsh-venv", "bin", "python"),
  ];
}

function existing(candidates: string[]): string[] {
  return candidates.filter((p): p is string => Boolean(p) && existsSync(p));
}

/**
 * edge-tts 等本地脚本用的 Python：环境变量 → 托管 default 环境 → PATH。
 * 找不到时返回 "python"，交给系统 PATH 解析，失败会在调用处报出真实原因。
 *
 * 注意这里刻意不含 .dsh-venv：那个环境只装了 DSH，没有 edge-tts。
 *
 * ⚠ 维护提醒：本机有多套 Python（托管 3.13 与 PATH 3.12 各自独立 site-packages），
 * 升级依赖**必须用本函数实际选中的那个解释器**，否则会出现「升级过了但依然报错」
 * 的假象。2026-10-16 就踩过：`pip install -U edge-tts` 装进了 PATH 的 3.12，
 * 而本函数选的是托管 3.13（还停在 7.2.8），结果 edge-tts 握手持续 403。
 * tts.ts 的报错里已强制打印解释器路径，排查时先看那一行。
 */
export function resolvePythonPath(): string {
  const ordered = [...existing([process.env.PYTHON_PATH ?? ""]), ...existing(managedCandidates())];
  return ordered[0] || "python";
}

/** 读解释器版本号，形如 "3.13.12"；读不到返回 null。 */
async function readPythonVersion(
  pythonPath: string,
): Promise<{ major: number; minor: number } | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(pythonPath, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"], {
      timeout: 10_000,
      windowsHide: true,
    });
    const match = /(\d+)\.(\d+)/.exec(stdout);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    return null;
  }
}

/** DSH 最低版本要求：deepseek-harness-sdk 需要 Python 3.10+。 */
export const DSH_MIN_PYTHON = { major: 3, minor: 10 } as const;

/**
 * DSH 要用的 Python：`.dsh-venv`（装了 deepseek-harness-sdk）优先，
 * 其次环境变量、托管环境，最后才是系统 PATH。
 *
 * 顺序里 .dsh-venv 必须排第一：托管 default 环境虽然版本更高，但没装 DSH，
 * 选中它会在 import 时才炸，报错信息指向 site-packages 而非真正的原因。
 *
 * 每个候选还要满足 Python >= 3.10；找不到合格解释器时把探测结果一并抛出 ——
 * DSH 装在 3.8/3.9 上会直接语法报错，那种堆栈对排查毫无帮助。
 */
export async function resolveDshPython(): Promise<string> {
  const ordered = [
    ...existing(dshVenvCandidates()),
    ...existing([process.env.PYTHON_DSH_PATH ?? process.env.PYTHON_PATH ?? ""]),
    ...existing(managedCandidates()),
  ];
  const tried: string[] = [];
  for (const candidate of ordered) {
    const version = await readPythonVersion(candidate);
    if (!version) {
      tried.push(`${candidate}（无法执行）`);
      continue;
    }
    if (version.major > DSH_MIN_PYTHON.major) return candidate;
    if (version.major === DSH_MIN_PYTHON.major && version.minor >= DSH_MIN_PYTHON.minor) {
      return candidate;
    }
    tried.push(
      `${candidate}（版本 ${version.major}.${version.minor}，低于 ${DSH_MIN_PYTHON.major}.${DSH_MIN_PYTHON.minor}）`,
    );
  }
  throw new Error(
    [
      `未找到可用的 Python ${DSH_MIN_PYTHON.major}.${DSH_MIN_PYTHON.minor}+ 解释器，DSH 分镜规划无法运行。`,
      "推荐做法：在仓库根执行 python -m venv .dsh-venv 并安装 scripts/dsh-storyboard/requirements.txt。",
      "已探测：",
      ...(tried.length ? tried.map((t) => `  - ${t}`) : ["  - （没有任何候选解释器存在）"]),
    ].join("\n"),
  );
}
