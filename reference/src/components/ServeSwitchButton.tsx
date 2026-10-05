/**
 * ServeSwitchButton — "point the project's served URL at this worktree", in one
 * control with two states.
 *
 * **Inactive**: an outline "Switch Server" button.
 * **Active** (this worktree is what the symlink points at): a green split
 * button — the left half re-opens the app, the right half resets serving back
 * to the main checkout.
 *
 * Shared by the task page (a ticket's worktree) and the epic page's Delivery
 * section (an epic's delivery worktree, i.e. its feature branch — every merged
 * ticket together). The switch itself is one endpoint and one symlink, so the
 * affordance is one component; only what it points at differs.
 *
 * See `docs/web-server/switch-server.md`.
 */

import { Loader2, Server, X } from 'lucide-react';
import { Button } from './ui/button';

export interface ServeSwitchButtonProps {
  /** True when this worktree is the one currently being served. */
  isActive: boolean;
  isSwitching: boolean;
  onSwitch: () => void;
  onOpenApp: () => void;
  onReset: () => void;
  /**
   * Why the switch cannot be taken right now, or null when it can. Applies to
   * the inactive state only — resetting is always allowed.
   */
  disabledReason?: string | null;
  /** Hover text for the inactive button; names what would be served. */
  switchTitle?: string;
  /** Hover text on the active button. */
  activeTitle?: string;
}

function ServeSwitchButton({
  isActive,
  isSwitching,
  onSwitch,
  onOpenApp,
  onReset,
  disabledReason = null,
  switchTitle = 'Switch web server to serve this worktree',
  activeTitle = 'This worktree is the active server — click to open the app',
}: ServeSwitchButtonProps) {
  if (isActive) {
    return (
      <div className="inline-flex items-center">
        <Button
          variant="default"
          size="sm"
          onClick={onOpenApp}
          disabled={isSwitching}
          className="h-7 text-xs bg-green-600 hover:bg-green-700 rounded-r-none"
          title={activeTitle}
        >
          <Server className="w-3.5 h-3.5 mr-1.5" />
          Active Server
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onReset}
          disabled={isSwitching}
          className="h-7 px-1.5 text-xs bg-green-600 hover:bg-green-700 rounded-l-none border-l border-green-700"
          title="Switch the web server back to the main repo"
        >
          {isSwitching ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <X className="w-3.5 h-3.5" />
          )}
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onSwitch}
      disabled={isSwitching || disabledReason !== null}
      className="h-7 text-xs"
      title={disabledReason ?? switchTitle}
    >
      {isSwitching ? (
        <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
      ) : (
        <Server className="w-3.5 h-3.5 mr-1.5" />
      )}
      Switch Server
    </Button>
  );
}

export default ServeSwitchButton;
