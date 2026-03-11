/**
 * gcm/to-html.ts — Convert GCM markup back to Confluence storage-format HTML.
 *
 * Ported from greenhouse/scripts/confluence/gcm_to_html.py
 *
 * Usage:
 *   import { gcmToHtml } from "./to-html";
 *   const [storageHtml, meta] = gcmToHtml(gcmText, { jiraServer, jiraServerId });
 */

import { parseFrontmatter, parseTagAttrs, escapeXhtml, type GcmMetadata } from "./spec";

// ---------------------------------------------------------------------------
// Jira macro generation
// ---------------------------------------------------------------------------

function jiraMacro(key: string, server = "", serverId = ""): string {
  const parts: string[] = [];
  if (server) {
    parts.push(`<ac:parameter ac:name="server">${escapeXhtml(server)}</ac:parameter>`);
  }
  if (serverId) {
    parts.push(`<ac:parameter ac:name="serverId">${serverId}</ac:parameter>`);
  }
  parts.push(`<ac:parameter ac:name="key">${escapeXhtml(key)}</ac:parameter>`);
  return `<ac:structured-macro ac:name="jira" ac:schema-version="1">${parts.join("")}</ac:structured-macro>`;
}

// ---------------------------------------------------------------------------
// Inline conversion
// ---------------------------------------------------------------------------

