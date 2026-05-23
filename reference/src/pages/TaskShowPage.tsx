/**
 * TaskShowPage.tsx - Full-page markdown-rendered task documentation view
 *
 * Displays task title and full documentation rendered as markdown.
 * Provides a larger viewing area for longer descriptions.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ArrowLeft, FileText, Edit2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import Breadcrumb from '../components/Breadcrumb';
import { useTaskContext } from '../contexts/TaskContext';
import type { ProjectRow, TaskRow } from '../../shared/types/db';

// Reuse the same markdown components as MarkdownEditor for consistency
const markdownComponents: Components = {
  code: ({ className, children, ...props }) => {
    const hasLanguage = className?.startsWith('language-');
    // react-markdown delivers code-block children as a string (or string[])
    const codeString = (Array.isArray(children) ? children.join('') : children as string ?? '').replace(/\n$/, '');
    const isMultiline = codeString.includes('\n');
    const isBlock = hasLanguage || isMultiline;

    if (isBlock) {
      return (
        <pre className="bg-muted text-foreground rounded-md p-4 overflow-x-auto my-2 text-sm">
          <code className={`${className || ''} text-foreground`.trim()}>{children}</code>
        </pre>
      );
    }

    return (
      <code className="bg-muted text-foreground px-1 py-0.5 rounded text-sm" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  h1: ({ children }) => <h1 className="text-2xl font-bold mt-6 mb-3">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-semibold mt-6 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc ml-4">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-4">{children}</ol>,
  a: ({ href, children }) => (
    <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-border pl-4 italic my-3">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full border-collapse border border-border text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  th: ({ children }) => <th className="border border-border px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-3 py-2">{children}</td>,
};

const remarkPlugins = [remarkGfm, remarkBreaks];

function TaskShowPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const navigate = useNavigate();
  const {
    projects,
    tasks,
    taskDoc,
    isLoadingTaskDoc,
    loadProjects,
    loadTasks,
    loadTaskDoc,
    isLoadingProjects,
  } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load project data
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        if (projects.length === 0 && !isLoadingProjects) {
          await loadProjects();
        }
      } finally {
        setIsLoading(false);
      }
    };
    void loadData();
  }, [projectId, loadProjects, projects.length, isLoadingProjects]);

  // Find project and load tasks
  useEffect(() => {
    if (projects.length > 0 && projectId) {
      const foundProject = projects.find(p => p.id === parseInt(projectId, 10));
      if (foundProject) {
        setProject(foundProject);
        void loadTasks(foundProject.id);
      } else {
        navigate(`/`, { replace: true });
      }
    }
  }, [projects, projectId, loadTasks, navigate]);

  // Find task and load documentation
  useEffect(() => {
    if (tasks.length > 0 && project && taskId) {
      const foundTask = tasks.find(t => t.id === parseInt(taskId, 10));
      if (foundTask) {
        setTask(foundTask);
        void loadTaskDoc(foundTask.id);
      } else {
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }
  }, [tasks, taskId, project, projectId, loadTaskDoc, navigate]);

  // Navigation handlers
  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/tasks/${taskId}`);
  }, [navigate, projectId, taskId]);

  const handleProjectClick = useCallback(() => {
    navigate(`/projects/${projectId}`);
  }, [navigate, projectId]);

  const handleHomeClick = useCallback(() => {
    navigate(`/`);
  }, [navigate]);

  const handleEdit = useCallback(() => {
    navigate(`/projects/${projectId}/tasks/${taskId}/edit`);
  }, [navigate, projectId, taskId]);

  // Loading state
  if (isLoading || isLoadingProjects || !project || !task) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading task...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="h-8 w-8 p-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Breadcrumb
            project={project}
            task={task}
            onProjectClick={handleProjectClick}
            onHomeClick={handleHomeClick}
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-blue-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-foreground">
              {task.title || `Task ${task.id}`}
            </h1>
            <p className="text-sm text-muted-foreground">
              Task #{task.id} in {project?.name || 'Unknown Project'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleEdit}>
            <Edit2 className="w-4 h-4 mr-1" />
            Edit
          </Button>
        </div>
      </div>

      {/* Documentation content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-6 sm:p-8">
          {isLoadingTaskDoc ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-muted rounded w-3/4" />
              <div className="h-4 bg-muted rounded w-1/2" />
              <div className="h-4 bg-muted rounded w-5/6" />
              <div className="h-4 bg-muted rounded w-2/3" />
              <div className="h-4 bg-muted rounded w-4/5" />
            </div>
          ) : taskDoc ? (
            <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                {taskDoc}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-16">
              <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg">No documentation yet</p>
              <p className="text-sm mt-1">Click Edit to add task documentation.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default TaskShowPage;
