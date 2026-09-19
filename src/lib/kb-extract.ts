import { inflateRawSync } from "node:zlib";
import { PDFParse } from "pdf-parse";

export type ExtractStatus = "PARSED" | "EMPTY" | "FAILED";

export type ExtractResult = {
  text: string;
  status: ExtractStatus;
  note: string;
};

const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "xml",
  "log", "yaml", "yml", "ini", "conf", "srt", "vtt"
];

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

export function kindOf(filename: string): "text" | "image" | "rich" {
  const ext = extensionOf(filename);
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (ext === "docx" || ext === "zip" || ext === "doc" || ext === "pptx") return "rich";
  return "text";
}

/* ---------------------------------- ZIP ---------------------------------- */

function findEndOfCentralDirectory(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** 纯 Node 实现的 ZIP 解包（读取中央目录，支持 store / deflate）。 */
export function unzipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) return entries;

  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      try {
        entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
      } catch {
        entries.set(name, Buffer.alloc(0));
      }
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/* --------------------------------- XML text ------------------------------- */

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<w:br\b[^>]*\/?>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<\/text:p>/g, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

/* ----------------------------------- DOCX --------------------------------- */

function extractDocx(buf: Buffer): ExtractResult {
  const entries = unzipEntries(buf);
  if (entries.size === 0) {
    return { text: "", status: "FAILED", note: "无法解析 docx（非 ZIP 结构）" };
  }

  const parts: string[] = [];
  const documentXml = entries.get("word/document.xml");
  if (documentXml) parts.push(xmlToText(documentXml.toString("utf8")));

  // 页眉 / 页脚 / 脚注里的文字也一并纳入
  for (const [name, content] of entries) {
    if (/^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(name)) {
      parts.push(xmlToText(content.toString("utf8")));
    }
  }

  const mediaCount = [...entries.keys()].filter((n) => n.startsWith("word/media/")).length;
  const text = normalizeWhitespace(parts.join("\n"));
  if (!text) {
    return {
      text: "",
      status: "EMPTY",
      note: mediaCount > 0 ? `文档仅含 ${mediaCount} 张图片，暂无文字` : "未提取到文字内容"
    };
  }
  return {
    text,
    status: "PARSED",
    note: mediaCount > 0 ? `已提取正文（含 ${mediaCount} 张内嵌图片，图片未做 OCR）` : "已提取正文"
  };
}

/* ----------------------------------- PDF ---------------------------------- */

function extractPdfFromContent(content: string): string {
  const collected: string[] = [];
  const matches = content.match(/\((?:\\.|[^\\()])*\)/g);
  if (!matches) return "";
  for (const item of matches) {
    const inner = item.slice(1, -1).replace(/\\([()\\])/g, "$1").replace(/\\[nrt]/g, " ");
    if (inner.trim()) collected.push(inner);
  }
  return collected.join(" ");
}

/** 用 pdf-parse（pdf.js）提取 PDF 文本，支持中文 CID 字体；失败返回 null 走兜底 */
async function extractPdfWithParser(buf: Buffer): Promise<string | null> {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      const text = normalizeWhitespace(result.text || "");
      return text || null;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

async function extractPdfAsync(buf: Buffer): Promise<ExtractResult> {
  // 首选 pdf-parse（pdf.js）：正确处理中文 CID 字体、编码与分页
  const parsed = await extractPdfWithParser(buf);
  if (parsed) {
    return { text: parsed, status: "PARSED", note: "已提取 PDF 文本" };
  }

  // 兜底：朴素启发式（仅对未压缩英文内容流有效）
  const raw = buf.toString("latin1");
  const chunks: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRe.exec(raw))) {
    const body = Buffer.from(match[1], "latin1");
    let decoded = "";
    try {
      decoded = inflateRawSync(body).toString("latin1");
    } catch {
      decoded = match[1];
    }
    // 只处理看起来像 PDF 内容流的解压结果，避免把图片/字体二进制当文本
    if (!/BT[\s\S]*ET|Tj|TJ/.test(decoded)) continue;
    const text = extractPdfFromContent(decoded);
    if (text.trim()) chunks.push(text);
  }

  const text = normalizeWhitespace(chunks.join("\n"));
  if (!text) {
    return {
      text: "",
      status: "EMPTY",
      note: "PDF 未提取到可复制文字（可能是扫描件，建议改传 .txt/.docx 或做 OCR）"
    };
  }
  return { text, status: "PARSED", note: "已提取 PDF 文本（兜底模式）" };
}

/* ---------------------------------- ZIP 包 --------------------------------- */

function extractZipArchive(buf: Buffer): ExtractResult {
  const entries = unzipEntries(buf);
  if (entries.size === 0) {
    return { text: "", status: "FAILED", note: "无法解析压缩包" };
  }

  const parts: string[] = [];
  let fileCount = 0;
  let imageCount = 0;

  for (const [name, content] of entries) {
    if (name.endsWith("/")) continue;
    const ext = extensionOf(name);
    if (IMAGE_EXTENSIONS.includes(ext)) {
      imageCount++;
      continue;
    }
    if (ext === "docx") {
      const inner = extractDocx(content);
      if (inner.text) parts.push(`【${name}】\n${inner.text}`);
      fileCount++;
      continue;
    }
    if (TEXT_EXTENSIONS.includes(ext)) {
      const text = normalizeWhitespace(content.toString("utf8"));
      if (text) parts.push(`【${name}】\n${text}`);
      fileCount++;
    }
  }

  const text = normalizeWhitespace(parts.join("\n\n"));
  if (!text) {
    return {
      text: "",
      status: "EMPTY",
      note: imageCount > 0 ? `压缩包内仅含 ${imageCount} 张图片，暂无文字` : "压缩包内无可解析文本文件"
    };
  }
  return {
    text,
    status: "PARSED",
    note: `已合并 ${fileCount} 个文本文件${imageCount > 0 ? `（另有 ${imageCount} 张图片未做 OCR）` : ""}`
  };
}

/* --------------------------------- utilities ------------------------------- */

export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ----------------------------------- 入口 ---------------------------------- */

export async function extractDocumentText(buf: Buffer, filename: string): Promise<ExtractResult> {
  const ext = extensionOf(filename);

  try {
    if (TEXT_EXTENSIONS.includes(ext)) {
      const text = normalizeWhitespace(buf.toString("utf8"));
      return text
        ? { text, status: "PARSED", note: "已读取文本" }
        : { text: "", status: "EMPTY", note: "文件内容为空" };
    }
    if (ext === "docx") return extractDocx(buf);
    if (ext === "pdf") return await extractPdfAsync(buf);
    if (ext === "zip") return extractZipArchive(buf);
    if (IMAGE_EXTENSIONS.includes(ext)) {
      return { text: "", status: "EMPTY", note: "图片文件：已入库，暂未做 OCR 识别" };
    }
    if (ext === "doc" || ext === "ppt" || ext === "pptx") {
      return { text: "", status: "EMPTY", note: "旧版 Office 格式暂不支持解析，建议另存为 .docx 后重新上传" };
    }

    const text = normalizeWhitespace(buf.toString("utf8"));
    return text
      ? { text, status: "PARSED", note: "按纯文本读取" }
      : { text: "", status: "EMPTY", note: "无法识别的文件格式" };
  } catch (error) {
    return {
      text: "",
      status: "FAILED",
      note: error instanceof Error ? error.message : "解析失败"
    };
  }
}
