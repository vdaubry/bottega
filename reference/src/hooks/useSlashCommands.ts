/*
 * useSlashCommands.ts - Hook for slash command functionality
 *
 * Extracts slash command logic for reuse across components.
 * Handles command fetching, filtering, menu state, and selection.
 */

import { useState, useEffect, useMemo, useCallback, type Dispatch, type SetStateAction } from 'react';
import { api } from '../utils/api';
import type { SlashCommand } from '../../shared/api/settings';

export type { SlashCommand };

export interface UseSlashCommandsResult {
  slashCommands: SlashCommand[];
  showCommandMenu: boolean;
  slashPosition: number;
  commandQuery: string;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  handleSlashDetected: (position: number, query: string) => void;
  handleCommandSelect: (
    command: SlashCommand,
    index: number,
    isHover: boolean,
    input: string,
    setInput: Dispatch<SetStateAction<string>>,
  ) => void;
  handleCloseCommandMenu: () => void;
  handleToggleCommandMenu: () => void;
}

export function useSlashCommands(projectPath: string | null | undefined): UseSlashCommandsResult {
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [slashPosition, setSlashPosition] = useState(-1);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);

  // Fetch commands when project changes
  useEffect(() => {
    const fetchCommands = async () => {
      if (!projectPath) return;
      try {
        const response = await api.getCommands(projectPath);
        if (response.ok) {
          const data = await response.json();
          const allCommands: SlashCommand[] = [
            ...(data.builtIn || []),
            ...(data.custom || []),
          ];
          setSlashCommands(allCommands);
        }
      } catch (error) {
        console.error('Error fetching commands:', error);
      }
    };
    void fetchCommands();
  }, [projectPath]);

  // Filter commands based on query
  const filteredCommands = useMemo(() => {
    if (!commandQuery) return slashCommands;
    return slashCommands.filter(cmd =>
      cmd.name.toLowerCase().includes(commandQuery.toLowerCase())
    );
  }, [slashCommands, commandQuery]);

  // Handle slash detection from input
  const handleSlashDetected = useCallback((position: number, query: string) => {
    if (position >= 0) {
      setSlashPosition(position);
      setCommandQuery(query);
      setShowCommandMenu(true);
      setSelectedCommandIndex(-1);
    } else {
      setSlashPosition(-1);
      setCommandQuery('');
      setShowCommandMenu(false);
    }
  }, []);

  // Handle command selection from menu
  const handleCommandSelect = useCallback<UseSlashCommandsResult['handleCommandSelect']>(
    (command, index, isHover, input, setInput) => {
      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }
      // Insert command into input
      const beforeSlash = slashPosition >= 0 ? input.slice(0, slashPosition) : input;
      const afterCursor = slashPosition >= 0 ? input.slice(slashPosition + 1 + commandQuery.length) : '';
      // Ensure command name includes slash but avoid double-slash if it already has one
      const commandText = command.name.startsWith('/') ? command.name : '/' + command.name;
      const newInput = beforeSlash + commandText + ' ' + afterCursor.trim();
      setInput(newInput.trim() + ' ');
      setShowCommandMenu(false);
      setSlashPosition(-1);
      setCommandQuery('');
      setSelectedCommandIndex(-1);
    },
    [slashPosition, commandQuery],
  );

  // Close command menu
  const handleCloseCommandMenu = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
  }, []);

  // Toggle command menu (for button click)
  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    if (isOpening) {
      setCommandQuery('');
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  return {
    slashCommands,
    showCommandMenu,
    slashPosition,
    commandQuery,
    filteredCommands,
    selectedCommandIndex,
    handleSlashDetected,
    handleCommandSelect,
    handleCloseCommandMenu,
    handleToggleCommandMenu,
  };
}
