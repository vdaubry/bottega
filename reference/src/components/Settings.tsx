import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { X, Plus, Settings as SettingsIcon, Shield, AlertTriangle, Moon, Sun, User } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import { useAppSettings } from '../contexts/AppSettingsContext';
import { api } from '../utils/api';
import AgentPromptsTab from './AgentPromptsTab';
import AgentModelsTab from './AgentModelsTab';
import ApiKeyPanel from './ApiKeyPanel';
import CodexAuthPanel from './CodexAuthPanel';
import ClaudeAuthPanel from './ClaudeAuthPanel';
import OpenCodeAuthPanel from './OpenCodeAuthPanel';
import type { ProjectRow } from '../../shared/types/db';
import type { ApiError } from '../../shared/api/_common';

export type SettingsTab = 'tools' | 'appearance' | 'prompts' | 'agentModels' | 'account' | 'providers';
type SaveStatus = 'success' | 'error' | null;

export interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  projects?: ProjectRow[];
  initialTab?: SettingsTab;
}

function Settings({
  isOpen,
  onClose,
  projects = [],
  initialTab = 'tools',
}: SettingsProps) {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const { user, updateProfile } = useAuth();
  const { internalToolName, githubPrTrigger, refresh: refreshAppSettings } = useAppSettings();
  const [isTechnical, setIsTechnical] = useState(true);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [toolNameDraft, setToolNameDraft] = useState(internalToolName);
  const [triggerDraft, setTriggerDraft] = useState(githubPrTrigger);
  const [isSavingAppSettings, setIsSavingAppSettings] = useState(false);
  const [appSettingsError, setAppSettingsError] = useState<string | null>(null);
  const [appSettingsStatus, setAppSettingsStatus] = useState<SaveStatus>(null);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [disallowedTools, setDisallowedTools] = useState<string[]>([]);
  const [newAllowedTool, setNewAllowedTool] = useState('');
  const [newDisallowedTool, setNewDisallowedTool] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);
  const [projectSortOrder, setProjectSortOrder] = useState('name');
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  void projects;

  // Code Editor settings
  const [codeEditorTheme, setCodeEditorTheme] = useState(() =>
    localStorage.getItem('codeEditorTheme') || 'dark'
  );
  const [codeEditorWordWrap, setCodeEditorWordWrap] = useState(() =>
    localStorage.getItem('codeEditorWordWrap') === 'true'
  );
  const [codeEditorShowMinimap, setCodeEditorShowMinimap] = useState(() =>
    localStorage.getItem('codeEditorShowMinimap') !== 'false' // Default true
  );
  const [codeEditorLineNumbers, setCodeEditorLineNumbers] = useState(() =>
    localStorage.getItem('codeEditorLineNumbers') !== 'false' // Default true
  );
  const [codeEditorFontSize, setCodeEditorFontSize] = useState(() =>
    localStorage.getItem('codeEditorFontSize') || '14'
  );

  // Common tool patterns for Claude
  const commonTools = [
    'Write',
    'Read',
    'Edit',
    'Glob',
    'Grep',
    'MultiEdit',
    'Task',
    'TodoWrite',
    'TodoRead',
    'WebFetch',
    'WebSearch'
  ];

  useEffect(() => {
    if (isOpen) {
      void loadSettings();
      setActiveTab(initialTab);
      setProfileError(null);
    }
     
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (user) {
      setIsTechnical(user.is_technical !== 0);
    }
  }, [user?.is_technical]);

  // Reset draft fields when the modal opens or the global values change.
  useEffect(() => {
    if (isOpen) {
      setToolNameDraft(internalToolName);
      setTriggerDraft(githubPrTrigger);
      setAppSettingsError(null);
      setAppSettingsStatus(null);
    }
  }, [isOpen, internalToolName, githubPrTrigger]);

  const isAdmin = user?.is_admin === 1;
  const appSettingsDirty =
    toolNameDraft.trim() !== internalToolName ||
    triggerDraft.trim().replace(/^@+/, '').toLowerCase() !== githubPrTrigger;

  const handleSaveAppSettings = async () => {
    setAppSettingsError(null);
    setAppSettingsStatus(null);
    setIsSavingAppSettings(true);
    try {
      const payload = {
        internal_tool_name: toolNameDraft.trim(),
        github_pr_trigger: triggerDraft.trim().replace(/^@+/, '').toLowerCase()
      };
      const res = await api.appSettings.update(payload);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiError;
        throw new Error(body.error || `Save failed: ${res.status}`);
      }
      await refreshAppSettings();
      setAppSettingsStatus('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      setAppSettingsError(message);
      setAppSettingsStatus('error');
    } finally {
      setIsSavingAppSettings(false);
    }
  };

  const handleToggleIsTechnical = async () => {
    const next = !isTechnical;
    setIsTechnical(next);
    setProfileError(null);
    setIsUpdatingProfile(true);
    const result = await updateProfile({ isTechnical: next });
    if (!result?.success) {
      setIsTechnical(!next);
      setProfileError(result?.error || 'Failed to update profile');
    }
    setIsUpdatingProfile(false);
  };

  // Persist code editor settings to localStorage
  useEffect(() => {
    localStorage.setItem('codeEditorTheme', codeEditorTheme);
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorTheme]);

  useEffect(() => {
    localStorage.setItem('codeEditorWordWrap', codeEditorWordWrap.toString());
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorWordWrap]);

  useEffect(() => {
    localStorage.setItem('codeEditorShowMinimap', codeEditorShowMinimap.toString());
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorShowMinimap]);

  useEffect(() => {
    localStorage.setItem('codeEditorLineNumbers', codeEditorLineNumbers.toString());
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorLineNumbers]);

  useEffect(() => {
    localStorage.setItem('codeEditorFontSize', codeEditorFontSize);
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorFontSize]);

  const loadSettings = async () => {
    try {
      
      // Load Claude settings from localStorage
      const savedSettings = localStorage.getItem('claude-settings');
      
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        setAllowedTools(settings.allowedTools || []);
        setDisallowedTools(settings.disallowedTools || []);
        setSkipPermissions(settings.skipPermissions || false);
        setProjectSortOrder(settings.projectSortOrder || 'name');
      } else {
        // Set defaults
        setAllowedTools([]);
        setDisallowedTools([]);
        setSkipPermissions(false);
        setProjectSortOrder('name');
      }

    } catch (error) {
      console.error('Error loading tool settings:', error);
      setAllowedTools([]);
      setDisallowedTools([]);
      setSkipPermissions(false);
      setProjectSortOrder('name');
    }
  };

  const saveSettings = () => {
    setIsSaving(true);
    setSaveStatus(null);
    
    try {
      // Save Claude settings
      const claudeSettings = {
        allowedTools,
        disallowedTools,
        skipPermissions,
        projectSortOrder,
        lastUpdated: new Date().toISOString()
      };

      // Save to localStorage
      localStorage.setItem('claude-settings', JSON.stringify(claudeSettings));

      setSaveStatus('success');
      
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (error) {
      console.error('Error saving tool settings:', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  const addAllowedTool = (tool: string) => {
    if (tool && !allowedTools.includes(tool)) {
      setAllowedTools([...allowedTools, tool]);
      setNewAllowedTool('');
    }
  };

  const removeAllowedTool = (tool: string) => {
    setAllowedTools(allowedTools.filter((t) => t !== tool));
  };

  const addDisallowedTool = (tool: string) => {
    if (tool && !disallowedTools.includes(tool)) {
      setDisallowedTools([...disallowedTools, tool]);
      setNewDisallowedTool('');
    }
  };

  const removeDisallowedTool = (tool: string) => {
    setDisallowedTools(disallowedTools.filter((t) => t !== tool));
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop fixed inset-0 flex items-center justify-center z-[9999] md:p-4 bg-background/95">
      <div className="bg-background border border-border md:rounded-lg shadow-xl w-full md:max-w-4xl h-full md:h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 md:p-6 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <SettingsIcon className="w-5 h-5 md:w-6 md:h-6 text-blue-600" />
            <h2 className="text-lg md:text-xl font-semibold text-foreground">
              Settings
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground touch-manipulation"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Tab Navigation */}
          <div className="border-b border-border">
            <div className="flex px-4 md:px-6">
              <button
                onClick={() => setActiveTab('tools')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'tools'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Tools
              </button>
              <button
                onClick={() => setActiveTab('appearance')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'appearance'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Appearance
              </button>
              <button
                onClick={() => setActiveTab('prompts')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'prompts'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Agent Prompts
              </button>
              <button
                onClick={() => setActiveTab('agentModels')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'agentModels'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                data-testid="settings-tab-agent-models"
              >
                Agent Models
              </button>
              <button
                onClick={() => setActiveTab('account')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'account'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Account
              </button>
              <button
                onClick={() => setActiveTab('providers')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'providers'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                data-testid="settings-tab-providers"
              >
                Providers
              </button>
            </div>
          </div>

          <div className="p-4 md:p-6 space-y-6 md:space-y-8 pb-safe-area-inset-bottom">
            
            {/* Appearance Tab */}
            {activeTab === 'appearance' && (
              <div className="space-y-6 md:space-y-8">
               {activeTab === 'appearance' && (
  <div className="space-y-6 md:space-y-8">
    {/* Branding (instance-wide) */}
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-foreground">Branding</h3>
      <p className="text-sm text-muted-foreground">
        Instance-wide values shown to every user. {isAdmin ? null : 'Admin access required to edit.'}
      </p>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
        <div className="space-y-2">
          <label htmlFor="internal-tool-name" className="block font-medium text-foreground">
            Internal Tool Name
          </label>
          <p className="text-sm text-muted-foreground">
            Displayed as the title on the dashboard and login screen. Use your company's
            internal name for this orchestration tool (defaults to "Bottega").
          </p>
          <Input
            id="internal-tool-name"
            value={toolNameDraft}
            onChange={(e) => setToolNameDraft(e.target.value)}
            placeholder="Bottega"
            disabled={!isAdmin || isSavingAppSettings}
            maxLength={100}
            className="h-10"
            style={{ fontSize: '16px' }}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="github-pr-trigger" className="block font-medium text-foreground">
            GitHub PR comment trigger
          </label>
          <p className="text-sm text-muted-foreground">
            The handle to mention in PR comments to trigger the PR agent
            (currently <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">@{githubPrTrigger}</code>).
            Letters, digits, hyphens or underscores only.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">@</span>
            <Input
              id="github-pr-trigger"
              value={triggerDraft}
              onChange={(e) => setTriggerDraft(e.target.value)}
              placeholder="bottega"
              disabled={!isAdmin || isSavingAppSettings}
              maxLength={100}
              className="h-10 flex-1"
              style={{ fontSize: '16px' }}
            />
          </div>
        </div>

        {appSettingsError && (
          <div className="text-sm text-red-600 dark:text-red-400">
            {appSettingsError}
          </div>
        )}
        {appSettingsStatus === 'success' && (
          <div className="text-sm text-green-600 dark:text-green-400">
            Saved.
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={handleSaveAppSettings}
            disabled={!isAdmin || isSavingAppSettings || !appSettingsDirty}
            className="h-10"
          >
            {isSavingAppSettings ? 'Saving...' : 'Save branding'}
          </Button>
        </div>
      </div>
    </div>

    {/* Theme Settings */}
    <div className="space-y-4">
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Dark Mode
            </div>
            <div className="text-sm text-muted-foreground">
              Toggle between light and dark themes
            </div>
          </div>
          <button
            onClick={toggleDarkMode}
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              isDarkMode
                ? 'bg-blue-600 dark:bg-blue-500'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
            role="switch"
            aria-checked={isDarkMode}
            aria-label="Toggle dark mode"
          >
            <span className="sr-only">Toggle dark mode</span>
            <span
              className={`${
                isDarkMode ? 'translate-x-7' : 'translate-x-1'
              } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200 flex items-center justify-center`}
            >
              {isDarkMode ? (
                <Moon className="w-3.5 h-3.5 text-gray-700" />
              ) : (
                <Sun className="w-3.5 h-3.5 text-yellow-500" />
              )}
            </span>
          </button>
        </div>
      </div>
    </div>

    {/* Project Sorting */}
    <div className="space-y-4">
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Project Sorting
            </div>
            <div className="text-sm text-muted-foreground">
              How projects are ordered in the sidebar
            </div>
          </div>
          <select
            value={projectSortOrder}
            onChange={(e) => setProjectSortOrder(e.target.value)}
            className="text-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 w-32"
          >
            <option value="name">Alphabetical</option>
            <option value="date">Recent Activity</option>
          </select>
        </div>
      </div>
    </div>

    {/* Code Editor Settings */}
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-foreground">Code Editor</h3>

      {/* Editor Theme */}
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Editor Theme
            </div>
            <div className="text-sm text-muted-foreground">
              Default theme for the code editor
            </div>
          </div>
          <button
            onClick={() => setCodeEditorTheme(codeEditorTheme === 'dark' ? 'light' : 'dark')}
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              codeEditorTheme === 'dark'
                ? 'bg-blue-600 dark:bg-blue-500'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
            role="switch"
            aria-checked={codeEditorTheme === 'dark'}
            aria-label="Toggle editor theme"
          >
            <span className="sr-only">Toggle editor theme</span>
            <span
              className={`${
                codeEditorTheme === 'dark' ? 'translate-x-7' : 'translate-x-1'
              } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200 flex items-center justify-center`}
            >
              {codeEditorTheme === 'dark' ? (
                <Moon className="w-3.5 h-3.5 text-gray-700" />
              ) : (
                <Sun className="w-3.5 h-3.5 text-yellow-500" />
              )}
            </span>
          </button>
        </div>
      </div>

      {/* Word Wrap */}
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Word Wrap
            </div>
            <div className="text-sm text-muted-foreground">
              Enable word wrapping by default in the editor
            </div>
          </div>
          <button
            onClick={() => setCodeEditorWordWrap(!codeEditorWordWrap)}
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              codeEditorWordWrap
                ? 'bg-blue-600 dark:bg-blue-500'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
            role="switch"
            aria-checked={codeEditorWordWrap}
            aria-label="Toggle word wrap"
          >
            <span className="sr-only">Toggle word wrap</span>
            <span
              className={`${
                codeEditorWordWrap ? 'translate-x-7' : 'translate-x-1'
              } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200`}
            />
          </button>
        </div>
      </div>

      {/* Show Minimap */}
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Show Minimap
            </div>
            <div className="text-sm text-muted-foreground">
              Display a minimap for easier navigation in diff view
            </div>
          </div>
          <button
            onClick={() => setCodeEditorShowMinimap(!codeEditorShowMinimap)}
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              codeEditorShowMinimap
                ? 'bg-blue-600 dark:bg-blue-500'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
            role="switch"
            aria-checked={codeEditorShowMinimap}
            aria-label="Toggle minimap"
          >
            <span className="sr-only">Toggle minimap</span>
            <span
              className={`${
                codeEditorShowMinimap ? 'translate-x-7' : 'translate-x-1'
              } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200`}
            />
          </button>
        </div>
      </div>

      {/* Show Line Numbers */}
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Show Line Numbers
            </div>
            <div className="text-sm text-muted-foreground">
              Display line numbers in the editor
            </div>
          </div>
          <button
            onClick={() => setCodeEditorLineNumbers(!codeEditorLineNumbers)}
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
              codeEditorLineNumbers
                ? 'bg-blue-600 dark:bg-blue-500'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
            role="switch"
            aria-checked={codeEditorLineNumbers}
            aria-label="Toggle line numbers"
          >
            <span className="sr-only">Toggle line numbers</span>
            <span
              className={`${
                codeEditorLineNumbers ? 'translate-x-7' : 'translate-x-1'
              } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200`}
            />
          </button>
        </div>
      </div>

      {/* Font Size */}
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-foreground">
              Font Size
            </div>
            <div className="text-sm text-muted-foreground">
              Editor font size in pixels
            </div>
          </div>
          <select
            value={codeEditorFontSize}
            onChange={(e) => setCodeEditorFontSize(e.target.value)}
            className="text-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 w-24"
          >
            <option value="10">10px</option>
            <option value="11">11px</option>
            <option value="12">12px</option>
            <option value="13">13px</option>
            <option value="14">14px</option>
            <option value="15">15px</option>
            <option value="16">16px</option>
            <option value="18">18px</option>
            <option value="20">20px</option>
          </select>
        </div>
      </div>
    </div>
  </div>
)}

              </div>
            )}

            {/* Agent Prompts Tab */}
            {activeTab === 'prompts' && (
              <div className="min-h-[500px]">
                <AgentPromptsTab />
              </div>
            )}

            {/* Agent Models Tab — per-user provider/model/effort per agent. */}
            {activeTab === 'agentModels' && (
              <div className="min-h-[500px]">
                <AgentModelsTab />
              </div>
            )}

            {/* Providers Tab — Claude (Anthropic) + Codex (OpenAI) +
                OpenCode (Zen) at the same level. Same panels render
                inside the picker modal. */}
            {activeTab === 'providers' && (
              <div className="space-y-8">
                <ClaudeAuthPanel />
                <div className="border-t border-border" />
                <CodexAuthPanel />
                <div className="border-t border-border" />
                <OpenCodeAuthPanel />
              </div>
            )}

            {/* Account Tab */}
            {activeTab === 'account' && (
              <div className="space-y-6 md:space-y-8">
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <User className="w-5 h-5 text-blue-500" />
                    <h3 className="text-lg font-medium text-foreground">
                      Profile
                    </h3>
                  </div>

                  <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-foreground">
                          I'm a technical user
                        </div>
                        <div className="text-sm text-muted-foreground">
                          When off, the planification agent asks only product/UX
                          questions, picks the technical approach (and tests)
                          itself, and starts implementation as soon as the plan
                          is ready — no manual review step.
                        </div>
                      </div>
                      <button
                        onClick={handleToggleIsTechnical}
                        disabled={isUpdatingProfile || !user}
                        className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 ${
                          isTechnical
                            ? 'bg-blue-600 dark:bg-blue-500'
                            : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                        role="switch"
                        aria-checked={isTechnical}
                        aria-label="Toggle technical user mode"
                      >
                        <span className="sr-only">Toggle technical user mode</span>
                        <span
                          className={`${
                            isTechnical ? 'translate-x-7' : 'translate-x-1'
                          } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200`}
                        />
                      </button>
                    </div>
                    {profileError && (
                      <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                        {profileError}
                      </div>
                    )}
                  </div>
                </div>

                <ApiKeyPanel />
              </div>
            )}

            {/* Tools Tab */}
            {activeTab === 'tools' && (
              <div className="space-y-6 md:space-y-8">

            {/* Skip Permissions */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                <h3 className="text-lg font-medium text-foreground">
                  Permission Settings
                </h3>
              </div>
              <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={skipPermissions}
                    onChange={(e) => setSkipPermissions(e.target.checked)}
                    className="w-4 h-4 text-blue-600 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500 focus:ring-2 checked:bg-blue-600 dark:checked:bg-blue-600"
                  />
                  <div>
                    <div className="font-medium text-orange-900 dark:text-orange-100">
                      Skip permission prompts (use with caution)
                    </div>
                    <div className="text-sm text-orange-700 dark:text-orange-300">
                      Equivalent to --dangerously-skip-permissions flag
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Allowed Tools */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-green-500" />
                <h3 className="text-lg font-medium text-foreground">
                  Allowed Tools
                </h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Tools that are automatically allowed without prompting for permission
              </p>
              
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  value={newAllowedTool}
                  onChange={(e) => setNewAllowedTool(e.target.value)}
                  placeholder='e.g., "Bash(git log:*)" or "Write"'
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      addAllowedTool(newAllowedTool);
                    }
                  }}
                  className="flex-1 h-10 touch-manipulation"
                  style={{ fontSize: '16px' }}
                />
                <Button
                  onClick={() => addAllowedTool(newAllowedTool)}
                  disabled={!newAllowedTool}
                  size="sm"
                  className="h-10 px-4 touch-manipulation"
                >
                  <Plus className="w-4 h-4 mr-2 sm:mr-0" />
                  <span className="sm:hidden">Add Tool</span>
                </Button>
              </div>

              {/* Common tools quick add */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Quick add common tools:
                </p>
                <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                  {commonTools.map(tool => (
                    <Button
                      key={tool}
                      variant="outline"
                      size="sm"
                      onClick={() => addAllowedTool(tool)}
                      disabled={allowedTools.includes(tool)}
                      className="text-xs h-8 touch-manipulation truncate"
                    >
                      {tool}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                {allowedTools.map(tool => (
                  <div key={tool} className="flex items-center justify-between bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3">
                    <span className="font-mono text-sm text-green-800 dark:text-green-200">
                      {tool}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeAllowedTool(tool)}
                      className="text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                {allowedTools.length === 0 && (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    No allowed tools configured
                  </div>
                )}
              </div>
            </div>

            {/* Disallowed Tools */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500" />
                <h3 className="text-lg font-medium text-foreground">
                  Disallowed Tools
                </h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Tools that are automatically blocked without prompting for permission
              </p>
              
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  value={newDisallowedTool}
                  onChange={(e) => setNewDisallowedTool(e.target.value)}
                  placeholder='e.g., "Bash(rm:*)" or "Write"'
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      addDisallowedTool(newDisallowedTool);
                    }
                  }}
                  className="flex-1 h-10 touch-manipulation"
                  style={{ fontSize: '16px' }}
                />
                <Button
                  onClick={() => addDisallowedTool(newDisallowedTool)}
                  disabled={!newDisallowedTool}
                  size="sm"
                  className="h-10 px-4 touch-manipulation"
                >
                  <Plus className="w-4 h-4 mr-2 sm:mr-0" />
                  <span className="sm:hidden">Add Tool</span>
                </Button>
              </div>

              <div className="space-y-2">
                {disallowedTools.map(tool => (
                  <div key={tool} className="flex items-center justify-between bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                    <span className="font-mono text-sm text-red-800 dark:text-red-200">
                      {tool}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeDisallowedTool(tool)}
                      className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                {disallowedTools.length === 0 && (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    No disallowed tools configured
                  </div>
                )}
              </div>
            </div>

            {/* Help Section */}
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <h4 className="font-medium text-blue-900 dark:text-blue-100 mb-2">
                Tool Pattern Examples:
              </h4>
              <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1">
                <li><code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">"Bash(git log:*)"</code> - Allow all git log commands</li>
                <li><code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">"Bash(git diff:*)"</code> - Allow all git diff commands</li>
                <li><code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">"Write"</code> - Allow all Write tool usage</li>
                <li><code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">"Read"</code> - Allow all Read tool usage</li>
                <li><code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">"Bash(rm:*)"</code> - Block all rm commands (dangerous)</li>
              </ul>
            </div>

              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-4 md:p-6 border-t border-border flex-shrink-0 gap-3 pb-safe-area-inset-bottom">
          <div className="flex items-center justify-center sm:justify-start gap-2 order-2 sm:order-1">
            {saveStatus === 'success' && (
              <div className="text-green-600 dark:text-green-400 text-sm flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Settings saved successfully!
              </div>
            )}
            {saveStatus === 'error' && (
              <div className="text-red-600 dark:text-red-400 text-sm flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Failed to save settings
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 order-1 sm:order-2">
            <Button 
              variant="outline" 
              onClick={onClose} 
              disabled={isSaving}
              className="flex-1 sm:flex-none h-10 touch-manipulation"
            >
              Cancel
            </Button>
            <Button 
              onClick={saveSettings} 
              disabled={isSaving}
              className="flex-1 sm:flex-none h-10 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 touch-manipulation"
            >
              {isSaving ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Saving...
                </div>
              ) : (
                'Save Settings'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
