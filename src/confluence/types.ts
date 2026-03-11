// ---------------------------------------------------------------------------
// Confluence REST API — raw response shapes (Confluence Server/DC v1 API)
// ---------------------------------------------------------------------------

/** Raw version object returned by the API */
export interface ApiVersion {
  number: number;
  when: string;
  by?: { displayName: string; username: string };
}

/** Raw ancestor stub returned inside a page result */
export interface ApiAncestor {
  id: string;
  title: string;
}

/** Links block present on every content item */
export interface ApiLinks {
  /** Relative URL to the page in the UI, e.g. /display/SPACE/Title */
  webui: string;
  self: string;
  tinyui?: string;
}

/** Raw page summary as returned by /rest/api/content (with version,ancestors,_links expanded) */
export interface ConfluencePageSummary {
  id: string;
  title: string;
  type: string;
  status: string;
  space: { key: string; name: string };
  version: ApiVersion;
  /** Parent chain — last entry is the direct parent */
  ancestors: ApiAncestor[];
  _links: ApiLinks;
}

/** Full page including body (storage format) */
export interface ConfluencePage extends ConfluencePageSummary {
  body: {
    storage: { value: string; representation: "storage" };
  };
}

export interface ConfluenceSpace {
  key: string;
  name: string;
  type: "global" | "personal";
  homepage?: string;
}

export interface PaginatedResult<T> {
  results: T[];
  start: number;
  limit: number;
  size: number;
  /** Present when there are more results */
  _links?: { next?: string; base?: string };
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

/** A single entry from GET /rest/api/content/{id}/version */
export interface PageVersion {
  number: number;
  when: string;
  message?: string;
  minorEdit: boolean;
  by?: { displayName: string; username: string };
}

export interface PageVersionResult {
  results: PageVersion[];
  start: number;
  limit: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Derived / local types
// ---------------------------------------------------------------------------

/** A page node in a client-side page tree */
export interface PageTreeNode {
  id: string;
  title: string;
  version: number;
  webUrl: string;
  children: PageTreeNode[];
}
