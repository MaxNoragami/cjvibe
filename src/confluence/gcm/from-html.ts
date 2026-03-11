/**
 * gcm/from-html.ts — Convert Confluence storage-format HTML to GCM markup.
 *
 * Uses htmlparser2 for SAX-style parsing of Confluence storage XHTML.
 * Ported from greenhouse/scripts/confluence/gcm_from_html.py
 *
 * Usage:
 *   import { htmlToGcm } from "./from-html";
 *   const gcmText = htmlToGcm(storageHtml, { title, pageId, version });
 */

import { Parser } from "htmlparser2";
import { escapeXhtml, formatFrontmatter } from "./spec";

// ---------------------------------------------------------------------------
// Tag classification
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "ul", "ol", "li", "hr", "br", "div", "pre",
]);

const TABLE_STRUCT = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "colgroup", "col", "caption",
]);

const INLINE_TAGS = new Set([
  "strong", "b", "em", "i", "del", "s", "code",
  "sub", "sup", "span", "u",
]);

/** Confluence namespace tags with dedicated GCM syntax */
const AC_DEDICATED = new Set(["jira", "anchor", "status"]);

/** ac:* tags whose open/close just passes text through (no structural meaning) */
const AC_TRANSPARENT = new Set([
  "ac:inline-comment-marker", "ac:plain-text-link-body",
  "ac:rich-text-body", "ac:task-body",
]);

/** Tags to silently skip (and their content) */
const SKIP_TAGS = new Set(["style", "script"]);

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

function attrsStr(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    const vEsc = (v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    parts.push(`${k}="${vEsc}"`);
  }
  return parts.join(" ");
}

