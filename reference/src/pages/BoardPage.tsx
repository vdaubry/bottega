/**
 * BoardPage.tsx - Board View Page Wrapper
 *
 * Loads project and tasks data from URL params.
 * Renders the BoardView component.
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import BoardView from '../components/Dashboard/BoardView';
import { useTaskContext } from '../contexts/TaskContext';
import type { ProjectRow } from '../../shared/types/db';

function BoardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const {
    projects,
    loadProjects,
    loadTasks,
    isLoadingProjects,
  } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load project and tasks when projectId changes
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        // If projects not loaded yet, load them
        if (projects.length === 0 && !isLoadingProjects) {
          await loadProjects();
        }
      } finally {
        setIsLoading(false);
      }
    };

    void loadData();
  }, [projectId, loadProjects, projects.length, isLoadingProjects]);

  // Find project once projects are loaded
  useEffect(() => {
    if (projects.length > 0 && projectId) {
      const foundProject = projects.find((p) => p.id === parseInt(projectId, 10));
      if (foundProject) {
        setProject(foundProject);
        void loadTasks(foundProject.id);
      } else {
        // Project not found, redirect to dashboard
        navigate(`/`, { replace: true });
      }
    }
  }, [projects, projectId, loadTasks, navigate]);

  // Loading state
  if (isLoading || isLoadingProjects || !project) {
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

  return <BoardView project={project} />;
}

export default BoardPage;
