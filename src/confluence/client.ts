import type { ConfluenceConfig } from "@/config/types";
import { ConfluenceError } from "@/utils/errors";
import type {
  ConfluenceAttachment,
  ConfluencePage,
  ConfluencePageSummary,
  ConfluenceSpace,
  PageTreeNode,
  PageVersion,
  PaginatedResult,
} from "./types";

// ---------------------------------------------------------------------------
// ConfluenceClient
// ---------------------------------------------------------------------------

export class ConfluenceClient {
  readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: ConfluenceConfig) {
    // Strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    // Self-hosted Confluence Server/DC uses Bearer PATs by default.
    // Cloud (or older setups) can use Basic auth with username:token.
    const method = config.authMethod ?? "bearer";
    this.authHeader =
      method === "bearer"
        ? `Bearer ${config.token}`
        : "Basic " + btoa(`${config.username}:${config.token}`);
  }

  // ---------------------------------------------------------------------------
  // HTTP primitives
  // ---------------------------------------------------------------------------

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConfluenceError(
        `Confluence API error ${res.status} ${res.statusText}: ${body}`,
        res.status,
      );
    }

    return res.json() as Promise<T>;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }

  private async delete(path: string): Promise<void> {
    await this.request<unknown>(path, { method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  /** List all spaces the authenticated user can see. */
  async listSpaces(limit = 25): Promise<PaginatedResult<ConfluenceSpace>> {
    return this.get<PaginatedResult<ConfluenceSpace>>(
      `/space?limit=${limit}&expand=homepage`,
    );
  }

  /** Get a single space by key. */
  async getSpace(spaceKey: string): Promise<ConfluenceSpace> {
    return this.get<ConfluenceSpace>(`/space/${spaceKey}`);
  }

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  private static readonly PAGE_EXPAND = "version,ancestors,_links";

  /** Fetch one batch of pages in a space. */
  async listPages(
    spaceKey: string,
    limit = 50,
    start = 0,
  ): Promise<PaginatedResult<ConfluencePageSummary>> {
    return this.get<PaginatedResult<ConfluencePageSummary>>(
      `/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page` +
        `&limit=${limit}&start=${start}&expand=${ConfluenceClient.PAGE_EXPAND}`,
    );
  }

  /** Fetch direct children (one level deep) of a page by ID. */
  async getChildren(pageId: string): Promise<ConfluencePageSummary[]> {
    const result = await this.get<PaginatedResult<ConfluencePageSummary>>(
      `/content/${pageId}/child/page?limit=100&expand=${ConfluenceClient.PAGE_EXPAND}`,
    );
    return result.results;
  }

  /** Fetch the space homepage page ID. */
  async getSpaceHomepageId(spaceKey: string): Promise<string | undefined> {
    const raw = await this.get<{ homepage?: { id: string } }>(
      `/space/${encodeURIComponent(spaceKey)}?expand=homepage`,
    );
    return raw.homepage?.id;
  }

  /** Fetch every page in a space, following pagination automatically. */
  async getAllPages(spaceKey: string): Promise<ConfluencePageSummary[]> {
    const all: ConfluencePageSummary[] = [];
    const BATCH = 100;
    let start = 0;

    while (true) {
      const batch = await this.listPages(spaceKey, BATCH, start);
      all.push(...batch.results);
      if (batch.results.length < BATCH) break;
      start += BATCH;
    }

    return all;
  }

  /**
   * Fetch all pages in a space and build a tree rooted at `rootPageId`.
   * If no rootPageId is given, returns top-level pages (those with no ancestor
   * that is also a page in the space — i.e. the space root children).
   */
  async getPageTree(spaceKey: string, rootPageId?: string): Promise<PageTreeNode[]> {
    const pages = await this.getAllPages(spaceKey);
    const baseUrl = this.baseUrl;

    // Build id → node map
    const nodeMap = new Map<string, PageTreeNode>();
    for (const p of pages) {
      nodeMap.set(p.id, {
        id: p.id,
        title: p.title,
        version: p.version.number,
        webUrl: baseUrl + p._links.webui,
        children: [],
      });
    }

    const pageIds = new Set(nodeMap.keys());
    const roots: PageTreeNode[] = [];

    for (const p of pages) {
      const node = nodeMap.get(p.id)!;
      // Direct parent = last ancestor that exists in this space
      const parentAncestor = [...p.ancestors].reverse().find((a) => pageIds.has(a.id));

      if (rootPageId) {
        // When a root is given: attach to parent within the subtree
        if (parentAncestor && nodeMap.has(parentAncestor.id)) {
          nodeMap.get(parentAncestor.id)!.children.push(node);
        } else if (p.id === rootPageId) {
          roots.push(node);
        }
        // skip pages not under rootPageId (handled by only returning roots entry)
      } else {
        if (parentAncestor) {
          nodeMap.get(parentAncestor.id)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }

    if (rootPageId) {
      // Return only the subtree under the given root
      const rootNode = nodeMap.get(rootPageId);
      return rootNode ? [rootNode] : roots;
    }

    return roots;
  }

  /** Get a single page by ID, including body in storage format. */
  async getPage(pageId: string): Promise<ConfluencePage> {
    return this.get<ConfluencePage>(
      `/content/${pageId}?expand=body.storage,${ConfluenceClient.PAGE_EXPAND},space`,
    );
  }

  /** Create a new page. */
  async createPage(params: {
    spaceKey: string;
    title: string;
    body: string;
    parentId?: string;
  }): Promise<ConfluencePage> {
    const payload: Record<string, unknown> = {
      type: "page",
      title: params.title,
      space: { key: params.spaceKey },
      body: { storage: { value: params.body, representation: "storage" } },
    };
    if (params.parentId) {
      payload["ancestors"] = [{ id: params.parentId }];
    }
    return this.post<ConfluencePage>("/content", payload);
  }

  /** Update an existing page. Requires the current version number. */
  async updatePage(params: {
    pageId: string;
    title: string;
    body: string;
    currentVersion: number;
  }): Promise<ConfluencePage> {
    // notifyWatchers=false — never spam page watchers with programmatic pushes
    return this.put<ConfluencePage>(
      `/content/${params.pageId}?notifyWatchers=false`,
      {
        type: "page",
        title: params.title,
        version: { number: params.currentVersion + 1 },
        body: { storage: { value: params.body, representation: "storage" } },
      },
    );
  }

  /** Delete a page (moves to trash). */
  async deletePage(pageId: string): Promise<void> {
    await this.delete(`/content/${pageId}`);
  }

  /**
   * Fetch the version history for a page by individually requesting each
   * historical version's metadata (lightweight, no body). Works on all
   * Confluence Server versions that don't expose the /version sub-resource.
   *
   * @param pageId       - The page to inspect
   * @param currentVersion - Current version number (pass the value you already
   *                         fetched from getPage to avoid a second round-trip)
   */
  async getVersionHistory(pageId: string, currentVersion: number): Promise<PageVersion[]> {
    if (currentVersion <= 1) return [];

    const CONCURRENCY = 10;
    const all: PageVersion[] = [];

    // Fetch version metadata in parallel batches (oldest first, then reverse)
    for (let start = 1; start < currentVersion; start += CONCURRENCY) {
      const nums: number[] = [];
      for (let n = start; n < Math.min(start + CONCURRENCY, currentVersion); n++) {
        nums.push(n);
      }
      const batch = await Promise.all(
        nums.map((n) =>
          this.get<ConfluencePageSummary>(
            `/content/${pageId}?version=${n}&expand=version`,
          ).then((p): PageVersion => ({
            number:    p.version.number,
            when:      p.version.when,
            ...(p.version.by !== undefined ? { by: p.version.by } : {}),
            minorEdit: false,
          })),
        ),
      );
      all.push(...batch);
    }

    // Return newest first
    return all.sort((a, b) => b.number - a.number);
  }

  /**
   * Fetch the storage-format body of a page at a specific historical version.
   */
  async getPageAtVersion(pageId: string, versionNumber: number): Promise<ConfluencePage> {
    return this.get<ConfluencePage>(
      `/content/${pageId}?version=${versionNumber}&expand=body.storage,version,ancestors,_links,space`,
    );
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  /** List all attachments on a page. */
  async listAttachments(pageId: string): Promise<ConfluenceAttachment[]> {
    const all: ConfluenceAttachment[] = [];
    const BATCH = 100;
    let start = 0;

    while (true) {
      const batch = await this.get<PaginatedResult<ConfluenceAttachment>>(
        `/content/${pageId}/child/attachment?limit=${BATCH}&start=${start}&expand=version`,
      );
      all.push(...batch.results);
      if (batch.results.length < BATCH) break;
      start += BATCH;
    }

    return all;
  }

  /**
   * Download an attachment binary by its relative download path.
   * The path comes from `attachment._links.download`.
   */
  async downloadAttachment(downloadPath: string): Promise<ArrayBuffer> {
    // Download paths are relative to the base URL, not the REST API path.
    const url = `${this.baseUrl}${downloadPath}`;
    const res = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConfluenceError(
        `Confluence download error ${res.status} ${res.statusText}: ${body}`,
        res.status,
      );
    }

    return res.arrayBuffer();
  }

  /**
   * Upload a new attachment to a page.
   * If an attachment with the same filename already exists, Confluence
   * creates a new version of it automatically.
   */
  async uploadAttachment(params: {
    pageId: string;
    filename: string;
    data: ArrayBuffer | Uint8Array;
    mediaType?: string;
  }): Promise<ConfluenceAttachment> {
    const form = new FormData();
    const blob = new Blob([params.data], { type: params.mediaType ?? "application/octet-stream" });
    form.append("file", blob, params.filename);

    const url = `${this.baseUrl}/rest/api/content/${params.pageId}/child/attachment`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "X-Atlassian-Token": "nocheck",
      },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConfluenceError(
        `Confluence upload error ${res.status} ${res.statusText}: ${body}`,
        res.status,
      );
    }

    const result = (await res.json()) as PaginatedResult<ConfluenceAttachment>;
    return result.results[0]!;
  }

  /**
   * Update an existing attachment's binary data.
   * Uses POST to .../data endpoint which replaces the attachment content
   * and increments the attachment version.
   */
  async updateAttachmentData(params: {
    pageId: string;
    attachmentId: string;
    filename: string;
    data: ArrayBuffer | Uint8Array;
    mediaType?: string;
  }): Promise<ConfluenceAttachment> {
    const form = new FormData();
    const blob = new Blob([params.data], { type: params.mediaType ?? "application/octet-stream" });
    form.append("file", blob, params.filename);

    const url =
      `${this.baseUrl}/rest/api/content/${params.pageId}/child/attachment/${params.attachmentId}/data`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "X-Atlassian-Token": "nocheck",
      },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConfluenceError(
        `Confluence attachment update error ${res.status} ${res.statusText}: ${body}`,
        res.status,
      );
    }

    return (await res.json()) as ConfluenceAttachment;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /** Run a CQL search query. */
  async search(cql: string, limit = 20): Promise<PaginatedResult<ConfluencePageSummary>> {
    return this.get<PaginatedResult<ConfluencePageSummary>>(
      `/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=${ConfluenceClient.PAGE_EXPAND}`,
    );
  }
}

/** Convenience factory — reads config and returns a ready client. */
export async function createConfluenceClient(): Promise<ConfluenceClient> {
  const { requireSection } = await import("@/config");
  const config = await requireSection("confluence");
  return new ConfluenceClient(config);
}
