import { Suspense, lazy, useEffect, type ReactNode } from 'react';
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

// Pages are loaded lazily, and that is load-bearing rather than cosmetic.
// Every route below sits *inside* <ProtectedRoute>, so a signed-out visitor
// never renders any of them — but a static import is resolved at module load,
// long before that check runs. Importing them eagerly therefore pulled the
// whole application (and its heaviest dependencies, e.g. the ~1.5 MB markdown
// editor behind TaskEditPageWrapper) into the module graph needed to draw the
// login form. Keep these as lazy() so the sign-in path stays small.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const BoardPage = lazy(() => import('./pages/BoardPage'));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'));
const TaskShowPage = lazy(() => import('./pages/TaskShowPage'));
const TaskIdePage = lazy(() => import('./pages/TaskIdePage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const ProjectEditPageWrapper = lazy(() => import('./pages/ProjectEditPageWrapper'));
const TaskEditPageWrapper = lazy(() => import('./pages/TaskEditPageWrapper'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const EpicNewPage = lazy(() => import('./pages/EpicNewPage'));
const EpicDetailPage = lazy(() => import('./pages/EpicDetailPage'));
const EpicChatPage = lazy(() => import('./pages/EpicChatPage'));

/**
 * Shown while a lazily-loaded route chunk is in flight. Deliberately plain: it
 * is on screen for a fraction of a second on a warm connection, and anything
 * heavier would defeat the point of splitting the routes out.
 */
function RouteFallback() {
  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="flex items-center space-x-2" role="status" aria-label="Loading">
        <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
        <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
        <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
      </div>
    </div>
  );
}

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
                      <Suspense fallback={<RouteFallback />}>
                      <Routes>
                        {/* Dashboard - home page */}
                        <Route path="/" element={<DashboardPage />} />

                        {/* Board View - Kanban for a project */}
                        <Route path="/projects/:projectId" element={<BoardPage />} />

                        {/* Project Edit */}
                        <Route path="/projects/:projectId/edit" element={<ProjectEditPageWrapper />} />

                        {/* Epics — the list is the board's Epics tab, so the
                            collection route renders the board with that tab
                            selected rather than a page of its own. */}
                        <Route
                          path="/projects/:projectId/epics"
                          element={<BoardPage tab="epics" />}
                        />
                        <Route path="/projects/:projectId/epics/new" element={<EpicNewPage />} />
                        <Route path="/projects/:projectId/epics/:epicId" element={<EpicDetailPage />} />
                        <Route
                          path="/projects/:projectId/epics/:epicId/chat/:conversationId"
                          element={<EpicChatPage />}
                        />

                        {/* Task Detail */}
                        <Route path="/projects/:projectId/tasks/:taskId" element={<TaskDetailPage />} />

                        {/* Task Show - Full-page markdown documentation view */}
                        <Route path="/projects/:projectId/tasks/:taskId/show" element={<TaskShowPage />} />

                        {/* Task Explore - Full-screen code-atlas IDE view */}
                        <Route path="/projects/:projectId/tasks/:taskId/ide" element={<TaskIdePage />} />

                        {/* Task Edit */}
                        <Route path="/projects/:projectId/tasks/:taskId/edit" element={<TaskEditPageWrapper />} />

                        {/* Task Chat */}
                        <Route path="/projects/:projectId/tasks/:taskId/chat/:conversationId" element={<ChatPage />} />

                        {/* Admin Panel (URL-only, no nav link) */}
                        <Route path="/admin" element={<AdminPage />} />

                        {/* Catch-all redirect to dashboard */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                      </Suspense>
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
