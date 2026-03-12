import type { JiraConfig } from "@/config/types";
import { CjvibeError } from "@/utils/errors";
import type {
  JiraBoard,
  JiraBoardConfig,
  JiraComment,
  JiraCommentResult,
  JiraIssue,
  JiraPaginatedResult,
  JiraSearchResult,
  JiraUser,
  JiraWorklog,
  JiraWorklogResult,
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

  private post<T>(path: string, body: unknown, api: "agile" | "api2" = "api2"): Promise<T> {
    const prefix = api === "agile" ? "/rest/agile/1.0" : "/rest/api/2";
    return this.request<T>(`${this.baseUrl}${prefix}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private put<T>(path: string, body: unknown, api: "agile" | "api2" = "api2"): Promise<T> {
    const prefix = api === "agile" ? "/rest/agile/1.0" : "/rest/api/2";
    return this.request<T>(`${this.baseUrl}${prefix}${path}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
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

  /**
   * Update issue fields via the Jira edit endpoint.
   * `fields` is a partial map of field-name → value, matching Jira's
   * PUT /rest/api/2/issue/{key} body.
   */
  async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/api/2/issue/${key}`, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(`Jira API error ${res.status} ${res.statusText}: ${body}`, res.status);
    }
  }

  /**
   * Transition an issue to a new status by destination status name.
   * Matches against transition `to.name` first (actual target status), then
   * falls back to transition label (`name`) for compatibility.
   */
  async transitionIssue(
    key: string,
    statusName: string,
  ): Promise<{ ok: true } | { ok: false; availableStatuses: string[] }> {
    const data = await this.get<{
      transitions: { id: string; name: string; to?: { name?: string } }[];
    }>(`/issue/${key}/transitions`);

    const wanted = statusName.toLowerCase();
    const target = data.transitions.find((t) => {
      const toName = t.to?.name?.toLowerCase();
      return toName === wanted || t.name.toLowerCase() === wanted;
    });
    if (!target) {
      const availableStatuses = data.transitions
        .map((t) => t.to?.name ?? t.name)
        .filter((v): v is string => Boolean(v));
      return { ok: false, availableStatuses };
    }

    const res = await fetch(`${this.baseUrl}/rest/api/2/issue/${key}/transitions`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ transition: { id: target.id } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(`Transition failed ${res.status}: ${body}`, res.status);
    }
    return { ok: true };
  }

  /**
   * Search users by display name or username.
   * Returns matching JiraUser entries.
   */
  async findUsers(query: string): Promise<JiraUser[]> {
    return this.get<JiraUser[]>(`/user/search?username=${encodeURIComponent(query)}`);
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  /** Fetch all comments for an issue (auto-paginates). */
  async getComments(issueKey: string): Promise<JiraComment[]> {
    const all: JiraComment[] = [];
    let startAt = 0;
    const max = 100;
    while (true) {
      const page = await this.get<JiraCommentResult>(
        `/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${max}&orderBy=created`,
      );
      all.push(...page.comments);
      if (startAt + page.maxResults >= page.total) break;
      startAt += max;
    }
    return all;
  }

  /** Create a new comment on an issue. Returns the created comment. */
  async createComment(issueKey: string, body: string): Promise<JiraComment> {
    return this.post<JiraComment>(`/issue/${issueKey}/comment`, { body });
  }

  /** Update an existing comment. Returns the updated comment. */
  async updateComment(issueKey: string, commentId: string, body: string): Promise<JiraComment> {
    return this.put<JiraComment>(`/issue/${issueKey}/comment/${commentId}`, { body });
  }

  /** Delete a comment on an issue. */
  async deleteComment(issueKey: string, commentId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/api/2/issue/${issueKey}/comment/${commentId}`, {
      method: "DELETE",
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(`Jira API error ${res.status} ${res.statusText}: ${body}`, res.status);
    }
  }

  // ---------------------------------------------------------------------------
  // Worklogs
  // ---------------------------------------------------------------------------

  /** Fetch all worklogs for an issue (auto-paginates). */
  async getWorklogs(issueKey: string): Promise<JiraWorklog[]> {
    const all: JiraWorklog[] = [];
    let startAt = 0;
    const max = 100;
    while (true) {
      const page = await this.get<JiraWorklogResult>(
        `/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=${max}`,
      );
      all.push(...page.worklogs);
      if (startAt + page.maxResults >= page.total) break;
      startAt += max;
    }
    return all;
  }

  /** Create a new worklog entry. Returns the created worklog. */
  async createWorklog(
    issueKey: string,
    timeSpent: string,
    opts: { comment?: string; started?: string } = {},
  ): Promise<JiraWorklog> {
    return this.post<JiraWorklog>(`/issue/${issueKey}/worklog`, {
      timeSpent,
      ...(opts.comment ? { comment: opts.comment } : {}),
      ...(opts.started ? { started: opts.started } : {}),
    });
  }

  /** Update an existing worklog. Returns the updated worklog. */
  async updateWorklog(
    issueKey: string,
    worklogId: string,
    timeSpent: string,
    opts: { comment?: string; started?: string } = {},
  ): Promise<JiraWorklog> {
    return this.put<JiraWorklog>(`/issue/${issueKey}/worklog/${worklogId}`, {
      timeSpent,
      ...(opts.comment ? { comment: opts.comment } : {}),
      ...(opts.started ? { started: opts.started } : {}),
    });
  }

  /** Delete a worklog entry. */
  async deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/api/2/issue/${issueKey}/worklog/${worklogId}`, {
      method: "DELETE",
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(`Jira API error ${res.status} ${res.statusText}: ${body}`, res.status);
    }
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
