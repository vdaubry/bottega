// Typed REST client for the backend.
//
// Every method returns `Promise<TypedResponse<T>>`, which is structurally a
// `Response` whose `.json()` is narrowed to `T`. Consumers keep the
// existing call shape (`const r = await api.foo(); if (r.ok) const data =
// await r.json()`) and gain inference at the `data` step automatically.
//
// Request bodies are typed against the matching `<Endpoint>Request` shape
// in `shared/api/*` so a server-side rename surfaces as a tsc error.

import type { TypedResponse } from '../../shared/api/_common';
import type {
  AuthStatusResponse,
  AuthSuccessResponse,
  GetCurrentUserResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
  LogoutResponse,
  ApiKeyStatusResponse,
  GenerateApiKeyResponse,
  RevokeApiKeyResponse,
  ClaudeAuthStatusResponse,
  StartClaudeAuthResponse,
  CompleteClaudeAuthRequest,
  CompleteClaudeAuthResponse,
  CancelClaudeAuthResponse,
  ClearClaudeAuthResponse,
} from '../../shared/api/auth';
import type {
  ListProjectsResponse,
  GetProjectResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  DeleteProjectResponse,
  UploadProjectFileResponse,
  GetWebServerResponse,
  UpdateWebServerConfigRequest,
  UpdateWebServerConfigResponse,
  SwitchWebServerRequest,
  SwitchWebServerResponse,
  VerifyWebServerResponse,
} from '../../shared/api/projects';
import type {
  ListAllTasksResponse,
  ListProjectTasksResponse,
  GetTaskResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
  DeleteTaskResponse,
  GetTaskDocResponse,
  UpdateTaskDocRequest,
  UpdateTaskDocResponse,
  ListTaskAttachmentsResponse,
  UploadTaskAttachmentResponse,
  DeleteTaskAttachmentResponse,
  CleanupOldCompletedTasksResponse,
  SetWorkflowCompleteRequest,
  SetWorkflowCompleteResponse,
  ResumeTaskRequest,
  ResumeTaskResponse,
  WorktreeStatusResponse,
  SyncWorktreeResponse,
  CreatePRRequest,
  CreatePRResponse,
  GetPRResponse,
  MergeAndCleanupResponse,
  PushChangesRequest,
  PushChangesResponse,
  DiscardWorktreeResponse,
} from '../../shared/api/tasks';
import type { TaskStatus } from '../../shared/types/db';
import type {
  ListConversationsResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  GetConversationResponse,
  DeleteConversationResponse,
  UpdateConversationRequest,
  UpdateConversationResponse,
  GetConversationMessagesResponse,
  GetContextUsageResponse,
} from '../../shared/api/conversations';
import type { Provider } from '../../shared/providers/types';
import type {
  ListAgentRunsResponse,
  CreateAgentRunRequest,
  CreateAgentRunResponse,
  GetAgentRunResponse,
  CompleteAgentRunResponse,
  LinkConversationRequest,
  LinkConversationResponse,
  DeleteAgentRunResponse,
} from '../../shared/api/agent-runs';
import type {
  ListAdminUsersResponse,
  CreateAdminUserRequest,
  CreateAdminUserResponse,
  UpdateAdminUserRequest,
  UpdateAdminUserResponse,
  DeleteAdminUserResponse,
  ListAdminProjectsResponse,
  GetProjectMembersResponse,
  AddProjectMemberRequest,
  AddProjectMemberResponse,
  RemoveProjectMemberResponse,
} from '../../shared/api/admin';
import type {
  ListPromptsResponse,
  GetPromptResponse,
  SavePromptRequest,
  SavePromptResponse,
  GetAppSettingsResponse,
  UpdateAppSettingsRequest,
  UpdateAppSettingsResponse,
  ListCommandsResponse,
} from '../../shared/api/settings';
import type {
  CodexAuthStatusResponse,
  PasteCodexAuthResponse,
  ClearCodexAuthResponse,
  StartCodexAuthResponse,
  CancelCodexAuthResponse,
} from '../../shared/api/codexAuth';
import type {
  ClearOpenCodeKeyResponse,
  OpenCodeAuthStatusResponse,
  OpenCodeModelsResponse,
  SetOpenCodeKeyResponse,
} from '../../shared/api/openCodeAuth';
import type {
  ConnectedProvidersResponse,
  GetUserAgentModelSettingsResponse,
  UpdateUserAgentModelSettingsResponse,
} from '../../shared/api/userAgentModelSettings';
import type { AgentModelSettings } from '../../shared/types/agentModelSettings';