function convertInline(text: string, server = "", serverId = ""): string {
  const phs: string[] = [];

  function ph(xhtml: string): string {
    const idx = phs.length;
    phs.push(xhtml);
    return `\x00PH${idx}\x00`;
  }

  // {jira:KEY}
  text = text.replace(
    /\{jira:([A-Z][A-Z0-9]*-\d+)\}/g,
    (_m, key: string) => ph(jiraMacro(key, server, serverId)),
  );

  // {br} → <br/>
  text = text.replace(/\{br\}/g, () => ph("<br/>"));

  // {raw}...{/raw} inline passthrough
  text = text.replace(/\{raw\}(.*?)\{\/raw\}/g, (_m, content: string) => ph(content));

  // {anchor:name}
  text = text.replace(
    /\{anchor:([^}]+)\}/g,
    (_m, name: string) =>
      ph(
        `<ac:structured-macro ac:name="anchor" ac:schema-version="1">` +
          `<ac:parameter ac:name="">${escapeXhtml(name)}</ac:parameter>` +
          `</ac:structured-macro>`,
      ),
  );

  // {status:Title|color=X|subtle}
  text = text.replace(/\{status:([^}]+)\}/g, (_m, body: string) => {
    const partsList = body.split("|");
    const title = partsList[0] ?? "";
    let color = "";
    let subtle = "";
    for (const p of partsList.slice(1)) {
      if (p.startsWith("color=")) color = p.slice(6);
      else if (p === "subtle") subtle = "true";
    }
    const params: string[] = [];
    if (title) {
      params.push(`<ac:parameter ac:name="title">${escapeXhtml(title)}</ac:parameter>`);
    }
    if (color) {
      params.push(`<ac:parameter ac:name="colour">${escapeXhtml(color)}</ac:parameter>`);
    }
    if (subtle) {
      params.push(`<ac:parameter ac:name="subtle">true</ac:parameter>`);
    }
    return ph(
      `<ac:structured-macro ac:name="status" ac:schema-version="1">${params.join("")}</ac:structured-macro>`,
    );
  });

  // {user:key}
  text = text.replace(
    /\{user:([^}]+)\}/g,
    (_m, key: string) =>
      ph(`<ac:link><ri:user ri:userkey="${escapeXhtml(key)}"/></ac:link>`),
  );

  // {link page="Title"}text{/link}  or  {link anchor=name}text{/link}
  text = text.replace(/\{link ([^}]+)\}(.*?)\{\/link\}/g, (_m, attrStr: string, linkText: string) => {
    const attrs = parseTagAttrs(attrStr);
    if (attrs["anchor"]) {
      const anchor = attrs["anchor"];
      return ph(
        `<ac:link ac:anchor="${escapeXhtml(anchor)}">` +
          `<ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>` +
          `</ac:link>`,
      );
    } else if (attrs["page"]) {
      const page = attrs["page"];
      return ph(
        `<ac:link>` +
          `<ri:page ri:content-title="${escapeXhtml(page)}"/>` +
          `<ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>` +
          `</ac:link>`,
      );
    }
    return _m; // leave as-is if unknown
  });

  // {image file="x.png" height=400}
  text = text.replace(/\{image ([^}]+)\}/g, (_m, attrStr: string) => {
    const attrs = parseTagAttrs(attrStr);
    const acAttrs: string[] = [];
    for (const k of ["height", "width", "align", "class", "thumbnail"]) {
      const v = attrs[k] ?? "";
      if (v) acAttrs.push(`ac:${k}="${escapeXhtml(v)}"`);
    }
    const acStr = acAttrs.length > 0 ? " " + acAttrs.join(" ") : "";

    let inner = "";
    if (attrs["file"]) {
      inner = `<ri:attachment ri:filename="${escapeXhtml(attrs["file"])}"/>`;
    } else if (attrs["url"]) {
      inner = `<ri:url ri:value="${escapeXhtml(attrs["url"])}"/>`;
    }
    return ph(`<ac:image${acStr}>${inner}</ac:image>`);
  });

  // {sub}x{/sub}, {sup}x{/sup}, {u}x{/u}
  text = text.replace(
    /\{sub\}(.*?)\{\/sub\}/g,
    (_m, content: string) => ph(`<sub>${escapeXhtml(content)}</sub>`),
  );
  text = text.replace(
    /\{sup\}(.*?)\{\/sup\}/g,
    (_m, content: string) => ph(`<sup>${escapeXhtml(content)}</sup>`),
  );
  text = text.replace(
    /\{u\}(.*?)\{\/u\}/g,
    (_m, content: string) => ph(`<u>${escapeXhtml(content)}</u>`),
  );

  // [text](url) → <a href>
  text = text.replace(
    /\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*)\]\(([^)]+)\)/g,
    (_m, linkText: string, href: string) =>
      ph(`<a href="${escapeXhtml(href)}">${escapeXhtml(linkText)}</a>`),
  );

  // Protect escaped asterisks
  const ESC_STAR = "\x01STAR\x01";
  text = text.replace(/\\\*/g, ESC_STAR);

  // ***bold italic***
  text = text.replace(
    /\*\*\*(.+?)\*\*\*/g,
    (_m, content: string) =>
      ph(`<strong><em>${escapeXhtml(content.replace(new RegExp(ESC_STAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "*"))}</em></strong>`),
  );
  // **bold**
  text = text.replace(
    /\*\*(.+?)\*\*/g,
    (_m, content: string) =>
      ph(`<strong>${escapeXhtml(content.replace(new RegExp(ESC_STAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "*"))}</strong>`),
  );
  // *italic*
  text = text.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    (_m, content: string) =>
      ph(`<em>${escapeXhtml(content.replace(new RegExp(ESC_STAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "*"))}</em>`),
  );
  // ~~strikethrough~~
  text = text.replace(
    /~~(.+?)~~/g,
    (_m, content: string) => ph(`<del>${escapeXhtml(content)}</del>`),
  );
  // `code`
  text = text.replace(
    /`(.+?)`/g,
    (_m, content: string) => ph(`<code>${escapeXhtml(content)}</code>`),
  );

  // Escape remaining plain text
  const parts = text.split(/(\x00PH\d+\x00)/);
  const result: string[] = [];
  for (const part of parts) {
    if (part.startsWith("\x00PH")) {
      result.push(part);
    } else {
      result.push(escapeXhtml(part.replace(new RegExp(ESC_STAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "*")));
    }
  }
  text = result.join("");

  // Restore placeholders
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < phs.length; i++) {
      const marker = `\x00PH${i}\x00`;
      if (text.includes(marker)) {
        text = text.replace(marker, phs[i]!);
        changed = true;
      }
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Block-level conversion
// ---------------------------------------------------------------------------

export interface GcmToHtmlOptions {
  jiraServer?: string | undefined;
  jiraServerId?: string | undefined;
}

export function gcmToHtml(
  gcmText: string,
  opts: GcmToHtmlOptions = {},
): [string, GcmMetadata] {
  const [meta, body] = parseFrontmatter(gcmText);
  const lines = body.split("\n");
  const output: string[] = [];
  let i = 0;

  const server = opts.jiraServer ?? "";
  const serverId = opts.jiraServerId ?? "";

  // State
  const paragraphLines: string[] = [];
  const listStack: string[] = []; // stack of 'ul'/'ol'
  let inBlockquote = false;
  const bqLines: string[] = [];

  function flushParagraph(): void {
    if (paragraphLines.length > 0) {
      const text = paragraphLines.join(" ").trim();
      if (text) {
        output.push(`<p>${convertInline(text, server, serverId)}</p>`);
      }
      paragraphLines.length = 0;
    }
  }

  function flushBlockquote(): void {
    if (bqLines.length > 0) {
      const inner = bqLines.join(" ").trim();
      if (inner) {
        output.push(
          `<blockquote><p>${convertInline(inner, server, serverId)}</p></blockquote>`,
        );
      }
      bqLines.length = 0;
    }
    inBlockquote = false;
  }

  function closeLists(): void {
    while (listStack.length > 0) {
      output.push(`</${listStack.pop()!}>`);
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    // ── {raw}...{/raw} — verbatim passthrough ──
    if (line.trim() === "{raw}") {
      flushParagraph();
      flushBlockquote();
      closeLists();
      const rawLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "{/raw}") {
        rawLines.push(lines[i]!);
        i++;
      }
      output.push(rawLines.join("\n"));
      i++; // skip {/raw}
      continue;
    }

    // ── {table ...} ──
    if (/^\{table\b/.test(line.trim())) {
      flushParagraph();
      flushBlockquote();
      closeLists();
      const m = line.trim().match(/^\{table\s*(.*)\}$/);
      const tblAttrStr = m ? m[1]! : "";
      const tblAttrs = parseTagAttrs(tblAttrStr);
      const htmlAttrs: string[] = [];
      if (tblAttrs["width"]) {
        htmlAttrs.push(`style="width: ${tblAttrs["width"]};"`);
      }
      if (tblAttrs["class"]) {
        htmlAttrs.push(`class="${escapeXhtml(tblAttrs["class"])}"`);
      }
      const attrHtml = htmlAttrs.length > 0 ? " " + htmlAttrs.join(" ") : "";
      output.push(`<table${attrHtml}>`);
      i++;

      // Parse table contents until {/table}
      while (i < lines.length && lines[i]!.trim() !== "{/table}") {
        const tl = lines[i]!.trim();

        if (tl === "{thead}") output.push("<thead>");
        else if (tl === "{/thead}") output.push("</thead>");
        else if (tl === "{tfoot}") output.push("<tfoot>");
        else if (tl === "{/tfoot}") output.push("</tfoot>");
        else if (tl === "{tbody}") output.push("<tbody>");
        else if (tl === "{/tbody}") output.push("</tbody>");
        else if (tl === "{tr}") output.push("<tr>");
        else if (tl === "{/tr}") output.push("</tr>");
        else if (tl === "{colgroup}") output.push("<colgroup>");
        else if (tl === "{/colgroup}") output.push("</colgroup>");
        else if (/^\{col\b/.test(tl)) {
          const cm = tl.match(/^\{col\s*(.*)\}$/);
          const colAttrs = cm ? parseTagAttrs(cm[1]!) : {};
          const colHtml: string[] = [];
          for (const [ck, cv] of Object.entries(colAttrs)) {
            colHtml.push(`${ck}="${escapeXhtml(cv)}"`);
          }
          const colAttrHtml = colHtml.length > 0 ? " " + colHtml.join(" ") : "";
          output.push(`<col${colAttrHtml}/>`);
        } else if (/^\{(td|th)\b/.test(tl)) {
          // Cell: {td rowspan=3}content{/td}
          const cm = tl.match(/^\{(td|th)\s*([^}]*)\}(.*)$/);
          if (cm) {
            const cellTag = cm[1]!;
            const cellAttrStr = cm[2]!;
            const cellRest = cm[3]!;

            const closePattern = `{/${cellTag}}`;
            let cellContent: string;
            if (cellRest.includes(closePattern)) {
              cellContent = cellRest.slice(0, cellRest.indexOf(closePattern));
            } else {
              const cellParts = [cellRest];
              i++;
              while (i < lines.length && !lines[i]!.includes(closePattern)) {
                cellParts.push(lines[i]!);
                i++;
              }
              if (i < lines.length) {
                const last = lines[i]!;
                cellParts.push(last.slice(0, last.indexOf(closePattern)));
              }
              cellContent = cellParts.join("\n");
            }

            // Build cell HTML
            const cellAttrs = parseTagAttrs(cellAttrStr);
            const caParts: string[] = [];
            for (const [ck, cv] of Object.entries(cellAttrs)) {
              caParts.push(`${ck}="${escapeXhtml(cv)}"`);
            }
            const caHtml = caParts.length > 0 ? " " + caParts.join(" ") : "";

            // Convert cell content
            const cellLines = cellContent.trim().split("\n");
            const cellOutParts: string[] = [];
            let curList: string | null = null;
            let inListBlock = false;
            const paraBuf: string[] = [];

            function flushCellPara(): void {
              if (paraBuf.length > 0) {
                const ptxt = paraBuf.join("</p><p>");
                cellOutParts.push(`<p>${ptxt}</p>`);
                paraBuf.length = 0;
              }
            }

            for (const cl of cellLines) {
              const stripped = cl.trim();
              if (!stripped) {
                if (!inListBlock) flushCellPara();
                continue;
              }

              // List block markers
              if (stripped === "{ul}" || stripped === "{ol}") {
                flushCellPara();
                const listType = stripped.slice(1, -1);
                cellOutParts.push(`<${listType}>`);
                curList = listType;
                inListBlock = true;
                continue;
              }
              if (stripped === "{/ul}" || stripped === "{/ol}") {
                const listType = stripped.slice(2, -1);
                cellOutParts.push(`</${listType}>`);
                curList = null;
                inListBlock = false;
                continue;
              }

              // List item inside {ul}/{ol} block
              if (inListBlock) {
                const lm = stripped.match(/^[-*+]\s+(.+)/);
                if (lm) {
                  const ltxt = convertInline(lm[1]!, server, serverId);
                  cellOutParts.push(`<li>${ltxt}</li>`);
                  continue;
                }
              }

              // Heading inside cell
              const hm = stripped.match(/^(={1,6})\s+(.+)$/);
              if (hm) {
                flushCellPara();
                const hlev = hm[1]!.length;
                const htxt = convertInline(hm[2]!.trim(), server, serverId);
                cellOutParts.push(`<h${hlev}>${htxt}</h${hlev}>`);
                continue;
              }

              // Regular paragraph text
              paraBuf.push(convertInline(stripped, server, serverId));
            }

            flushCellPara();
            const cellHtml = cellOutParts.join("");
            output.push(`<${cellTag}${caHtml}>${cellHtml}</${cellTag}>`);
          }
        }
        i++;
      }

      // Close table
      output.push("</table>");
      i++; // skip {/table}
      continue;
    }

    // ── Heading ──
    const headingMatch = line.match(/^(={1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushBlockquote();
      closeLists();
      const level = headingMatch[1]!.length;
      const htext = headingMatch[2]!.trim();
      const hConverted = htext ? convertInline(htext, server, serverId) : "";
      output.push(`<h${level}>${hConverted}</h${level}>`);
      i++;
      continue;
    }

    // ── Horizontal rule ──
    if (/^-{4,}\s*$/.test(line)) {
      flushParagraph();
      flushBlockquote();
      closeLists();
      output.push("<hr/>");
      i++;
      continue;
    }

    // ── Blockquote ──
    if (line.startsWith("> ")) {
      flushParagraph();
      closeLists();
      inBlockquote = true;
      bqLines.push(line.slice(2).trim());
      i++;
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // ── Escaped list-like pattern ──
    if (/^\\(-\s|\d+\.\s)/.test(line)) {
      closeLists();
      paragraphLines.push(line.slice(1));
      i++;
      continue;
    }

    // ── Unordered list ──
    const ulMatch = line.match(/^(\s*)-\s+(.+)/);
    if (ulMatch) {
      flushParagraph();
      flushBlockquote();
      const indent = Math.floor(ulMatch[1]!.length / 2);
      const text = convertInline(ulMatch[2]!, server, serverId);
      while (listStack.length > indent + 1) {
        output.push(`</${listStack.pop()!}>`);
      }
      if (listStack.length <= indent) {
        output.push("<ul>");
        listStack.push("ul");
      }
      output.push(`<li><p>${text}</p></li>`);
      i++;
      continue;
    }

    // ── Ordered list ──
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      flushParagraph();
      flushBlockquote();
      const indent = Math.floor(olMatch[1]!.length / 2);
      const text = convertInline(olMatch[2]!, server, serverId);
      while (listStack.length > indent + 1) {
        output.push(`</${listStack.pop()!}>`);
      }
      if (listStack.length <= indent) {
        output.push("<ol>");
        listStack.push("ol");
      }
      output.push(`<li><p>${text}</p></li>`);
      i++;
      continue;
    }

    // ── Blank line ──
    if (!line.trim()) {
      flushParagraph();
      flushBlockquote();
      closeLists();
      i++;
      continue;
    }

    // ── Regular paragraph text ──
    closeLists();
    paragraphLines.push(line.trim());
    i++;
  }

  flushParagraph();
  flushBlockquote();
  closeLists();

  return [output.join("\n"), meta];
}
