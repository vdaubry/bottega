import { Pencil, Trash2, Shield, User } from 'lucide-react';
import { Button } from '../ui/button';
import type { AdminUserListItem } from '../../../shared/api/admin';

export interface UserListProps {
  users: AdminUserListItem[];
  onEdit: (user: AdminUserListItem) => void;
  onDelete: (user: AdminUserListItem) => void;
  currentUserId?: number;
  isDeleting: number | null;
}

function UserList({ users, onEdit, onDelete, currentUserId, isDeleting }: UserListProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-3 px-4 font-medium text-muted-foreground">Username</th>
            <th className="text-left py-3 px-4 font-medium text-muted-foreground">Role</th>
            <th className="text-left py-3 px-4 font-medium text-muted-foreground">Status</th>
            <th className="text-left py-3 px-4 font-medium text-muted-foreground">Created</th>
            <th className="text-right py-3 px-4 font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-border/50 hover:bg-accent/50">
              <td className="py-3 px-4">
                <div className="flex items-center gap-2">
                  {user.is_admin ? (
                    <Shield className="h-4 w-4 text-amber-500" />
                  ) : (
                    <User className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="font-medium text-foreground">{user.username}</span>
                  {user.id === currentUserId && (
                    <span className="text-xs text-muted-foreground">(you)</span>
                  )}
                </div>
              </td>
              <td className="py-3 px-4">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  user.is_admin
                    ? 'bg-amber-500/10 text-amber-500'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {user.is_admin ? 'Admin' : 'User'}
                </span>
              </td>
              <td className="py-3 px-4">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  user.is_active !== 0
                    ? 'bg-green-500/10 text-green-500'
                    : 'bg-red-500/10 text-red-500'
                }`}>
                  {user.is_active !== 0 ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td className="py-3 px-4 text-muted-foreground">
                {user.created_at ? new Date(user.created_at).toLocaleDateString() : '-'}
              </td>
              <td className="py-3 px-4">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEdit(user)}
                    title="Edit user"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(user)}
                    disabled={user.id === currentUserId || isDeleting === user.id}
                    title={user.id === currentUserId ? "Cannot delete yourself" : "Delete user"}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {users.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          No users found
        </div>
      )}
    </div>
  );
}

export default UserList;
