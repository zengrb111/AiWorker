/**
 * 解析「去 AI 味」模型的输出。
 *
 * 目标格式（prompt 里要求的顺序）：AI 味检测报告 → 修改后正文 → 质检报告。
 * 同时兼容两种历史格式（正文在前/报告在后、报告在前/正文在后），
 * 保证 normalizeHumanizerOutput 永远输出「诊断 → 正文 → 质检」的固定顺序。
 */

/** 「AI 味检测报告」等诊断类小标题（正文之前的第一段）。 */
const DETECT_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:AI[ \t]*味?[ \t]*(?:检测|诊断)[ \t]*报告|AI[ \t]*味?[ \t]*(?:检测|诊断)|检测报告|诊断报告)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 「修改后正文」小标题（正文的起点标记，兼容多种写法）。 */
const BODY_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:修改后(?:的)?(?:全文|正文)|润色后(?:的)?(?:全文|正文)|润色全文|优化后(?:的)?(?:全文|正文)|去\s?AI\s?味后(?:的)?(?:全文|正文)|正文)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 「质检报告」小标题（正文的结束标记）。 */
const QC_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:质检报告|质量检查报告|质量自检报告|质检结论|质检)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 旧格式（正文在前、报告在后）里报告的起点。 */
const LEGACY_REPORT_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:AI[ \t]*味?[ \t]*(?:检测|诊断)[ \t]*报告|检测报告|修改统计|修改说明|质检报告|质量检查报告)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 最老格式里的「润色后全文」小标题。 */
const LEGACY_BODY_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:润色后全文|润色后的全文|润色全文|优化后全文|去\s?AI\s?味后全文|修改后全文)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 去掉正文首尾的空白与残留分隔线。 */
export function cleanBody(text: string): string {
  return text
    .replace(/^[\s\n]+/, "")
    .replace(/(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,}|—{2,}|={3,})[ \t]*)+[\s]*$/, "")
    .replace(/[\s\n]+$/, "")
    .trim();
}

/**
 * 按新格式（检测报告 → 修改后正文 → 质检报告）把输出切成三段。
 * 切不出来返回 null，交给旧格式兜底。
 */
function splitHumanizerSections(content: string): { head: string; body: string; tail: string } | null {
  const bodyHeading = BODY_HEADING.exec(content);
  if (bodyHeading) {
    const after = content.slice(bodyHeading.index + bodyHeading[0].length);
    const qc = QC_HEADING.exec(after);
    const body = cleanBody(qc ? after.slice(0, qc.index) : after);
    if (body) {
      return {
        head: content.slice(0, bodyHeading.index).trim(),
        body,
        tail: qc ? after.slice(qc.index).trim() : ""
      };
    }
  }

  // 旧格式：正文在前、报告在后
  const reportsStart = LEGACY_REPORT_HEADING.exec(content);
  if (reportsStart && reportsStart.index > 0) {
    const body = cleanBody(content.slice(0, reportsStart.index));
    if (body) {
      const reports = content.slice(reportsStart.index);
      const qc = QC_HEADING.exec(reports);
      return {
        head: qc ? reports.slice(0, qc.index).trim() : reports.trim(),
        body,
        tail: qc ? reports.slice(qc.index).trim() : ""
      };
    }
  }

  // 最老格式：报告在前、正文在后
  const legacyBody = LEGACY_BODY_HEADING.exec(content);
  if (legacyBody) {
    const after = content.slice(legacyBody.index + legacyBody[0].length);
    const qc = QC_HEADING.exec(after);
    const body = cleanBody(qc ? after.slice(0, qc.index) : after);
    if (body) {
      return {
        head: content.slice(0, legacyBody.index).trim(),
        body,
        tail: qc ? after.slice(qc.index).trim() : ""
      };
    }
  }

  return null;
}

/** 彻底解析不出结构时的正文兜底：优先取检测报告之后、质检报告之前的内容。 */
function fallbackBody(content: string): string {
  const firstReport = DETECT_HEADING.exec(content) ?? LEGACY_REPORT_HEADING.exec(content);
  if (!firstReport) return cleanBody(content);
  const after = content.slice(firstReport.index + firstReport[0].length);
  const qc = QC_HEADING.exec(after);
  const candidate = cleanBody(qc ? after.slice(0, qc.index) : after);
  return candidate || cleanBody(content);
}

/** 去掉首尾残留的分隔线与空白（head / tail 拼接时避免出现重复分隔线）。 */
function stripSeparators(text: string): string {
  return text
    .replace(/^(?:[ \t]*(?:-{3,}|\*{3,}|_{3,}|—{2,}|={3,})[ \t]*\n?)+/, "")
    .replace(/(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,}|—{2,}|={3,})[ \t]*)+\s*$/, "")
    .trim();
}

/**
 * 把模型输出归一化成「检测报告 → 修改后正文 → 质检报告」的固定顺序，
 * 同时抽出用于回写内容库的正文。
 */
export function normalizeHumanizerOutput(raw: string): { display: string; body: string } {
  const content = raw.replace(/\r\n/g, "\n").trim();
  if (!content) return { display: "", body: "" };

  const sections = splitHumanizerSections(content);
  if (!sections) {
    return { display: content, body: fallbackBody(content) };
  }

  const parts: string[] = [];
  const head = stripSeparators(sections.head);
  if (head) parts.push(head);
  parts.push(`### 修改后正文\n\n${sections.body}`);
  const tail = stripSeparators(sections.tail);
  if (tail) parts.push(tail);

  return { display: parts.join("\n\n---\n\n"), body: sections.body };
}
