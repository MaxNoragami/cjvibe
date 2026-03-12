import type { JiraConfig } from "@/config/types";
import { CjvibeError } from "@/utils/errors";
import type {
  JiraBoard,
  JiraBoardConfig,
  JiraIssue,
  JiraPaginatedResult,
  JiraSearchResult,
  JiraUser,
} from "./types";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class JiraError extends CjvibeError {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message, "JIRA_ERROR", 1);
    this.name = "JiraError";
  }
}

// ---------------------------------------------------------------------------
// JiraClient
// ---------------------------------------------------------------------------

export class JiraClient {
  readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly config: JiraConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    const method = config.authMethod ?? "bearer";
    this.authHeader =
      method === "bearer"
        ? `Bearer ${config.token}`
        : "Basic " + btoa(`${config.username}:${config.token}`);
  }

  // ---------------------------------------------------------------------------
  // HTTP primitives
  // ---------------------------------------------------------------------------

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
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
      throw new JiraError(
        `Jira API error ${res.status} ${res.statusText}: ${body}`,
        res.status,
      );
    }

    return res.json() as Promise<T>;
  }

  private get<T>(path: string, api: "agile" | "api2" = "api2"): Promise<T> {
    const prefix = api === "agile" ? "/rest/agile/1.0" : "/rest/api/2";
    return this.request<T>(`${this.baseUrl}${prefix}${path}`);
  }

  // ---------------------------------------------------------------------------
  // User
  // ---------------------------------------------------------------------------

  /** Get the currently authenticated user's info. */
  async myself(): Promise<JiraUser> {
    return this.get<JiraUser>("/myself");
  }

  // ---------------------------------------------------------------------------
  // Boards
  // ---------------------------------------------------------------------------

  /** List all boards visible to the user (auto-paginates). */
  async listBoards(): Promise<JiraBoard[]> {
    const all: JiraBoard[] = [];
    let startAt = 0;
    const max = 50;
    while (true) {
      const page = await this.get<JiraPaginatedResult<JiraBoard>>(
        `/board?startAt=${startAt}&maxResults=${max}`,
        "agile",
      );
      all.push(...page.values);
      if (page.isLast || page.values.length < max) break;
      startAt += max;
    }
    return all;
  }

  /** Get board configuration (columns/statuses). */
  async getBoardConfig(boardId: number): Promise<JiraBoardConfig> {
    return this.get<JiraBoardConfig>(`/board/${boardId}/configuration`, "agile");
  }

  // ---------------------------------------------------------------------------
  // Issues
  // ---------------------------------------------------------------------------

  /**
   * Fetch all issues on a board. Uses the agile endpoint which respects
   * the board's filter.
   */
  async getBoardIssues(
    boardId: number,
    opts: { assignee?: string | undefined; maxResults?: number | undefined } = {},
  ): Promise<JiraIssue[]> {
    const all: JiraIssue[] = [];
    let startAt = 0;
    const max = opts.maxResults ?? 50;
    const jql = opts.assignee ? `assignee=${opts.assignee}` : "";

    while (true) {
      const fields = "summary,status,assignee,reporter,issuetype,priority,project,created,updated,description,labels,components,fixVersions,parent,subtasks";
      let path = `/board/${boardId}/issue?startAt=${startAt}&maxResults=${max}&fields=${fields}`;
      if (jql) path += `&jql=${encodeURIComponent(jql)}`;
      const page = await this.get<JiraSearchResult>(path, "agile");
      all.push(...page.issues);
      if (startAt + page.maxResults >= page.total) break;
      startAt += max;
    }
    return all;
  }

  /** Get a single issue by key. */
  async getIssue(key: string): Promise<JiraIssue> {
    return this.get<JiraIssue>(`/issue/${key}`);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createJiraClient(): Promise<JiraClient> {
  const { requireSection } = await import("@/config");
  const config = await requireSection("jira");
  return new JiraClient(config);
}
