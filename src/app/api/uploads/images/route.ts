/**
 * POST /api/uploads/images —— 定时任务参考图等「随手传」的图片上传。
 *
 * 之前定时任务只能填图片 URL，用户手里有图没地方传。这里给一个最小可用的上传口：
 * 存到 public/uploads/scheduled/，返回站内路径，表单里直接回显缩略图。
 *
 * 只收图片（jpg/png/webp），单张 ≤10MB，一次最多 6 张 —— 与视频任务参考图上限一致。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const dynamic = "force-dynamic";

const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Map([
  [".jpg", "jpg"],
  [".jpeg", "jpg"],
  [".png", "png"],
  [".webp", "webp"]
]);

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const form = await request.formData();
  const files = (form.getAll("file") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  if (!files.length) return jsonError("没有收到文件。");
  if (files.length > MAX_FILES) return jsonError(`一次最多上传 ${MAX_FILES} 张。`);

  const dir = join(process.cwd(), "public", "uploads", "scheduled");
  await mkdir(dir, { recursive: true });

  const urls: string[] = [];
  for (const file of files) {
    const ext = extname(file.name).toLowerCase();
    const normalized = ALLOWED.get(ext);
    if (!normalized) return jsonError("只支持 JPG / PNG / WebP。");
    if (file.size > MAX_BYTES) return jsonError(`单张不能超过 ${MAX_BYTES / 1024 / 1024}MB。`);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${normalized}`;
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));
    urls.push(`/uploads/scheduled/${name}`);
  }

  return jsonOk({ urls });
}
