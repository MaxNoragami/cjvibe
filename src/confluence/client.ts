import type { ConfluenceConfig } from "@/config/types";
import { ConfluenceError } from "@/utils/errors";
import type {
  ConfluencePage,
  ConfluencePageSummary,
  ConfluenceSpace,
  PageTreeNode,
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
    return this.put<ConfluencePage>(`/content/${params.pageId}`, {
      type: "page",
      title: params.title,
      version: { number: params.currentVersion + 1 },
      body: { storage: { value: params.body, representation: "storage" } },
    });
  }

  /** Delete a page (moves to trash). */
  async deletePage(pageId: string): Promise<void> {
    await this.delete(`/content/${pageId}`);
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
