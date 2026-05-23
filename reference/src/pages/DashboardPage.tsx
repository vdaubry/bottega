/**
 * DashboardPage.tsx - Dashboard Page Wrapper
 *
 * Wraps the Dashboard component for route-based navigation.
 * Handles settings and project form modals.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dashboard } from '../components/Dashboard';
import Settings, { type SettingsTab } from '../components/Settings';
import ProjectForm from '../components/ProjectForm';
import { useTaskContext } from '../contexts/TaskContext';
import type { ProjectRow, TaskRow } from '../../shared/types/db';

interface ProjectSubmitPayload {
  name: string;
  repoFolderPath: string;
}

interface ActionResult {
  success: boolean;
  error?: string;
}

function DashboardPage() {
  const navigate = useNavigate();
  const { createProject } = useTaskContext();

  // UI state
  const [isMobile, setIsMobile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('tools');

  // Project form modal state (create only)
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Expose openSettings function globally for component access. The window
  // global is typed with `tab?: string` (vite-env.d.ts) since it's reachable
  // from untyped call sites; narrow back to SettingsTab here.
  window.openSettings = useCallback((tab: string = 'tools') => {
    setSettingsInitialTab(tab as SettingsTab);
    setShowSettings(true);
  }, []);

  // Handle project creation from modal
  const handleProjectSubmit = async ({
    name,
    repoFolderPath,
  }: ProjectSubmitPayload): Promise<ActionResult> => {
    setIsCreatingProject(true);
    try {
      const result = await createProject(name, repoFolderPath);
      if (result.success) {
        setShowProjectForm(false);
      }
      return result;
    } finally {
      setIsCreatingProject(false);
    }
  };

  // Handle opening project edit page (navigate to full edit page)
  const handleEditProject = useCallback(
    (project: ProjectRow) => {
      navigate(`/projects/${project.id}/edit`);
    },
    [navigate]
  );

  // Handle task click from in-progress view - navigate to task detail
  const handleTaskClick = useCallback(
    (task: TaskRow) => {
      navigate(`/projects/${task.project_id}/tasks/${task.id}`);
    },
    [navigate]
  );

  return (
    <>
      <Dashboard
        onShowSettings={() => setShowSettings(true)}
        onShowProjectForm={() => setShowProjectForm(true)}
        onEditProject={handleEditProject}
        onTaskClick={handleTaskClick}
        isMobile={isMobile}
      />

      {/* Settings Modal */}
      <Settings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        projects={[]}
        initialTab={settingsInitialTab}
      />

      {/* Project Form Modal (Create Only) */}
      <ProjectForm
        isOpen={showProjectForm}
        onClose={() => setShowProjectForm(false)}
        onSubmit={handleProjectSubmit}
        isSubmitting={isCreatingProject}
      />
    </>
  );
}

export default DashboardPage;
