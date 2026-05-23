import { useState, useEffect } from 'react';
import { UserPlus, X, Users, FolderGit2 } from 'lucide-react';
import { Button } from '../ui/button';
import { api } from '../../utils/api';
import type {
  AdminProjectListItem,
  AdminUserListItem,
  ProjectMemberListItem,
} from '../../../shared/api/admin';
import type { ApiError } from '../../../shared/api/_common';

export interface ProjectMembersEditorProps {
  projects: AdminProjectListItem[];
  users: AdminUserListItem[];
  onMembershipChange?: () => void | Promise<void>;
}

function ProjectMembersEditor({
  projects,
  users,
  onMembershipChange,
}: ProjectMembersEditorProps) {
  const [selectedProject, setSelectedProject] = useState<AdminProjectListItem | null>(null);
  const [members, setMembers] = useState<ProjectMemberListItem[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedProject) {
      void loadMembers(selectedProject.id);
    } else {
      setMembers([]);
    }
     
  }, [selectedProject]);

  const loadMembers = async (projectId: number) => {
    setIsLoadingMembers(true);
    setError('');
    try {
      const response = await api.admin.getProjectMembers(projectId);
      if (response.ok) {
        const data = await response.json();
        setMembers(data);
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to load members');
      }
    } catch {
      setError('Failed to load members');
    } finally {
      setIsLoadingMembers(false);
    }
  };

  const handleAddMember = async (userId: number) => {
    if (!selectedProject) return;
    setIsUpdating(true);
    setError('');
    try {
      const response = await api.admin.addProjectMember(selectedProject.id, userId);
      if (response.ok) {
        await loadMembers(selectedProject.id);
        await onMembershipChange?.();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to add member');
      }
    } catch {
      setError('Failed to add member');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRemoveMember = async (userId: number) => {
    if (!selectedProject) return;
    setIsUpdating(true);
    setError('');
    try {
      const response = await api.admin.removeProjectMember(selectedProject.id, userId);
      if (response.ok) {
        await loadMembers(selectedProject.id);
        await onMembershipChange?.();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to remove member');
      }
    } catch {
      setError('Failed to remove member');
    } finally {
      setIsUpdating(false);
    }
  };

  const nonMembers = users.filter((u) => !members.find((m) => m.id === u.id));

  return (
    <div className="space-y-6">
      {/* Project Selector */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => setSelectedProject(project)}
            className={`p-4 rounded-lg border text-left transition-colors ${
              selectedProject?.id === project.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50 hover:bg-accent/50'
            }`}
          >
            <div className="flex items-start gap-3">
              <FolderGit2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h3 className="font-medium text-foreground truncate">{project.name}</h3>
                <p className="text-sm text-muted-foreground truncate">{project.repo_folder_path}</p>
                <div className="flex items-center gap-1 mt-2 text-sm text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  <span>{project.memberCount || 0} members</span>
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      {projects.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          No projects found
        </div>
      )}

      {/* Members Editor */}
      {selectedProject && (
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">
              Members of "{selectedProject.name}"
            </h3>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSelectedProject(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {error && (
            <div className="p-3 text-sm text-red-500 bg-red-500/10 rounded-md">
              {error}
            </div>
          )}

          {isLoadingMembers ? (
            <div className="text-center py-4 text-muted-foreground">
              Loading members...
            </div>
          ) : (
            <>
              {/* Current Members */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground">Current Members</h4>
                {members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members yet</p>
                ) : (
                  <div className="space-y-1">
                    {members.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between py-2 px-3 rounded-md bg-accent/50"
                      >
                        <span className="text-sm text-foreground">{member.username}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveMember(member.id)}
                          disabled={isUpdating || members.length === 1}
                          title={members.length === 1 ? "Cannot remove last member" : "Remove member"}
                          className="text-destructive hover:text-destructive h-7"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Member */}
              {nonMembers.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground">Add Member</h4>
                  <div className="flex flex-wrap gap-2">
                    {nonMembers.map((user) => (
                      <Button
                        key={user.id}
                        variant="outline"
                        size="sm"
                        onClick={() => handleAddMember(user.id)}
                        disabled={isUpdating}
                        className="h-8"
                      >
                        <UserPlus className="h-3.5 w-3.5 mr-1" />
                        {user.username}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ProjectMembersEditor;
