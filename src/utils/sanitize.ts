/**
 * Lightweight sanitizer for rich-text HTML coming out of the Ifaida editor.
 *
 * HONEST LIMITATION: this is a regex-based stripper, not a full HTML-parser
 * sanitizer (like DOMPurify). It removes the highest-risk vectors — <script>
 * tags, inline event handlers (onclick=, onerror=, ...), and javascript:
 * URLs — which covers the realistic threat surface for content typed through
 * our own toolbar-driven editor. It is NOT a substitute for a proper
 * allow-list HTML sanitizer if this editor ever accepts pasted/arbitrary
 * external HTML at scale; that would be the right next hardening step.
 */
export function sanitizeRichText(html: string): string {
  if (typeof html !== "string") return "";

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "") // onclick=, onerror=, etc.
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>/gi, "");
}