// `TypedFetch<T>` keeps all `Response` ergonomics (`.ok`, `.status`,
// `.headers`) intact while narrowing `.json()` to `T`.
type TypedFetch<T> = Promise<TypedResponse<T>>;

// Recursive directory entry returned by `GET /api/projects/:id/files`
// (server-side helper `getFileTree` in `server/index.js`). Used by the
// `@`-mention file picker in `MessageInput`.
export interface FileTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string | null;
  permissions?: string;
  permissionsRwx?: string;
  children?: FileTreeEntry[];
}

interface AuthFetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

// Header set by the backend on every successful JWT request — sliding
// 30d refresh so the user never gets logged out while active. Reading a
// header does not consume the body, so the returned Response is still
// fully usable by callers.
const REFRESHED_TOKEN_HEADER = 'X-Refreshed-Token';

// Utility function for authenticated API calls
export const authenticatedFetch = <T = unknown>(
  url: string,
  options: AuthFetchOptions = {}
): TypedFetch<T> => {
  const token = localStorage.getItem('auth-token');

  // Check if body is FormData - don't set Content-Type to let browser handle it
  const isFormData = options.body instanceof FormData;

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!isFormData) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshed = response.headers.get(REFRESHED_TOKEN_HEADER);
    if (refreshed) {
      localStorage.setItem('auth-token', refreshed);
    }
    return response;
  });
};

