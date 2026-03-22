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
  /**
   * Jira server name used when reconstructing {jira:KEY} macros on push.
   * Found inside Confluence's Jira macro XML: <ac:parameter ac:name="server">
   */
  jiraServer?: string;
  /**
   * Jira serverId used when reconstructing {jira:KEY} macros on push.
   * Found inside Confluence's Jira macro XML: <ac:parameter ac:name="serverId">
   */
  jiraServerId?: string;
}

export interface JiraConfig {
  /** Base URL of your Jira instance, e.g. https://jira.example.com */
  baseUrl: string;
  /** Jira username / email */
  username: string;
  /** Personal access token (Bearer) or API token (Basic) */
  token: string;
  /** Auth method. Defaults to "bearer" (Jira Server / Data Center PATs). */
  authMethod?: AuthMethod;
  /** Default board ID to operate on */
  defaultBoardId?: number;
  /** Default board name (for display) */
  defaultBoardName?: string;
}

/** Tracks a single attachment synced alongside a page. */
export interface AttachmentManifestEntry {
  /** Confluence attachment ID */
  attachmentId: string;
  /** Filename (same as on Confluence) */
  filename: string;
  /** SHA-256 hash of the local binary at last sync */
  hash: string;
  /** Attachment version number at last sync */
  version: number;
}

/** Tracks which pages are synced and their last-known state. */
export interface SyncManifestEntry {
  /** Confluence page ID */
  pageId: string;
  /** Page title at time of last sync */
  title: string;
  /** Version number at time of last sync */
  version: number;
  /** SHA-256 hash of the local .gcm file content at last sync */
  hash: string;
  /** Relative path to the .gcm file from pagesDir (e.g. "PageDir/content.gcm") */
  file: string;
  /** Attachment entries synced for this page */
  attachments?: AttachmentManifestEntry[];
}

export interface SyncManifest {
  /** Space key this manifest belongs to */
  spaceKey: string;
  /** Epoch ms of last sync */
  lastSync: number;
  /** Page entries */
  pages: SyncManifestEntry[];
}

export interface Config {
  confluence?: ConfluenceConfig;
  jira?: JiraConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const EMPTY_CONFIG: Config = {};
