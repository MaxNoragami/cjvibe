# GMS Confluence Markup (GCM) — Format Specification

## Philosophy

GCM is a human-readable, line-oriented markup designed specifically for
round-tripping Confluence storage format. Every Confluence element either has
a natural GCM representation or is wrapped in a `{raw}...{/raw}` block for
verbatim preservation. The goal: **edit text freely; never lose structure**.

## Document envelope

```
--- gcm ---
title: 04 - GMS -WP4.3 Import Stakeholder requirements in Jira
page_id: 42634112
version: 65
---

(body lines follow)
```

Front-matter is YAML-ish key:value (no nested structures needed).

---

## Block elements

### Headings

```
= Heading 1
== Heading 2
=== Heading 3
==== Heading 4
===== Heading 5
====== Heading 6
```

### Paragraphs

Plain text lines. Blank line separates paragraphs.

### Horizontal rule

```
----
```

### Blockquote

```
> Quoted paragraph text.
> Second line of same quote.
```

### Lists

Unordered (bullets — only `-` marker, not `*`/`+` to avoid italic ambiguity):
```
- Item one
- Item two
  - Nested item
```

Ordered:
```
1. First
2. Second
  1. Sub-item
```

Escaped list markers (paragraph text that starts with a list-like pattern):
```
\- This is not a list item
\1. Neither is this
```

### Tables (full merged-cell support)

```
{table width=54.0761%}
{thead}
{tr}
{th}Header 1{/th}
{th}Header 2{/th}
{th}Header 3{/th}
{/tr}
{/thead}
{tr}
{td rowspan=3}Spans 3 rows{/td}
{td}Normal cell{/td}
{td}Normal cell{/td}
{/tr}
{tr}
{td colspan=2}Spans 2 columns{/td}
{/tr}
{tr}
{td}Cell{/td}
{td}Cell{/td}
{/tr}
{/table}
```

- Tag-style `{tag attrs}...{/tag}` for structural table elements
- Supports `rowspan`, `colspan`, `style`, `class`, `scope`
- `{colgroup}` / `{col style=...}` preserved verbatim
- Cell content is inline GCM (bold, links, etc.)
- Each `{td}...{/td}` can span multiple lines for complex cell content
- Headings inside cells use standard GCM heading markers (`= H1`, `== H2`, etc.)
- Lists inside cells are wrapped with `{ul}...{/ul}` or `{ol}...{/ol}` markers:
  ```
  {td}{ul}
  - First item
  - Second item
  {/ul}{/td}
  ```

### Code block

```
{code lang=python}
def hello():
    print("world")
{/code}
```

### Confluence macros

**Jira issue** (special syntax — most common macro):
```
{jira:GMS-10}
```
With summary hidden (key-only display):
```
{jira:GMS-10|nosummary}
```
Renders locally with the issue key. On push, reconstructed with server/serverId
from config.

**Anchor** (second most common):
```
{anchor:ref4}
```

**Status badge**:
```
{status:Draft|color=Yellow}
```

**Task list**: Wrapped in `{raw}` passthrough (no native GCM syntax).

**Layout**:
```
{layout}
{layout-section type=single}
{layout-cell}
Content here
{/layout-cell}
{/layout-section}
{/layout}
```

**Any other macro** → `{raw}...{/raw}` passthrough.

### Raw passthrough

```
{raw}
<ac:structured-macro ac:name="other-macro">
  <ac:parameter ac:name="foo">bar</ac:parameter>
</ac:structured-macro>
{/raw}
```

Verbatim Confluence storage XML. Never parsed, never modified. Pushed back
byte-for-byte.

---

## Inline elements

### Bold / Italic / Strikethrough / Code

```
**bold text**
*italic text*
~~strikethrough~~
`inline code`
```

### Links

External link:
```
[display text](http://example.com)
```

Confluence page link (ac:link with ri:page):
```
{link page="WP1.1 Problem Definition"}display text{/link}
```

Confluence anchor link (ac:link with ac:anchor):
```
{link anchor=ref4}display text{/link}
```

### Images

Attached image:
```
{image file="diagram.png" height=400 align=center}
```

External image (ri:url):
```
{image url="http://..." height=150}
```

### Jira (inline)

```
{jira:GMS-10}
{jira:GMS-10|nosummary}
```

Append `|nosummary` to hide the issue summary. Same syntax as block — context determines placement.

### Status badge (inline)

```
{status:Draft|color=Yellow}
```

### User mention

```
{user:ff8081819b134c58019c0a81410c0005}
```

### Line break

```
{br}
```

Inserted for `<br/>` elements outside table cells.

### Subscript / Superscript

```
H{sub}2{/sub}O
x{sup}2{/sup}
```

### Inline raw passthrough

```
{raw}<ac:some-inline-element/>{/raw}
```

Used when inline-level Confluence XML appears inside headings or other
inline contexts where block-level `{raw}` is not appropriate.

---

## Div / Span (style containers)

```
{div class=content-wrapper}
  paragraph content
{/div}
```

`{span}...{/span}` is transparent (content flows through).

---

## Escaping

- `\{` → literal `{` (prevents tag interpretation)
- `\*` → literal `*` (prevents bold/italic interpretation)
- `\-` → literal `-` at line start (prevents list interpretation)
- `\1.` → literal `1.` at line start (prevents ordered list interpretation)
- Standard for all special chars: `\[`, `\]`, `\~`, `` \` ``

---

## Design principles

1. **Every Confluence construct maps to exactly one GCM construct** — no ambiguity
2. **Lossless round-trip** — parse storage HTML → GCM → storage HTML produces
   semantically identical output
3. **Human-editable** — common elements (headings, paragraphs, bold, links, Jira
   issues) look natural; exotic elements use `{tag}` syntax that's still readable
4. **Diff-friendly** — line-oriented, deterministic formatting
5. **`{raw}`** is the safety net — anything unrecognized is captured verbatim
