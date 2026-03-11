/**
 * gcm/spec.ts — GCM (GMS Confluence Markup) shared constants and utilities.
 *
 * Provides attribute parsing, escaping, and front-matter helpers used by both
 * the HTML→GCM converter and the GCM→HTML converter.
 *
 * Ported from greenhouse/scripts/confluence/gcm_spec.py
 */

// ---------------------------------------------------------------------------
// File extension
// ---------------------------------------------------------------------------

export const GCM_EXT = ".gcm";

// ---------------------------------------------------------------------------
// Front-matter
// ---------------------------------------------------------------------------

export function formatFrontmatter(
  title: string,
  pageId: string,
  version: string | number,
  sourceUrl = "",
): string {
  const lines = ["--- gcm ---"];
  lines.push(`title: ${title}`);
  lines.push(`page_id: ${pageId}`);
  lines.push(`version: ${version}`);
  if (sourceUrl) {
    lines.push(`source: ${sourceUrl}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export interface GcmMetadata {
  [key: string]: string;
}

export function parseFrontmatter(text: string): [GcmMetadata, string] {
  const m = text.match(/^--- gcm ---\n([\s\S]*?)\n---\n?/);
  if (!m) return [{}, text];
  const metaBlock = m[1]!;
  const body = text.slice(m[0].length);
  const meta: GcmMetadata = {};
  for (const line of metaBlock.split("\n")) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      meta[k] = v;
    }
  }
  return [meta, body];
}

// ---------------------------------------------------------------------------
// Tag attribute parsing / formatting
// ---------------------------------------------------------------------------

/**
 * Parse 'key=value key2="val with spaces"' into a Record.
 *
 * Supports:
 *   key=value          (unquoted, no spaces)
 *   key="value"        (double-quoted)
 *   key='value'        (single-quoted)
 */
export function parseTagAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1]!;
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[key] = val;
  }
  return attrs;
}

/**
 * Format a Record into 'key=value key2="val ue"' string.
 */
export function formatTagAttrs(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === "") continue;
    if (v.includes(" ") || v.includes('"') || v.includes("'") || v.includes("=")) {
      const vEsc = v.replace(/"/g, '\\"');
      parts.push(`${k}="${vEsc}"`);
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Inline escaping (GCM special chars)
// ---------------------------------------------------------------------------

const INLINE_SPECIAL = /([{}*\[\]~`\\])/g;

/** Escape GCM special characters in plain text. */
export function escapeInline(text: string): string {
  return text.replace(INLINE_SPECIAL, "\\$1");
}

/** Remove GCM backslash escapes. */
export function unescapeInline(text: string): string {
  return text.replace(/\\([{}*\[\]~`\\])/g, "$1");
}

// ---------------------------------------------------------------------------
// XHTML escaping (for the push direction)
// ---------------------------------------------------------------------------

export function escapeXhtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function unescapeXhtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
