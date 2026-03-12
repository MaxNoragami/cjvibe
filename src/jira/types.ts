// ---------------------------------------------------------------------------
// Jira REST API — raw response shapes (Jira Server/DC)
// ---------------------------------------------------------------------------

export interface JiraUser {
  key: string;
  name: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: {
    id: number;
    key: string;       // "new" | "indeterminate" | "done"
    name: string;
    colorName: string;
  };
}

export interface JiraPriority {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
  iconUrl?: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraComponent {
  id: string;
  name: string;
}

export interface JiraFixVersion {
  id: string;
  name: string;
  released: boolean;
}

export interface JiraIssueFields {
  summary: string;
  status: JiraStatus;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  issuetype: JiraIssueType;
  priority: JiraPriority | null;
  project: JiraProject;
  created: string;
  updated: string;
  description: string | null;
  labels: string[];
  components: JiraComponent[];
  fixVersions: JiraFixVersion[];
  parent?: { key: string; fields: { summary: string } };
  subtasks?: { key: string; fields: { summary: string; status: JiraStatus } }[];
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraBoard {
  id: number;
  name: string;
  type: string;          // "kanban" | "scrum" | "simple"
  self: string;
  location?: {
    projectId: number;
    projectKey: string;
    projectName: string;
  };
}

export interface JiraColumn {
  name: string;
  statuses: { id: string; self: string }[];
}

export interface JiraBoardConfig {
  id: number;
  name: string;
  columnConfig: {
    columns: JiraColumn[];
  };
}

export interface JiraPaginatedResult<T> {
  maxResults: number;
  startAt: number;
  total?: number;       // not always present on agile endpoints
  isLast?: boolean;
  values: T[];
}

/** /rest/api/2/search returns results in 'issues' key */
export interface JiraSearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}
