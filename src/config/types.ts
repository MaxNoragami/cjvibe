// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type AuthMethod = "bearer" | "basic";

export interface ConfluenceConfig {
  /** Base URL of your Confluence instance, e.g. https://wiki.example.com */
  baseUrl: string;
  /** Confluence username / email (used only for Basic auth) */
  username: string;
  /**
   * Authentication token.
   * - bearer (default for self-hosted): Personal Access Token from Confluence → Profile → PATs
   * - basic: API token, encoded together with username via Basic auth
   */
  token: string;
  /** Auth method. Defaults to "bearer" (Confluence Server / Data Center PATs). */
  authMethod?: AuthMethod;
  /** Default space key to operate in (optional) */
  defaultSpace?: string;
  /**
   * Root page ID to use as the sync root for `confluence tree` and future
   * pull/push operations. Find it in the URL: ?pageId=XXXXXXX
   */
  rootPageId?: string;
}

export interface Config {
  confluence?: ConfluenceConfig;
  // jira?: JiraConfig  — reserved for future use
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const EMPTY_CONFIG: Config = {};