const createConversationWithMessage = (
  kind: 'tasks',
  id: number,
  payload: CreateConversationRequest
): TypedFetch<CreateConversationResponse> =>
  authenticatedFetch<CreateConversationResponse>(`/api/${kind}/${id}/conversations`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: (): TypedFetch<AuthStatusResponse> =>
      fetch('/api/auth/status'),
    login: (username: string, password: string): TypedFetch<AuthSuccessResponse> =>
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    register: (username: string, password: string): TypedFetch<AuthSuccessResponse> =>
      fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    user: (): TypedFetch<GetCurrentUserResponse> =>
      authenticatedFetch<GetCurrentUserResponse>('/api/auth/user'),
    logout: (): TypedFetch<LogoutResponse> =>
      authenticatedFetch<LogoutResponse>('/api/auth/logout', { method: 'POST' }),
    updateProfile: (updates: UpdateProfileRequest): TypedFetch<UpdateProfileResponse> =>
      authenticatedFetch<UpdateProfileResponse>('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  claudeAuth: {
    status: (): TypedFetch<ClaudeAuthStatusResponse> =>
      authenticatedFetch<ClaudeAuthStatusResponse>('/api/claude-auth/status'),
    start: (): TypedFetch<StartClaudeAuthResponse> =>
      authenticatedFetch<StartClaudeAuthResponse>('/api/claude-auth/start', {
        method: 'POST',
      }),
    complete: (
      loginSessionId: string,
      code: string
    ): TypedFetch<CompleteClaudeAuthResponse> => {
      const body: CompleteClaudeAuthRequest = { loginSessionId, code };
      return authenticatedFetch<CompleteClaudeAuthResponse>('/api/claude-auth/complete', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    cancel: (): TypedFetch<CancelClaudeAuthResponse> =>
      authenticatedFetch<CancelClaudeAuthResponse>('/api/claude-auth/cancel', {
        method: 'POST',
      }),
    clear: (): TypedFetch<ClearClaudeAuthResponse> =>
      authenticatedFetch<ClearClaudeAuthResponse>('/api/claude-auth', {
        method: 'DELETE',
      }),
  },

  openCodeAuth: {
    status: (): TypedFetch<OpenCodeAuthStatusResponse> =>
      authenticatedFetch<OpenCodeAuthStatusResponse>('/api/opencode-auth/status'),
    setKey: (apiKey: string): TypedFetch<SetOpenCodeKeyResponse> =>
      authenticatedFetch<SetOpenCodeKeyResponse>('/api/opencode-auth/key', {
        method: 'PUT',
        body: JSON.stringify({ apiKey }),
      }),
    clear: (): TypedFetch<ClearOpenCodeKeyResponse> =>
      authenticatedFetch<ClearOpenCodeKeyResponse>('/api/opencode-auth/key', {
        method: 'DELETE',
      }),
    models: (): TypedFetch<OpenCodeModelsResponse> =>
      authenticatedFetch<OpenCodeModelsResponse>('/api/opencode-auth/models'),
    modelsGo: (): TypedFetch<OpenCodeModelsResponse> =>
      authenticatedFetch<OpenCodeModelsResponse>('/api/opencode-auth/models-go'),
  },

  codexAuth: {
    status: (): TypedFetch<CodexAuthStatusResponse> =>
      authenticatedFetch<CodexAuthStatusResponse>('/api/codex-auth/status'),
    start: (): TypedFetch<StartCodexAuthResponse> =>
      authenticatedFetch<StartCodexAuthResponse>('/api/codex-auth/start', {
        method: 'POST',
      }),
    cancel: (): TypedFetch<CancelCodexAuthResponse> =>
      authenticatedFetch<CancelCodexAuthResponse>('/api/codex-auth/cancel', {
        method: 'POST',
      }),
    paste: (authJson: string): TypedFetch<PasteCodexAuthResponse> =>
      authenticatedFetch<PasteCodexAuthResponse>('/api/codex-auth/paste', {
        method: 'POST',
        body: JSON.stringify({ authJson }),
      }),
    clear: (): TypedFetch<ClearCodexAuthResponse> =>
      authenticatedFetch<ClearCodexAuthResponse>('/api/codex-auth', {
        method: 'DELETE',
      }),
  },

  account: {
    getApiKey: (): TypedFetch<ApiKeyStatusResponse> =>
      authenticatedFetch<ApiKeyStatusResponse>('/api/account/api-key'),
    generateApiKey: (): TypedFetch<GenerateApiKeyResponse> =>
      authenticatedFetch<GenerateApiKeyResponse>('/api/account/api-key', { method: 'POST' }),
    revokeApiKey: (): TypedFetch<RevokeApiKeyResponse> =>
      authenticatedFetch<RevokeApiKeyResponse>('/api/account/api-key', { method: 'DELETE' }),
  },

  // Task-driven workflow API
  // Projects API
  projects: {
    list: (): TypedFetch<ListProjectsResponse> =>
      authenticatedFetch<ListProjectsResponse>('/api/projects'),
    create: (name: string, repoFolderPath: string): TypedFetch<CreateProjectResponse> => {
      const body: CreateProjectRequest = { name, repoFolderPath };
      return authenticatedFetch<CreateProjectResponse>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    get: (id: number): TypedFetch<GetProjectResponse> =>
      authenticatedFetch<GetProjectResponse>(`/api/projects/${id}`),
    update: (id: number, data: UpdateProjectRequest): TypedFetch<UpdateProjectResponse> =>
      authenticatedFetch<UpdateProjectResponse>(`/api/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: number): TypedFetch<DeleteProjectResponse> =>
      authenticatedFetch<DeleteProjectResponse>(`/api/projects/${id}`, {
        method: 'DELETE',
      }),
    // Web server management (for worktree serving)
    getWebServer: (id: number): TypedFetch<GetWebServerResponse> =>
      authenticatedFetch<GetWebServerResponse>(`/api/projects/${id}/web-server`),
    updateWebServerConfig: (
      id: number,
      config: UpdateWebServerConfigRequest
    ): TypedFetch<UpdateWebServerConfigResponse> =>
      authenticatedFetch<UpdateWebServerConfigResponse>(`/api/projects/${id}/web-server/config`, {
        method: 'PUT',
        body: JSON.stringify(config),
      }),
    switchWebServer: (
      id: number,
      taskId: number | null
    ): TypedFetch<SwitchWebServerResponse> => {
      const body: SwitchWebServerRequest = { taskId };
      return authenticatedFetch<SwitchWebServerResponse>(`/api/projects/${id}/web-server/switch`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    verifyWebServer: (id: number): TypedFetch<VerifyWebServerResponse> =>
      authenticatedFetch<VerifyWebServerResponse>(`/api/projects/${id}/web-server/verify`),
    // Upload file to project's tmp folder for conversations
    uploadFile: (projectId: number, file: File): TypedFetch<UploadProjectFileResponse> => {
      const formData = new FormData();
      formData.append('file', file);
      return authenticatedFetch<UploadProjectFileResponse>(`/api/projects/${projectId}/upload`, {
        method: 'POST',
        body: formData,
        headers: {}, // Let browser set Content-Type for FormData
      });
    },
  },

  // Tasks API
  tasks: {
    // Get all tasks across all projects, optionally filtered by status
    listAll: (status: TaskStatus | null = null): TypedFetch<ListAllTasksResponse> => {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      const queryString = params.toString();
      return authenticatedFetch<ListAllTasksResponse>(
        `/api/tasks${queryString ? '?' + queryString : ''}`
      );
    },
    list: (projectId: number): TypedFetch<ListProjectTasksResponse> =>
      authenticatedFetch<ListProjectTasksResponse>(`/api/projects/${projectId}/tasks`),
    create: (
      projectId: number,
      title: string,
      description: string,
      options: Omit<CreateTaskRequest, 'title' | 'description'> = {}
    ): TypedFetch<CreateTaskResponse> => {
      const body: CreateTaskRequest = { title, description, ...options };
      return authenticatedFetch<CreateTaskResponse>(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    get: (id: number): TypedFetch<GetTaskResponse> =>
      authenticatedFetch<GetTaskResponse>(`/api/tasks/${id}`),
    update: (id: number, data: UpdateTaskRequest): TypedFetch<UpdateTaskResponse> =>
      authenticatedFetch<UpdateTaskResponse>(`/api/tasks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    setWorkflowComplete: (
      id: number,
      complete: boolean
    ): TypedFetch<SetWorkflowCompleteResponse> => {
      const body: SetWorkflowCompleteRequest = { complete };
      return authenticatedFetch<SetWorkflowCompleteResponse>(`/api/tasks/${id}/workflow-complete`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    delete: (id: number): TypedFetch<DeleteTaskResponse> =>
      authenticatedFetch<DeleteTaskResponse>(`/api/tasks/${id}`, {
        method: 'DELETE',
      }),
    getDoc: (id: number): TypedFetch<GetTaskDocResponse> =>
      authenticatedFetch<GetTaskDocResponse>(`/api/tasks/${id}/documentation`),
    saveDoc: (id: number, content: string): TypedFetch<UpdateTaskDocResponse> => {
      const body: UpdateTaskDocRequest = { content };
      return authenticatedFetch<UpdateTaskDocResponse>(`/api/tasks/${id}/documentation`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    cleanupOldCompleted: (
      projectId: number,
      keepCount = 20
    ): TypedFetch<CleanupOldCompletedTasksResponse> =>
      authenticatedFetch<CleanupOldCompletedTasksResponse>(
        `/api/projects/${projectId}/tasks/cleanup-old-completed?keep=${keepCount}`,
        { method: 'DELETE' }
      ),
    // Worktree methods (git isolation)
    getWorktree: (id: number): TypedFetch<WorktreeStatusResponse> =>
      authenticatedFetch<WorktreeStatusResponse>(`/api/tasks/${id}/worktree`),
    syncWorktree: (id: number): TypedFetch<SyncWorktreeResponse> =>
      authenticatedFetch<SyncWorktreeResponse>(`/api/tasks/${id}/sync`, {
        method: 'POST',
      }),
    createPR: (id: number, title: string, body: string): TypedFetch<CreatePRResponse> => {
      const reqBody: CreatePRRequest = { title, body };
      return authenticatedFetch<CreatePRResponse>(`/api/tasks/${id}/pull-request`, {
        method: 'POST',
        body: JSON.stringify(reqBody),
      });
    },
    getPR: (id: number): TypedFetch<GetPRResponse> =>
      authenticatedFetch<GetPRResponse>(`/api/tasks/${id}/pull-request`),
    mergeAndCleanup: (id: number): TypedFetch<MergeAndCleanupResponse> =>
      authenticatedFetch<MergeAndCleanupResponse>(`/api/tasks/${id}/merge-cleanup`, {
        method: 'POST',
      }),
    discardWorktree: (id: number, force = false): TypedFetch<DiscardWorktreeResponse> =>
      authenticatedFetch<DiscardWorktreeResponse>(
        `/api/tasks/${id}/worktree${force ? '?force=true' : ''}`,
        { method: 'DELETE' }
      ),
    pushChanges: (id: number, commitMessage?: string): TypedFetch<PushChangesResponse> => {
      const body: PushChangesRequest = { commitMessage };
      return authenticatedFetch<PushChangesResponse>(`/api/tasks/${id}/push-changes`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    // Resume a blocked workflow
    resume: (id: number, restartAgent = false): TypedFetch<ResumeTaskResponse> => {
      const body: ResumeTaskRequest = { restart_agent: restartAgent };
      return authenticatedFetch<ResumeTaskResponse>(`/api/tasks/${id}/resume`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    // Review recording — HEAD-only check; the body is the binary stream.
    checkReviewRecording: (taskId: number): TypedFetch<unknown> =>
      authenticatedFetch<unknown>(`/api/tasks/${taskId}/review-recording`, { method: 'HEAD' }),
    // Task attachments
    listAttachments: (taskId: number): TypedFetch<ListTaskAttachmentsResponse> =>
      authenticatedFetch<ListTaskAttachmentsResponse>(`/api/tasks/${taskId}/attachments`),
    uploadAttachment: (taskId: number, file: File): TypedFetch<UploadTaskAttachmentResponse> => {
      const formData = new FormData();
      formData.append('file', file);
      return authenticatedFetch<UploadTaskAttachmentResponse>(`/api/tasks/${taskId}/attachments`, {
        method: 'POST',
        body: formData,
        headers: {},
      });
    },
    deleteAttachment: (
      taskId: number,
      filename: string
    ): TypedFetch<DeleteTaskAttachmentResponse> =>
      authenticatedFetch<DeleteTaskAttachmentResponse>(
        `/api/tasks/${taskId}/attachments/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      ),
  },

  // Conversations API
  conversations: {
    list: (taskId: number): TypedFetch<ListConversationsResponse> =>
      authenticatedFetch<ListConversationsResponse>(`/api/tasks/${taskId}/conversations`),
    // Pre-create an empty conversation row stamped with an explicit backend +
    // model (no message → no LLM session is started yet).
    create: (
      taskId: number,
      provider: Provider,
      model: string,
    ): TypedFetch<CreateConversationResponse> =>
      authenticatedFetch<CreateConversationResponse>(`/api/tasks/${taskId}/conversations`, {
        method: 'POST',
        body: JSON.stringify({ provider, model }),
      }),
    // Create conversation with first message - returns conversation with real claude_conversation_id
    createWithMessage: (
      taskId: number,
      payload: CreateConversationRequest
    ): TypedFetch<CreateConversationResponse> =>
      createConversationWithMessage('tasks', taskId, payload),
    get: (id: number): TypedFetch<GetConversationResponse> =>
      authenticatedFetch<GetConversationResponse>(`/api/conversations/${id}`),
    delete: (id: number): TypedFetch<DeleteConversationResponse> =>
      authenticatedFetch<DeleteConversationResponse>(`/api/conversations/${id}`, {
        method: 'DELETE',
      }),
    update: (
      id: number,
      data: UpdateConversationRequest
    ): TypedFetch<UpdateConversationResponse> =>
      authenticatedFetch<UpdateConversationResponse>(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    getMessages: (
      id: number,
      limit: number | null = null,
      offset = 0
    ): TypedFetch<GetConversationMessagesResponse> => {
      const params = new URLSearchParams();
      if (limit) params.append('limit', String(limit));
      if (offset) params.append('offset', String(offset));
      const queryString = params.toString();
      return authenticatedFetch<GetConversationMessagesResponse>(
        `/api/conversations/${id}/messages${queryString ? '?' + queryString : ''}`
      );
    },
    getContextUsage: (id: number): TypedFetch<GetContextUsageResponse> =>
      authenticatedFetch<GetContextUsageResponse>(`/api/conversations/${id}/context-usage`),
  },

  // Agent Runs API (for automated agent workflows on tasks)
  agentRuns: {
    list: (taskId: number): TypedFetch<ListAgentRunsResponse> =>
      authenticatedFetch<ListAgentRunsResponse>(`/api/tasks/${taskId}/agent-runs`),
    create: (
      taskId: number,
      agentType: CreateAgentRunRequest['agentType']
    ): TypedFetch<CreateAgentRunResponse> => {
      const body: CreateAgentRunRequest = { agentType };
      return authenticatedFetch<CreateAgentRunResponse>(`/api/tasks/${taskId}/agent-runs`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    get: (id: number): TypedFetch<GetAgentRunResponse> =>
      authenticatedFetch<GetAgentRunResponse>(`/api/agent-runs/${id}`),
    complete: (id: number): TypedFetch<CompleteAgentRunResponse> =>
      authenticatedFetch<CompleteAgentRunResponse>(`/api/agent-runs/${id}/complete`, {
        method: 'PUT',
      }),
    linkConversation: (
      id: number,
      conversationId: number
    ): TypedFetch<LinkConversationResponse> => {
      const body: LinkConversationRequest = { conversationId };
      return authenticatedFetch<LinkConversationResponse>(
        `/api/agent-runs/${id}/link-conversation`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        }
      );
    },
    delete: (id: number): TypedFetch<DeleteAgentRunResponse> =>
      authenticatedFetch<DeleteAgentRunResponse>(`/api/agent-runs/${id}`, {
        method: 'DELETE',
      }),
  },

  // Streaming sessions (for live indicator). The endpoint lives inline in
  // server/index.js and returns active sessions with their task/conversation
  // linkage. Response shape is mirrored from
  // `getAllActiveStreamingSessions()` in
  // server/services/conversation/sessionControl.js.
  streamingSessions: {
    getActive: (): TypedFetch<{
      sessions: Array<{
        sessionId: string;
        taskId: number;
        conversationId: number;
      }>;
    }> =>
      authenticatedFetch<{
        sessions: Array<{
          sessionId: string;
          taskId: number;
          conversationId: number;
        }>;
      }>('/api/streaming-sessions'),
  },

  // Voice transcription — handler in server/index.js, opaque pass-through
  // to the Whisper API. Returns `{ text: string }` on success.
  transcribe: (formData: FormData): TypedFetch<{ text: string }> =>
    authenticatedFetch<{ text: string }>('/api/transcribe', {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // Slash commands endpoint
  getCommands: (projectPath?: string): TypedFetch<ListCommandsResponse> =>
    authenticatedFetch<ListCommandsResponse>('/api/commands/list', {
      method: 'POST',
      body: JSON.stringify({ projectPath: projectPath || '' }),
    }),

  // Get files for a project (for @ file referencing). Inline handler in
  // server/index.js — returns a recursive directory tree (files + nested
  // children) for the project's repo folder.
  getFiles: (projectId: number): TypedFetch<FileTreeEntry[]> =>
    authenticatedFetch<FileTreeEntry[]>(`/api/projects/${projectId}/files`),

  // Admin endpoints (requires admin privileges)
  admin: {
    // User management
    listUsers: (): TypedFetch<ListAdminUsersResponse> =>
      authenticatedFetch<ListAdminUsersResponse>('/api/admin/users'),
    createUser: (
      username: string,
      password: string,
      is_admin = false
    ): TypedFetch<CreateAdminUserResponse> => {
      const body: CreateAdminUserRequest = { username, password, is_admin };
      return authenticatedFetch<CreateAdminUserResponse>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    updateUser: (
      id: number,
      data: UpdateAdminUserRequest
    ): TypedFetch<UpdateAdminUserResponse> =>
      authenticatedFetch<UpdateAdminUserResponse>(`/api/admin/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteUser: (id: number): TypedFetch<DeleteAdminUserResponse> =>
      authenticatedFetch<DeleteAdminUserResponse>(`/api/admin/users/${id}`, {
        method: 'DELETE',
      }),
    // Project membership management
    listProjects: (): TypedFetch<ListAdminProjectsResponse> =>
      authenticatedFetch<ListAdminProjectsResponse>('/api/admin/projects'),
    getProjectMembers: (projectId: number): TypedFetch<GetProjectMembersResponse> =>
      authenticatedFetch<GetProjectMembersResponse>(`/api/admin/projects/${projectId}/members`),
    addProjectMember: (
      projectId: number,
      userId: number
    ): TypedFetch<AddProjectMemberResponse> => {
      const body: AddProjectMemberRequest = { userId };
      return authenticatedFetch<AddProjectMemberResponse>(
        `/api/admin/projects/${projectId}/members`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      );
    },
    removeProjectMember: (
      projectId: number,
      userId: number
    ): TypedFetch<RemoveProjectMemberResponse> =>
      authenticatedFetch<RemoveProjectMemberResponse>(
        `/api/admin/projects/${projectId}/members/${userId}`,
        { method: 'DELETE' }
      ),
  },

  // Global instance settings (key/value, e.g. internalToolName, githubPrTrigger).
  // GET is public; PUT requires admin (enforced server-side).
  appSettings: {
    get: (): TypedFetch<GetAppSettingsResponse> =>
      fetch('/api/app-settings'),
    update: (updates: UpdateAppSettingsRequest): TypedFetch<UpdateAppSettingsResponse> =>
      authenticatedFetch<UpdateAppSettingsResponse>('/api/app-settings', {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Per-user agent (provider, model, effort) settings.
  userAgentModelSettings: {
    get: (): TypedFetch<GetUserAgentModelSettingsResponse> =>
      authenticatedFetch<GetUserAgentModelSettingsResponse>('/api/user-agent-model-settings'),
    update: (
      settings: AgentModelSettings,
    ): TypedFetch<UpdateUserAgentModelSettingsResponse> =>
      authenticatedFetch<UpdateUserAgentModelSettingsResponse>('/api/user-agent-model-settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
    connectedProviders: (): TypedFetch<ConnectedProvidersResponse> =>
      authenticatedFetch<ConnectedProvidersResponse>(
        '/api/user-agent-model-settings/connected-providers',
      ),
  },

  // Settings (global)
  settings: {
    listPrompts: (): TypedFetch<ListPromptsResponse> =>
      authenticatedFetch<ListPromptsResponse>('/api/settings/prompts'),
    getPrompt: (name: string): TypedFetch<GetPromptResponse> =>
      authenticatedFetch<GetPromptResponse>(`/api/settings/prompts/${encodeURIComponent(name)}`),
    savePrompt: (
      name: string,
      content: string,
      expectedMtime?: number
    ): TypedFetch<SavePromptResponse> => {
      const body: SavePromptRequest = { content, expectedMtime };
      return authenticatedFetch<SavePromptResponse>(
        `/api/settings/prompts/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        }
      );
    },
    resetPrompt: (name: string): TypedFetch<unknown> =>
      authenticatedFetch<unknown>(`/api/settings/prompts/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
  },

  // Generic GET method for any endpoint. Returns `unknown` — callers must
  // narrow at use site (or migrate to a dedicated typed method).
  get: (endpoint: string): TypedFetch<unknown> =>
    authenticatedFetch<unknown>(`/api${endpoint}`),
};
