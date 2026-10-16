/**
 * 让 `node --experimental-strip-types` 能直接 import 项目里的 TS 源码。
 *
 * 背景：项目 TS 源码按 Next.js 惯例用无扩展名的相对 import（`from "../env"`）。
 * Node 的类型剥离不做扩展名补全，于是脚本一 import pipeline.ts 就报
 * ERR_MODULE_NOT_FOUND。tsc / Next 有自己的解析器，脚本没有。
 *
 * 这里用 Node 24 的同步 resolve hook 补上 `.ts`：只对「相对路径 + 无扩展名」的
 * 情况补后缀，其余（包名、已有扩展名）一律原样放行，不改变 Node 的默认行为。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-resolver.mts your-script.mts
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 依次尝试这些后缀，取第一个真实存在的。顺序与 TS 的 moduleResolution 习惯一致。 */
const CANDIDATE_SUFFIXES = [".ts", ".tsx", ".mts", ".js"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 只处理相对路径的裸目录/文件引用，包名与带扩展名的路径交回默认解析
    if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(specifier, context);
    }

    const base = new URL(specifier, context.parentURL);
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = new URL(base.href + suffix);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(base.href + suffix, context);
      }
    }
    // 试完都不存在，抛一个比 Node 默认报错更明确的错误
    throw new Error(
      `ts-resolver: 找不到 ${specifier}（从 ${context.parentURL} 解析）。` +
        `已尝试：${CANDIDATE_SUFFIXES.join(" / ")}`,
    );
  },
});