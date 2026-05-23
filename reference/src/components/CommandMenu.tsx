import { useEffect, useRef, type CSSProperties } from 'react';
import type { SlashCommand } from '../../shared/api/settings';

export type { SlashCommand };

export interface CommandMenuPosition {
  top?: number;
  left?: number;
  /** When provided (mobile path), positions the menu from the bottom of the viewport. */
  bottom?: number;
}

export interface CommandMenuProps {
  commands?: SlashCommand[];
  selectedIndex?: number;
  onSelect?: (
    command: SlashCommand,
    index: number,
    isHover: boolean,
  ) => void;
  onClose: () => void;
  position?: CommandMenuPosition;
  isOpen?: boolean;
  frequentCommands?: SlashCommand[];
}

interface CommandWithIndex extends Omit<SlashCommand, 'namespace'> {
  globalIndex: number;
  namespace: string;
}

const NAMESPACE_LABELS: Record<string, string> = {
  frequent: '⭐ Frequently Used',
  builtin: 'Built-in Commands',
  project: 'Project Commands',
  user: 'User Commands',
  other: 'Other Commands',
};

function CommandMenu({
  commands = [],
  selectedIndex = -1,
  onSelect,
  onClose,
  position = { top: 0, left: 0 },
  isOpen = false,
  frequentCommands = [],
}: CommandMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedItemRef = useRef<HTMLDivElement | null>(null);

  // Calculate responsive positioning
  const getMenuPosition = (): CSSProperties => {
    const isMobile = window.innerWidth < 640;
    const viewportHeight = window.innerHeight;

    if (isMobile) {
      // On mobile, calculate bottom position dynamically to appear above the input
      const inputBottom = position.bottom ?? 90;

      return {
        position: 'fixed',
        bottom: `${inputBottom}px`,
        left: '16px',
        right: '16px',
        width: 'auto',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'min(50vh, 300px)',
      };
    }

    // On desktop, use provided position but ensure it stays on screen
    const top = position.top ?? 0;
    const left = position.left ?? 0;
    return {
      position: 'fixed',
      top: `${Math.max(16, Math.min(top, viewportHeight - 316))}px`,
      left: `${left}px`,
      width: 'min(400px, calc(100vw - 32px))',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: '300px',
    };
  };

  const menuPosition = getMenuPosition();

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target) &&
        isOpen
      ) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
    return undefined;
  }, [isOpen, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedItemRef.current && menuRef.current) {
      const menuRect = menuRef.current.getBoundingClientRect();
      const itemRect = selectedItemRef.current.getBoundingClientRect();

      if (itemRect.bottom > menuRect.bottom) {
        selectedItemRef.current.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth',
        });
      } else if (itemRect.top < menuRect.top) {
        selectedItemRef.current.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth',
        });
      }
    }
  }, [selectedIndex]);

  if (!isOpen) {
    return null;
  }

  // Show a message if no commands are available
  if (commands.length === 0) {
    return (
      <div
        ref={menuRef}
        className="command-menu command-menu-empty"
        style={{
          ...menuPosition,
          maxHeight: '300px',
          borderRadius: '8px',
          boxShadow:
            '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
          zIndex: 1000,
          padding: '20px',
          opacity: 1,
          transform: 'translateY(0)',
          transition:
            'opacity 150ms ease-in-out, transform 150ms ease-in-out',
          textAlign: 'center',
        }}
      >
        No commands available
      </div>
    );
  }

  // Add frequent commands as a special group if provided
  const hasFrequentCommands = frequentCommands.length > 0;

  // Group commands by namespace
  const groupedCommands = commands.reduce<Record<string, SlashCommand[]>>(
    (groups, command) => {
      const namespace = command.namespace || 'other';
      if (!groups[namespace]) {
        groups[namespace] = [];
      }
      groups[namespace].push(command);
      return groups;
    },
    {},
  );

  // Add frequent commands as a separate group
  if (hasFrequentCommands) {
    groupedCommands.frequent = frequentCommands;
  }

  // Order: frequent, builtin, project, user, other
  const namespaceOrder = hasFrequentCommands
    ? ['frequent', 'builtin', 'project', 'user', 'other']
    : ['builtin', 'project', 'user', 'other'];
  const orderedNamespaces = namespaceOrder.filter((ns) => groupedCommands[ns]);

  // Calculate global index for each command
  let globalIndex = 0;
  const commandsWithIndex: CommandWithIndex[] = [];
  orderedNamespaces.forEach((namespace) => {
    groupedCommands[namespace]!.forEach((command) => {
      commandsWithIndex.push({
        ...command,
        globalIndex: globalIndex++,
        namespace,
      });
    });
  });

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Available commands"
      className="command-menu"
      style={{
        ...menuPosition,
        maxHeight: '300px',
        overflowY: 'auto',
        borderRadius: '8px',
        boxShadow:
          '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        zIndex: 1000,
        padding: '8px',
        opacity: isOpen ? 1 : 0,
        transform: isOpen ? 'translateY(0)' : 'translateY(-10px)',
        transition:
          'opacity 150ms ease-in-out, transform 150ms ease-in-out',
      }}
    >
      {orderedNamespaces.map((namespace) => (
        <div key={namespace} className="command-group">
          {orderedNamespaces.length > 1 && (
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                color: '#6b7280',
                padding: '8px 12px 4px',
                letterSpacing: '0.05em',
              }}
            >
              {NAMESPACE_LABELS[namespace] || namespace}
            </div>
          )}
          {groupedCommands[namespace]!.map((command) => {
            const cmdWithIndex = commandsWithIndex.find(
              (c) => c.name === command.name && c.namespace === namespace,
            );
            const isSelected =
              !!cmdWithIndex && cmdWithIndex.globalIndex === selectedIndex;

            return (
              <div
                key={`${namespace}-${command.name}`}
                ref={isSelected ? selectedItemRef : null}
                role="option"
                aria-selected={isSelected}
                className="command-item"
                onMouseEnter={() => {
                  if (onSelect && cmdWithIndex) {
                    onSelect(command, cmdWithIndex.globalIndex, true);
                  }
                }}
                onClick={() => {
                  if (onSelect && cmdWithIndex) {
                    onSelect(command, cmdWithIndex.globalIndex, false);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  backgroundColor: isSelected ? '#eff6ff' : 'transparent',
                  transition: 'background-color 100ms ease-in-out',
                  marginBottom: '2px',
                }}
                onMouseDown={(e) => e.preventDefault()} // Prevent textarea blur
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: command.description ? '4px' : 0,
                    }}
                  >
                    {/* Command icon based on namespace */}
                    <span
                      style={{
                        fontSize: '16px',
                        flexShrink: 0,
                      }}
                    >
                      {namespace === 'builtin' && '⚡'}
                      {namespace === 'project' && '📁'}
                      {namespace === 'user' && '👤'}
                      {namespace === 'other' && '📝'}
                    </span>

                    {/* Command name */}
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: '14px',
                        color: '#111827',
                        fontFamily: 'monospace',
                      }}
                    >
                      {command.name}
                    </span>

                    {/* Command metadata badge */}
                    {typeof command.metadata?.type === 'string' && command.metadata.type && (
                      <span
                        className="command-metadata-badge"
                        style={{
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: '#f3f4f6',
                          color: '#6b7280',
                          fontWeight: 500,
                        }}
                      >
                        {command.metadata.type}
                      </span>
                    )}
                  </div>

                  {/* Command description */}
                  {command.description && (
                    <div
                      style={{
                        fontSize: '13px',
                        color: '#6b7280',
                        marginLeft: '24px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {command.description}
                    </div>
                  )}
                </div>

                {/* Selection indicator */}
                {isSelected && (
                  <span
                    style={{
                      marginLeft: '8px',
                      color: '#3b82f6',
                      fontSize: '12px',
                      fontWeight: 600,
                    }}
                  >
                    ↵
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Default light mode styles */}
      <style>{`
        .command-menu {
          background-color: white;
          border: 1px solid #e5e7eb;
        }
        .command-menu-empty {
          color: #6b7280;
        }

        @media (prefers-color-scheme: dark) {
          .command-menu {
            background-color: #1f2937 !important;
            border: 1px solid #374151 !important;
          }
          .command-menu-empty {
            color: #9ca3af !important;
          }
          .command-item[aria-selected="true"] {
            background-color: #1e40af !important;
          }
          .command-item span:not(.command-metadata-badge) {
            color: #f3f4f6 !important;
          }
          .command-metadata-badge {
            background-color: #f3f4f6 !important;
            color: #6b7280 !important;
          }
          .command-item div {
            color: #d1d5db !important;
          }
          .command-group > div:first-child {
            color: #9ca3af !important;
          }
        }
      `}</style>
    </div>
  );
}

export default CommandMenu;
