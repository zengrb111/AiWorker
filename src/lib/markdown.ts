import { escapeHtml } from "@/lib/escape";

/**
 * Simple Markdown → HTML renderer.
 * Supports: headings (#, ##, ###), bold (**), italic (*), lists (-), line breaks, paragraphs.
 * Used by both chat messages and content detail to keep format consistent.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const htmlParts: string[] = [];
  let inList = false;

  function closeList() {
    if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Skip empty lines
    if (!line.trim()) {
      closeList();
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const content = inlineFormat(headingMatch[2]);
      htmlParts.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // List items
    if (line.match(/^[-*]\s+/)) {
      if (!inList) {
        htmlParts.push("<ul>");
        inList = true;
      }
      const itemContent = inlineFormat(line.replace(/^[-*]\s+/, ""));
      htmlParts.push(`<li>${itemContent}</li>`);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      closeList();
      const content = inlineFormat(line.slice(2));
      htmlParts.push(`<blockquote>${content}</blockquote>`);
      continue;
    }

    // Regular paragraph
    closeList();
    htmlParts.push(`<p>${inlineFormat(line)}</p>`);
  }

  closeList();
  return htmlParts.join("");
}

/** Inline formatting: bold, italic, inline code. */
function inlineFormat(text: string): string {
  let result = escapeHtml(text);
  // Bold **text**
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic *text* (but not conflicting with bold)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  // Inline code `text`
  result = result.replace(/`(.+?)`/g, "<code>$1</code>");
  return result;
}
