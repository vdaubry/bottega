// Request/response shapes for the project endpoints:
//  - /api/projects/*                    (CRUD)
//  - /api/projects/:id/upload
//  - /api/projects/:id/web-server*      (mounted via webServer.js)
//  - /api/projects/:id/files            (inline handler in server/index.js)

import type { ProjectRow } from '../types/db';
import { expectType } from './_common';

// ---- Project CRUD ---------------------------------------------------------
//
// `getAllProjects(userId)` and `getProject(id, userId)` return raw
// `ProjectRow` shapes — there is no `task_counts` decoration today, despite
// what the earlier docs implied. If we ever add aggregation, define a
// `ProjectListItem` with `Pick<ProjectRow, …> & { task_counts: ... }` and
// migrate ListProjectsResponse to that.

export type ListProjectsResponse = ProjectRow[];

export type GetProjectResponse = ProjectRow;

export interface CreateProjectRequest {
  name: string;
  repoFolderPath: string;
  subprojectPath?: string;
  // The non-technical planning guardrail list (see ProjectRow.sensitive_areas).
  sensitiveAreas?: string;
}

export type CreateProjectResponse = ProjectRow;

export interface UpdateProjectRequest {
  name?: string | undefined;
  repoFolderPath?: string | undefined;
  subprojectPath?: string | undefined;
  // Blank or null clears the list (guardrail off); omit to leave it unchanged.
  sensitiveAreas?: string | null | undefined;
}

export type UpdateProjectResponse = ProjectRow;

export interface DeleteProjectResponse {
  success: true;
}

// ---- Files ----------------------------------------------------------------

// `/api/projects/:id/files` returns the file tree used by `@`-mention
// completion. The handler lives inline in `server/index.js`; the shape
// is one entry per file under the repo (subset suitable for autocomplete).
export interface ProjectFile {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export type GetProjectFilesResponse = ProjectFile[];

// ---- Upload ---------------------------------------------------------------
//
// Multipart upload to `tmp/`. The success body wraps a typed `file` shape
// produced by `saveConversationUpload()` — note `absolutePath` /
// `relativePath` are deliberate (consumers reference files by relative
// path in subsequent prompts).

export interface UploadedFile {
  name: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export interface UploadProjectFileResponse {
  success: true;
  file: UploadedFile;
}

// ---- Web server (mounted under projects) ----------------------------------
//
// Returns from the `webServerManager` service. The success/error envelope
// is reused across all four endpoints so the shape on the wire mixes
// success/failure fields. Consumers should branch on `success`.

export interface WebServerStatusSuccess {
  success: true;
  // What the serving symlink points at. At most one is non-null: a ticket
  // worktree, an epic's delivery worktree, or neither (the main checkout).
  activeTaskId: number | null;
  activeEpicId: number | null;
  // What to call it — the ticket title or the epic name — or null for main.
  // Resolved server-side so every surface says the same thing.
  activeName: string | null;
  // 'hook' — the project's own post-checkout hook provisions its worktrees.
  // 'none' — no hook; worktrees are bare checkouts (git-tracked files only).
  worktreeProvisioning: 'hook' | 'none';
  serveSymlinkPath: string | null;
  systemdServiceName: string | null;
  // Public URL of the deployed app; opened in a new tab after a successful
  // switch. `null` (or empty) means "don't open a tab".
  appUrl: string | null;
  isConfigured: boolean;
}

export interface WebServerStatusError {
  success: false;
  error: string;
}

export type GetWebServerResponse = WebServerStatusSuccess | WebServerStatusError;

export interface UpdateWebServerConfigRequest {
  serveSymlinkPath?: string | undefined;
  systemdServiceName?: string | undefined;
  appUrl?: string | undefined;
}

export type UpdateWebServerConfigResponse =
  | { success: true; project: ProjectRow }
  | { success: false; error: string };

export interface SwitchWebServerRequest {
  // Both `null` switches back to the main repo; `taskId` switches to that
  // task's worktree; `epicId` to that epic's delivery worktree (its feature
  // branch — every merged ticket together). Setting both is a 400.
  taskId: number | null;
  epicId?: number | null;
}

export type SwitchWebServerResponse =
  | {
      success: true;
      activeTaskId: number | null;
      activeEpicId?: number | null;
      // Present when the symlink updated but the systemd restart warned.
      warning?: string;
    }
  | { success: false; error: string };

export interface VerifyWebServerSuccess {
  success: true;
  matches: boolean;
  expectedTarget: string;
  actualTarget: string | null;
  symlinkExists: boolean;
  // Set when the symlink doesn't exist on disk but we still return 200.
  error?: string;
}

export interface VerifyWebServerError {
  success: false;
  error: string;
}

export type VerifyWebServerResponse = VerifyWebServerSuccess | VerifyWebServerError;

// ---- Type-level smoke checks ---------------------------------------------

expectType<ListProjectsResponse>([] as ProjectRow[]);
expectType<GetProjectResponse>({} as ProjectRow);