function gcmTagAttrs(keepAttrs: Set<string>, attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (keepAttrs.has(k) && v) {
      if (v.includes(" ") || v.includes('"') || v.includes("=")) {
        const vEsc = v.replace(/"/g, '\\"');
        parts.push(`${k}="${vEsc}"`);
      } else {
        parts.push(`${k}=${v}`);
      }
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

class GCMBuilder {
  out: string[] = [];
  private _skip = 0;

  // Raw capture: verbatim Confluence XML for unknown constructs
  private _rawDepth = 0;
  private _rawBuf: string[] = [];

  // Table state
  private _inTable = false;
  private _tableSection = "";
  private _cellTag = "";
  private _cellBuf: string[] = [];
  private _cellAttrs: Record<string, string> = {};

  // Inline state
  private _listDepth = 0;
  private _heading = 0;
  private _headingBuf: string[] = [];
  private _inBlockquote = false;
  private _inLink = false;
  private _linkHref = "";
  private _linkText: string[] = [];
  private _inPre = false;

  // ac:structured-macro state
  private _macroName = "";
  private _macroId = "";
  private _macroParams: Record<string, string> = {};
  private _inMacroParam: string | null = null;
  private _macroDepth = 0;
  private _macroRawBuf: string[] = [];

  // ac:link state
  private _inAcLink = false;
  private _acLinkDepth = 0;
  private _acLinkBuf: string[] = [];
  private _acLinkAttrs: Record<string, string> = {};
  private _acLinkText: string[] = [];

  // ac:image state
  private _inAcImage = false;
  private _acImageDepth = 0;
  private _acImageBuf: string[] = [];
  private _acImageAttrs: Record<string, string> = {};
  private _acImageFile = "";
  private _acImageUrl = "";

  // ac:task-list state
  private _inTaskList = false;
  private _taskDepth = 0;
  private _taskBuf: string[] = [];

  // Inline formatting stack (for cells)
  private _inlineStack: string[] = [];
  private _strongDepth = 0;
  private _emDepth = 0;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private _closeInlineMarkers(): void {
    for (let i = this._inlineStack.length - 1; i >= 0; i--) {
      this._cellBuf.push(this._inlineStack[i]!);
    }
    this._inlineStack.length = 0;
  }

  private _emit(text: string): void {
    if (this._inLink) {
      this._linkText.push(text);
    } else if (this._inAcLink) {
      this._acLinkText.push(text);
    } else if (this._cellTag) {
      this._cellBuf.push(text);
    } else if (this._heading) {
      this._headingBuf.push(text);
    } else {
      this.out.push(text);
    }
  }

  // ------------------------------------------------------------------
  // Raw capture helpers
  // ------------------------------------------------------------------

  private _rawOpen(tag: string, attrs: Record<string, string>): void {
    const a = attrsStr(attrs);
    this._rawBuf.push(`<${tag}${a ? " " + a : ""}>`);
    this._rawDepth++;
  }

  private _rawSelfclose(tag: string, attrs: Record<string, string>): void {
    const a = attrsStr(attrs);
    this._rawBuf.push(`<${tag}${a ? " " + a : ""}/>`);
  }

  private _rawClose(tag: string): void {
    this._rawBuf.push(`</${tag}>`);
    this._rawDepth--;
    if (this._rawDepth === 0) {
      const raw = this._rawBuf.join("");
      this._rawBuf = [];
      this._emit(`\n{raw}\n${raw}\n{/raw}\n`);
    }
  }

  private _rawData(data: string): void {
    this._rawBuf.push(escapeXhtml(data));
  }

  // ------------------------------------------------------------------
  // Macro helpers
  // ------------------------------------------------------------------

  private _macroOpen(tag: string, attrs: Record<string, string>): void {
    const a = attrsStr(attrs);
    this._macroRawBuf.push(`<${tag}${a ? " " + a : ""}>`);
    this._macroDepth++;
  }

  private _macroSelfclose(tag: string, attrs: Record<string, string>): void {
    const a = attrsStr(attrs);
    this._macroRawBuf.push(`<${tag}${a ? " " + a : ""}/>`);
  }

  private _macroClose(tag: string): void {
    this._macroRawBuf.push(`</${tag}>`);
    this._macroDepth--;
  }

  private _macroData(data: string): void {
    this._macroRawBuf.push(escapeXhtml(data));
  }

  private _flushMacro(): void {
    const name = this._macroName;
    const params = this._macroParams;

    if (name === "jira") {
      const key = params["key"] ?? "UNKNOWN-0";
      this._emit(`{jira:${key}}`);
    } else if (name === "anchor") {
      let aname = params[""] ?? params["name"] ?? "";
      if (!aname) {
        for (const v of Object.values(params)) {
          if (v) { aname = v; break; }
        }
      }
      this._emit(`{anchor:${aname}}`);
    } else if (name === "status") {
      const title = params["title"] ?? "";
      const color = params["colour"] ?? params["color"] ?? "";
      const subtle = params["subtle"] ?? "";
      let extra = "";
      if (color) extra += `|color=${color}`;
      if (subtle && subtle.toLowerCase() === "true") extra += "|subtle";
      this._emit(`{status:${title}${extra}}`);
    } else {
      // Unknown macro → raw passthrough of full XML
      const raw = this._macroRawBuf.join("");
      this._emit(`\n{raw}\n${raw}\n{/raw}\n`);
    }

    this._macroName = "";
    this._macroId = "";
    this._macroParams = {};
    this._inMacroParam = null;
    this._macroDepth = 0;
    this._macroRawBuf = [];
  }

  // ------------------------------------------------------------------
  // ac:link helpers
  // ------------------------------------------------------------------

  private _flushAcLink(): void {
    const attrs = this._acLinkAttrs;
    const text = this._acLinkText.join("").trim();
    const rawBuf = [...this._acLinkBuf];

    const anchor = attrs["ac:anchor"] ?? "";
    const pageTitle = attrs["ri:content-title"] ?? "";

    // Reset state BEFORE emitting
    this._inAcLink = false;
    this._acLinkDepth = 0;
    this._acLinkBuf = [];
    this._acLinkAttrs = {};
    this._acLinkText = [];

    if (anchor) {
      const attrStr = `anchor=${anchor}`;
      const display = text || anchor;
      this._emit(`{link ${attrStr}}${display}{/link}`);
    } else if (pageTitle) {
      let attrStr: string;
      if (pageTitle.includes(" ") || pageTitle.includes('"')) {
        const ptEsc = pageTitle.replace(/"/g, '\\"');
        attrStr = `page="${ptEsc}"`;
      } else {
        attrStr = `page=${pageTitle}`;
      }
      const display = text || pageTitle;
      this._emit(`{link ${attrStr}}${display}{/link}`);
    } else if (attrs["ri:userkey"]) {
      this._emit(`{user:${attrs["ri:userkey"]}}`);
    } else {
      // Fallback: raw passthrough
      const raw = rawBuf.join("");
      this._emit(`\n{raw}\n${raw}\n{/raw}\n`);
    }
  }

  // ------------------------------------------------------------------
  // ac:image helpers
  // ------------------------------------------------------------------

  private _flushAcImage(): void {
    const attrs = this._acImageAttrs;
    const file = this._acImageFile;
    const url = this._acImageUrl;
    const parts: string[] = [];
    if (file) parts.push(`file="${file}"`);
    else if (url) parts.push(`url="${url}"`);
    for (const k of ["ac:height", "ac:width", "ac:align", "ac:class", "ac:thumbnail"]) {
      const v = attrs[k] ?? "";
      if (v) {
        const short = k.split(":")[1]!;
        parts.push(`${short}=${v}`);
      }
    }
    this._emit(`{image ${parts.join(" ")}}`);

    this._inAcImage = false;
    this._acImageDepth = 0;
    this._acImageBuf = [];
    this._acImageAttrs = {};
    this._acImageFile = "";
    this._acImageUrl = "";
  }

  // ------------------------------------------------------------------
  // Tag handlers
  // ------------------------------------------------------------------

  onOpenTag(tag: string, attrs: Record<string, string>): void {
    const tagLower = tag.toLowerCase();

    // ── Inside raw capture ──
    if (this._rawDepth > 0) {
      this._rawOpen(tagLower, attrs);
      return;
    }

    // ── Inside macro capture ──
    if (this._macroDepth > 0) {
      this._macroOpen(tagLower, attrs);
      if (tagLower === "ac:parameter") {
        this._inMacroParam = attrs["ac:name"] ?? "";
      }
      return;
    }

    // ── Inside ac:link capture ──
    if (this._inAcLink) {
      const a = attrsStr(attrs);
      this._acLinkBuf.push(`<${tagLower}${a ? " " + a : ""}>`);
      this._acLinkDepth++;
      if (tagLower === "ri:page") {
        for (const [k, v] of Object.entries(attrs)) {
          this._acLinkAttrs[k] = v;
        }
      } else if (tagLower === "ri:user") {
        const userkey = attrs["ri:userkey"] ?? "";
        if (userkey) this._acLinkAttrs["ri:userkey"] = userkey;
      }
      return;
    }

    // ── Inside ac:image capture ──
    if (this._inAcImage) {
      const a = attrsStr(attrs);
      this._acImageBuf.push(`<${tagLower}${a ? " " + a : ""}>`);
      this._acImageDepth++;
      if (tagLower === "ri:attachment") {
        this._acImageFile = attrs["ri:filename"] ?? "";
      } else if (tagLower === "ri:url") {
        this._acImageUrl = attrs["ri:value"] ?? "";
      }
      return;
    }

    // ── Inside task-list capture ──
    if (this._inTaskList) {
      const a = attrsStr(attrs);
      this._taskBuf.push(`<${tagLower}${a ? " " + a : ""}>`);
      this._taskDepth++;
      return;
    }

    // ── Skip tags ──
    if (SKIP_TAGS.has(tagLower)) {
      this._skip++;
      return;
    }
    if (this._skip) return;

    // ── Confluence structured macros ──
    if (tagLower === "ac:structured-macro") {
      this._macroName = attrs["ac:name"] ?? "";
      this._macroId = attrs["ac:macro-id"] ?? "";
      this._macroParams = {};
      this._inMacroParam = null;
      this._macroDepth = 1;
      const a = attrsStr(attrs);
      this._macroRawBuf = [`<${tagLower}${a ? " " + a : ""}>`];
      return;
    }

    // ── ac:link ──
    if (tagLower === "ac:link") {
      this._inAcLink = true;
      this._acLinkDepth = 1;
      const a = attrsStr(attrs);
      this._acLinkBuf = [`<ac:link${a ? " " + a : ""}>`];
      this._acLinkAttrs = { ...attrs };
      this._acLinkText = [];
      return;
    }

    // ── ac:image ──
    if (tagLower === "ac:image") {
      this._inAcImage = true;
      this._acImageDepth = 1;
      const a = attrsStr(attrs);
      this._acImageBuf = [`<ac:image${a ? " " + a : ""}>`];
      this._acImageAttrs = { ...attrs };
      this._acImageFile = "";
      this._acImageUrl = "";
      return;
    }

    // ── ac:task-list ──
    if (tagLower === "ac:task-list") {
      this._inTaskList = true;
      this._taskDepth = 1;
      const a = attrsStr(attrs);
      this._taskBuf = [`<ac:task-list${a ? " " + a : ""}>`];
      return;
    }

    // ── Any other ac:* → raw capture ──
    if (tagLower.startsWith("ac:") && !AC_TRANSPARENT.has(tagLower)) {
      this._rawOpen(tagLower, attrs);
      return;
    }

    // ── <a> links ──
    if (tagLower === "a") {
      this._inLink = true;
      this._linkHref = attrs["href"] ?? "";
      this._linkText = [];
      return;
    }

    // ── Table structure ──
    if (tagLower === "table") {
      this._inTable = true;
      const tableA = gcmTagAttrs(new Set(["class", "style"]), attrs);
      const style = attrs["style"] ?? "";
      const wm = style.match(/width:\s*([\d.]+%)/);
      const widthAttr = wm ? ` width=${wm[1]}` : "";
      const cls = attrs["class"] ?? "";
      const clsAttr = cls ? ` class="${cls}"` : "";
      this._emit(`\n{table${widthAttr}${clsAttr}}\n`);
      return;
    }

    if (tagLower === "thead") {
      this._tableSection = "thead";
      this._emit("{thead}\n");
      return;
    }
    if (tagLower === "tbody") {
      this._tableSection = "tbody";
      return;
    }
    if (tagLower === "tfoot") {
      this._tableSection = "tfoot";
      this._emit("{tfoot}\n");
      return;
    }
    if (tagLower === "tr") {
      this._emit("{tr}\n");
      return;
    }
    if (tagLower === "td" || tagLower === "th") {
      this._cellTag = tagLower;
      this._cellBuf = [];
      this._cellAttrs = { ...attrs };
      this._inlineStack.length = 0;
      return;
    }
    if (tagLower === "colgroup") {
      this._emit("{colgroup}\n");
      return;
    }
    if (tagLower === "col") {
      const colA = gcmTagAttrs(new Set(["style", "class"]), attrs);
      this._emit(`{col ${colA}}\n`);
      return;
    }
    if (tagLower === "caption") {
      return;
    }

    // ── Block elements ──
    if (/^h[1-6]$/.test(tagLower)) {
      const level = parseInt(tagLower[1]!, 10);
      if (this._cellTag) {
        this._cellBuf.push(`\n${"=".repeat(level)} `);
      } else {
        this._heading = level;
        this._headingBuf = [];
      }
      return;
    }

    if (tagLower === "p") {
      if (!this._cellTag) {
        if (this._listDepth > 0) {
          // <p> inside <li> — <li> already handles structure
        } else if (this._inBlockquote) {
          this._emit("\n> ");
        } else {
          this._emit("\n");
        }
      }
      return;
    }

    if (tagLower === "blockquote") {
      this._inBlockquote = true;
      return;
    }

    if (tagLower === "ul" || tagLower === "ol") {
      if (this._cellTag) {
        this._closeInlineMarkers();
        const listTag = tagLower === "ul" ? "ul" : "ol";
        this._cellBuf.push(`\n{${listTag}}\n`);
      }
      this._listDepth++;
      return;
    }

    if (tagLower === "li") {
      const indent = "  ".repeat(this._listDepth - 1);
      this._emit(`\n${indent}- `);
      return;
    }

    if (tagLower === "hr") {
      this._emit("\n----\n");
      return;
    }

    if (tagLower === "br") {
      if (this._cellTag) {
        this._closeInlineMarkers();
        this._cellBuf.push("\n");
      } else {
        this._emit("{br}");
      }
      return;
    }

    if (tagLower === "pre") {
      this._inPre = true;
      return;
    }

    // ── Inline formatting ──
    if (tagLower === "strong" || tagLower === "b") {
      this._strongDepth++;
      if (this._strongDepth === 1) {
        this._emit("**");
        if (this._cellTag) this._inlineStack.push("**");
      }
      return;
    }
    if (tagLower === "em" || tagLower === "i") {
      this._emDepth++;
      if (this._emDepth === 1) {
        this._emit("*");
        if (this._cellTag) this._inlineStack.push("*");
      }
      return;
    }
    if (tagLower === "del" || tagLower === "s") {
      this._emit("~~");
      if (this._cellTag) this._inlineStack.push("~~");
      return;
    }
    if (tagLower === "code") {
      this._emit("`");
      if (this._cellTag) this._inlineStack.push("`");
      return;
    }
    if (tagLower === "sub") { this._emit("{sub}"); return; }
    if (tagLower === "sup") { this._emit("{sup}"); return; }
    if (tagLower === "u")   { this._emit("{u}"); return; }

    // ── div / span — transparent ──
    if (tagLower === "div" || tagLower === "span") return;

    // ── ri:user ──
    if (tagLower === "ri:user") {
      const key = attrs["ri:userkey"] ?? "";
      this._emit(`{user:${key}}`);
      return;
    }

    // ── Fallback: unknown tag → raw ──
    if (tagLower.startsWith("ri:") || tagLower.startsWith("ac:")) {
      this._rawOpen(tagLower, attrs);
      return;
    }
  }

  onCloseTag(tag: string): void {
    const tagLower = tag.toLowerCase();

    // ── Raw capture ──
    if (this._rawDepth > 0) {
      this._rawClose(tagLower);
      return;
    }

    // ── Macro capture ──
    if (this._macroDepth > 0) {
      this._macroClose(tagLower);
      if (tagLower === "ac:parameter") {
        this._inMacroParam = null;
      }
      if (this._macroDepth === 0) {
        this._flushMacro();
      }
      return;
    }

    // ── ac:link capture ──
    if (this._inAcLink) {
      this._acLinkBuf.push(`</${tagLower}>`);
      this._acLinkDepth--;
      if (this._acLinkDepth === 0) {
        this._flushAcLink();
      }
      return;
    }

    // ── ac:image capture ──
    if (this._inAcImage) {
      this._acImageBuf.push(`</${tagLower}>`);
      this._acImageDepth--;
      if (this._acImageDepth === 0) {
        this._flushAcImage();
      }
      return;
    }

    // ── task-list capture ──
    if (this._inTaskList) {
      this._taskBuf.push(`</${tagLower}>`);
      this._taskDepth--;
      if (this._taskDepth === 0) {
        const raw = this._taskBuf.join("");
        this._emit(`\n{raw}\n${raw}\n{/raw}\n`);
        this._inTaskList = false;
        this._taskBuf = [];
      }
      return;
    }

    // ── Skip tags ──
    if (SKIP_TAGS.has(tagLower)) {
      this._skip = Math.max(0, this._skip - 1);
      return;
    }
    if (this._skip) return;

    // ── ac:* transparent ──
    if (AC_TRANSPARENT.has(tagLower) || tagLower.startsWith("ac:")) {
      return;
    }

    // ── </a> ──
    if (tagLower === "a" && this._inLink) {
      const text = this._linkText.join("").trim();
      const href = this._linkHref;
      this._inLink = false;
      this._linkHref = "";
      this._linkText = [];
      if (href && text) {
        this._emit(`[${text}](${href})`);
      } else if (text) {
        this._emit(text);
      }
      return;
    }

    // ── Table structure ──
    if (tagLower === "table") {
      this._emit("{/table}\n");
      this._inTable = false;
      return;
    }
    if (tagLower === "thead") {
      this._emit("{/thead}\n");
      this._tableSection = "";
      return;
    }
    if (tagLower === "tbody") {
      this._tableSection = "";
      return;
    }
    if (tagLower === "tfoot") {
      this._emit("{/tfoot}\n");
      this._tableSection = "";
      return;
    }
    if (tagLower === "tr") {
      this._emit("{/tr}\n");
      return;
    }
    if (tagLower === "td" || tagLower === "th") {
      const content = this._cellBuf.join("").trim();
      const cellA = this._cellAttrs;
      const attrParts: string[] = [];
      for (const k of ["rowspan", "colspan", "style", "scope"]) {
        const v = cellA[k] ?? "";
        if (v && !(k === "rowspan" && v === "1") && !(k === "colspan" && v === "1")) {
          if (v.includes(" ")) {
            attrParts.push(`${k}="${v}"`);
          } else {
            attrParts.push(`${k}=${v}`);
          }
        }
      }
      const attrStr = attrParts.length > 0 ? " " + attrParts.join(" ") : "";
      // Reset cell state BEFORE emitting
      this._cellTag = "";
      this._cellBuf = [];
      this._cellAttrs = {};
      this._inlineStack.length = 0;
      this._emit(`{${tagLower}${attrStr}}${content}{/${tagLower}}\n`);
      return;
    }
    if (tagLower === "colgroup") {
      this._emit("{/colgroup}\n");
      return;
    }
    if (tagLower === "col" || tagLower === "caption") return;

    // ── Block elements ──
    if (/^h[1-6]$/.test(tagLower)) {
      if (this._cellTag) {
        this._heading = 0;
        this._headingBuf = [];
      } else {
        const level = this._heading;
        const text = this._headingBuf.join("").trim();
        this._heading = 0;
        this._headingBuf = [];
        this._emit(`\n${"=".repeat(level)} ${text}\n`);
      }
      return;
    }

    if (tagLower === "p") {
      if (this._cellTag) {
        this._closeInlineMarkers();
        this._cellBuf.push("\n");
      } else if (this._listDepth > 0) {
        // </p> inside <li>
      } else {
        this._emit("\n");
      }
      return;
    }

    if (tagLower === "blockquote") {
      this._inBlockquote = false;
      this._emit("\n");
      return;
    }

    if (tagLower === "ul" || tagLower === "ol") {
      this._listDepth = Math.max(0, this._listDepth - 1);
      if (this._cellTag && this._listDepth === 0) {
        const listTag = tagLower === "ul" ? "ul" : "ol";
        this._cellBuf.push(`\n{/${listTag}}\n`);
      } else if (this._listDepth === 0) {
        this._emit("\n");
      }
      return;
    }
    if (tagLower === "li") return;

    if (tagLower === "pre") {
      this._inPre = false;
      return;
    }

    // ── Inline formatting ──
    if (tagLower === "strong" || tagLower === "b") {
      this._strongDepth = Math.max(0, this._strongDepth - 1);
      if (this._strongDepth === 0) {
        if (this._cellTag && this._inlineStack.includes("**")) {
          const idx = this._inlineStack.indexOf("**");
          if (idx !== -1) this._inlineStack.splice(idx, 1);
        } else if (this._cellTag) {
          return;
        }
        this._emit("**");
      }
      return;
    }
    if (tagLower === "em" || tagLower === "i") {
      this._emDepth = Math.max(0, this._emDepth - 1);
      if (this._emDepth === 0) {
        if (this._cellTag && this._inlineStack.includes("*")) {
          const idx = this._inlineStack.indexOf("*");
          if (idx !== -1) this._inlineStack.splice(idx, 1);
        } else if (this._cellTag) {
          return;
        }
        this._emit("*");
      }
      return;
    }
    if (tagLower === "del" || tagLower === "s") {
      if (this._cellTag && this._inlineStack.includes("~~")) {
        const idx = this._inlineStack.indexOf("~~");
        if (idx !== -1) this._inlineStack.splice(idx, 1);
      } else if (this._cellTag) {
        return;
      }
      this._emit("~~");
      return;
    }
    if (tagLower === "code") {
      if (this._cellTag && this._inlineStack.includes("`")) {
        const idx = this._inlineStack.indexOf("`");
        if (idx !== -1) this._inlineStack.splice(idx, 1);
      } else if (this._cellTag) {
        return;
      }
      this._emit("`");
      return;
    }
    if (tagLower === "sub") { this._emit("{/sub}"); return; }
    if (tagLower === "sup") { this._emit("{/sup}"); return; }
    if (tagLower === "u")   { this._emit("{/u}"); return; }
  }

  onSelfClosingTag(tag: string, attrs: Record<string, string>): void {
    const tagLower = tag.toLowerCase();

    if (this._rawDepth > 0) {
      this._rawSelfclose(tagLower, attrs);
      return;
    }
    if (this._macroDepth > 0) {
      this._macroSelfclose(tagLower, attrs);
      return;
    }
    if (this._inAcLink) {
      const a = attrsStr(attrs);
      this._acLinkBuf.push(`<${tagLower}${a ? " " + a : ""}/>`);
      if (tagLower === "ri:page") {
        for (const [k, v] of Object.entries(attrs)) {
          this._acLinkAttrs[k] = v;
        }
      } else if (tagLower === "ri:user") {
        const userkey = attrs["ri:userkey"] ?? "";
        if (userkey) this._acLinkAttrs["ri:userkey"] = userkey;
      }
      return;
    }
    if (this._inAcImage) {
      const a = attrsStr(attrs);
      this._acImageBuf.push(`<${tagLower}${a ? " " + a : ""}/>`);
      if (tagLower === "ri:attachment") {
        this._acImageFile = attrs["ri:filename"] ?? "";
      } else if (tagLower === "ri:url") {
        this._acImageUrl = attrs["ri:value"] ?? "";
      }
      return;
    }
    if (this._inTaskList) {
      const a = attrsStr(attrs);
      this._taskBuf.push(`<${tagLower}${a ? " " + a : ""}/>`);
      return;
    }

    // Self-closing ac:structured-macro (e.g. toc, children-display)
    if (tagLower === "ac:structured-macro") {
      const a = attrsStr(attrs);
      const macroXml = `<${tagLower}${a ? " " + a : ""}/>`;
      if (this._heading) {
        this._headingBuf.push(`{raw}${macroXml}{/raw}`);
      } else {
        this._emit(`\n{raw}\n${macroXml}\n{/raw}\n`);
      }
      return;
    }

    if (tagLower === "br") {
      if (this._cellTag) {
        this._closeInlineMarkers();
        this._cellBuf.push("\n");
      } else {
        this._emit("{br}");
      }
      return;
    }
    if (tagLower === "hr") {
      this._emit("\n----\n");
      return;
    }
    if (tagLower === "col") {
      const colA = gcmTagAttrs(new Set(["style", "class"]), attrs);
      this._emit(`{col ${colA}}\n`);
      return;
    }
    if (tagLower === "ri:user") {
      const key = attrs["ri:userkey"] ?? "";
      this._emit(`{user:${key}}`);
      return;
    }
  }

  onText(data: string): void {
    if (this._skip) return;
    if (this._rawDepth > 0) {
      this._rawData(data);
      return;
    }
    if (this._macroDepth > 0) {
      if (this._inMacroParam !== null) {
        this._macroParams[this._inMacroParam] =
          (this._macroParams[this._inMacroParam] ?? "") + data;
      }
      this._macroData(data);
      return;
    }
    if (this._inAcLink) {
      this._acLinkText.push(data);
      this._acLinkBuf.push(escapeXhtml(data));
      return;
    }
    if (this._inAcImage) {
      this._acImageBuf.push(escapeXhtml(data));
      return;
    }
    if (this._inTaskList) {
      this._taskBuf.push(escapeXhtml(data));
      return;
    }

    // Normalize newlines in flowing text
    let text = data;
    if (!this._inPre && !this._cellTag) {
      text = text.replace(/\n/g, " ");
    }
    // Escape literal asterisks
    if (!this._inPre && !this._cellTag) {
      text = text.replace(/\*/g, "\\*");
    }
    // Escape list-like patterns in non-list paragraph text
    if (
      this._listDepth === 0 &&
      !this._cellTag &&
      !this._heading &&
      this.out.length > 0 &&
      this.out[this.out.length - 1]!.endsWith("\n")
    ) {
      if (/^-\s/.test(text) || /^\d+\.\s/.test(text)) {
        text = "\\" + text;
      }
    }
    this._emit(text);
  }

  getGcm(): string {
    let text = this.out.join("");
    // Normalize excessive blank lines
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HtmlToGcmOptions {
  title?: string;
  pageId?: string;
  version?: string | number;
  sourceUrl?: string;
}

export function htmlToGcm(html: string, opts: HtmlToGcmOptions = {}): string {
  const builder = new GCMBuilder();

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        builder.onOpenTag(name, attrs);
      },
      onclosetag(name) {
        builder.onCloseTag(name);
      },
      ontext(data) {
        builder.onText(data);
      },
    },
    {
      xmlMode: true,
      recognizeSelfClosing: true,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    },
  );

  parser.write(html);
  parser.end();

  const body = builder.getGcm();

  if (opts.title || opts.pageId || opts.version) {
    const fm = formatFrontmatter(
      opts.title ?? "",
      opts.pageId ?? "",
      opts.version ?? "",
      opts.sourceUrl,
    );
    return fm + "\n\n" + body + "\n";
  }
  return body + "\n";
}
