import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 以 iframe 方式把静态原型引入平台。
 * 直接读取仓库中的 outputs/知识库原型.html，保证原型只有一份源文件。
 * 支持 #embed=<section> 形式直达指定分区（原型内部会隐藏自身侧栏）。
 */
export async function GET() {
  const file = path.join(process.cwd(), "outputs", "知识库原型.html");
  try {
    const html = await readFile(file, "utf8");
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch {
    return new Response(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"/>
       <body style="font-family:system-ui;padding:40px;color:#334155">
         <h2>未找到原型文件</h2>
         <p>请在项目根目录保留 <code>outputs/知识库原型.html</code>。</p>
       </body></html>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
}
