/**
 * EpicNewPage — the create form: a name plus the functional-specification
 * files. Route: /projects/:projectId/epics/new.
 *
 * Creating an epic starts NO agent — it creates the row and archives the
 * uploaded spec, then lands on the epic's page where the pipeline's first
 * stage (architecture) is started deliberately. The list of existing epics
 * lives on the board's Epics tab (`EpicsPanel`).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, Plus, X } from 'lucide-react';
import Breadcrumb from '../components/Breadcrumb';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useTaskContext } from '../contexts/TaskContext';
import { api } from '../utils/api';
import { ALLOWED_SPEC_EXTENSIONS, EPIC_NAME_MAX } from '@shared/schemas/epics';
import type { ProjectRow } from '@shared/types/db';

const ACCEPT_ATTR = ALLOWED_SPEC_EXTENSIONS.join(',');

function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_SPEC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function EpicNewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { projects, loadProjects, isLoadingProjects } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (projects.length === 0 && !isLoadingProjects) {
      void loadProjects();
    }
  }, [projects.length, isLoadingProjects, loadProjects]);

  useEffect(() => {
    if (projects.length > 0 && projectId) {
      const found = projects.find((p) => p.id === parseInt(projectId, 10));
      if (found) {
        setProject(found);
      } else {
        navigate('/', { replace: true });
      }
    }
  }, [projects, projectId, navigate]);

  const handleFilesPicked = (picked: FileList | null) => {
    // Snapshot immediately: a FileList is LIVE, and the onChange handler
    // clears input.value right after this call — by the time React runs the
    // state updater the list would already be empty.
    const incoming = picked ? [...picked] : [];
    if (incoming.length === 0) return;
    const rejected = incoming.filter((f) => !hasAllowedExtension(f.name));
    if (rejected.length > 0) {
      setError(
        `Unsupported file type: ${rejected.map((f) => f.name).join(', ')} — allowed: ${ALLOWED_SPEC_EXTENSIONS.join(', ')}`,
      );
      return;
    }
    setError(null);
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...incoming.filter((f) => !existing.has(f.name))];
    });
  };

  const handleCreate = async () => {
    if (!project || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      files.forEach((file) => formData.append('files', file));
      const response = await api.epics.create(project.id, formData);
      if (response.ok) {
        const epic = await response.json();
        navigate(`/projects/${project.id}/epics/${epic.id}`);
      } else {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to create the epic (HTTP ${response.status})`);
      }
    } catch {
      setError('Failed to create the epic');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading project...</p>
        </div>
      </div>
    );
  }

  const canSubmit = name.trim().length > 0 && files.length > 0 && !isSubmitting;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4 md:p-6">
        <Breadcrumb
          project={project}
          onHomeClick={() => navigate('/')}
          onProjectClick={() => navigate(`/projects/${project.id}`)}
          className="mb-4"
        />

        <div className="mb-6 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/projects/${project.id}/epics`)}
            className="h-8 w-8 p-0"
            title="Back to epics"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">New epic</h1>
            <p className="text-sm text-muted-foreground">
              Upload the functional spec, then take the epic through architecture,
              technical specification and stories.
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border bg-card p-4">
          <label htmlFor="epic-name" className="mb-1 block text-sm font-medium">
            Epic name
          </label>
          <Input
            id="epic-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Company Quests"
            maxLength={EPIC_NAME_MAX}
            autoFocus
            className="mb-4"
          />

          <p className="mb-1 text-sm font-medium">Spec files</p>
          <p className="mb-2 text-xs text-muted-foreground">
            {ALLOWED_SPEC_EXTENSIONS.join(' / ')} — archived outside the repo; the epic
            agents read them from there.
          </p>

          {files.length > 0 ? (
            <ul className="mb-2 space-y-1">
              {files.map((file) => (
                <li
                  key={file.name}
                  className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-sm"
                >
                  <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((f) => f.name !== file.name))}
                    className="text-muted-foreground hover:text-foreground"
                    title={`Remove ${file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              handleFilesPicked(e.target.files);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add spec files
          </Button>

          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

          <div className="mt-4 flex justify-end">
            <Button onClick={() => void handleCreate()} disabled={!canSubmit}>
              <Plus className="mr-1.5 h-4 w-4" />
              {isSubmitting ? 'Creating…' : 'Create epic'}
            </Button>
          </div>
        </div>

      </div>
    </div>
  );
}

export default EpicNewPage;
