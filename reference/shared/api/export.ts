export interface ExportCorpusResponse {
  exported_at: string;
  exported_by: { id: number; username: string };
  projects: ExportProject[];
}

export interface ExportProject {
  id: number;
  name: string;
  repo_folder_path: string;
  created_at: string;
  updated_at: string;
  tasks: ExportTask[];
}

export interface ExportTask {
  id: number;
  title: string | null;
  description: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  conversations: ExportConversation[];
}

export interface ExportConversation {
  id: number;
  name: string | null;
  provider: string;
  model: string | null;
  effort: string | null;
  created_at: string;
  messages?: unknown[];
}
