import { useEffect, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';

import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { AppSettingsProvider } from './contexts/AppSettingsContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { TaskContextProvider } from './contexts/TaskContext';
import { ToastProvider } from './contexts/ToastContext';
import { ClaudeAuthProvider } from './contexts/ClaudeAuthContext';
import { ConnectedProvidersProvider } from './contexts/ConnectedProvidersContext';
import ProtectedRoute from './components/ProtectedRoute';

import {
  DashboardPage,
  BoardPage,
  TaskDetailPage,
  TaskShowPage,
  ChatPage,
  ProjectEditPageWrapper,
  TaskEditPageWrapper,
  AdminPage,
} from './pages';

interface AppWrapperProps {
  children: ReactNode;
}

function AppWrapper({ children }: AppWrapperProps) {
  useEffect(() => {
    const checkPWA = () => {
      const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                          navigatorWithStandalone.standalone === true ||
                          document.referrer.includes('android-app://');

      if (isStandalone) {
        document.documentElement.classList.add('pwa-mode');
        document.body.classList.add('pwa-mode');
      } else {
        document.documentElement.classList.remove('pwa-mode');
        document.body.classList.remove('pwa-mode');
      }
    };

    checkPWA();
    window.matchMedia('(display-mode: standalone)').addEventListener('change', checkPWA);

    return () => {
      window.matchMedia('(display-mode: standalone)').removeEventListener('change', checkPWA);
    };
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="flex-1 flex flex-col min-w-0">
        {children}
      </div>
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppSettingsProvider>
      <AuthProvider>
        <WebSocketProvider>
          <TaskContextProvider>
            <ToastProvider>
              <ProtectedRoute>
                <ClaudeAuthProvider>
                  <ConnectedProvidersProvider>
                  <Router>
                    <AppWrapper>
                      <Routes>
                        {/* Dashboard - home page */}
                        <Route path="/" element={<DashboardPage />} />

                        {/* Board View - Kanban for a project */}
                        <Route path="/projects/:projectId" element={<BoardPage />} />

                        {/* Project Edit */}
                        <Route path="/projects/:projectId/edit" element={<ProjectEditPageWrapper />} />

                        {/* Task Detail */}
                        <Route path="/projects/:projectId/tasks/:taskId" element={<TaskDetailPage />} />

                        {/* Task Show - Full-page markdown documentation view */}
                        <Route path="/projects/:projectId/tasks/:taskId/show" element={<TaskShowPage />} />

                        {/* Task Edit */}
                        <Route path="/projects/:projectId/tasks/:taskId/edit" element={<TaskEditPageWrapper />} />

                        {/* Task Chat */}
                        <Route path="/projects/:projectId/tasks/:taskId/chat/:conversationId" element={<ChatPage />} />

                        {/* Admin Panel (URL-only, no nav link) */}
                        <Route path="/admin" element={<AdminPage />} />

                        {/* Catch-all redirect to dashboard */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </AppWrapper>
                  </Router>
                  </ConnectedProvidersProvider>
                </ClaudeAuthProvider>
              </ProtectedRoute>
            </ToastProvider>
          </TaskContextProvider>
        </WebSocketProvider>
      </AuthProvider>
      </AppSettingsProvider>
    </ThemeProvider>
  );
}

export default App;
