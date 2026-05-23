import { useState, useEffect, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { AdminUserListItem } from '../../../shared/api/admin';

export interface UserFormSubmitData {
  username: string;
  password?: string;
  is_admin: boolean;
}

export interface UserFormSubmitResult {
  error?: string;
}

export interface UserFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: UserFormSubmitData) => Promise<UserFormSubmitResult>;
  user: AdminUserListItem | null;
  isSubmitting: boolean;
}

function UserForm({ isOpen, onClose, onSubmit, user, isSubmitting }: UserFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState('');

  const isEditing = !!user;

  useEffect(() => {
    if (isOpen) {
      if (user) {
        setUsername(user.username || '');
        setIsAdmin(!!user.is_admin);
        setPassword('');
      } else {
        setUsername('');
        setPassword('');
        setIsAdmin(false);
      }
      setError('');
    }
  }, [isOpen, user]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');

    if (!username.trim()) {
      setError('Username is required');
      return;
    }

    if (!isEditing && !password) {
      setError('Password is required for new users');
      return;
    }

    const data: UserFormSubmitData = {
      username: username.trim(),
      is_admin: isAdmin,
    };

    if (password) {
      data.password = password;
    }

    const result = await onSubmit(data);
    if (result?.error) {
      setError(result.error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit User' : 'Create User'}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={isSubmitting}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-500 bg-red-500/10 rounded-md">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="username" className="text-sm font-medium text-foreground">
              Username
            </label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              disabled={isSubmitting}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password {isEditing && <span className="text-muted-foreground">(leave blank to keep current)</span>}
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isEditing ? 'Enter new password' : 'Enter password'}
              disabled={isSubmitting}
            />
          </div>

          <div className="flex items-center space-x-2">
            <input
              id="isAdmin"
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              disabled={isSubmitting}
              className="h-4 w-4 rounded border-input"
            />
            <label htmlFor="isAdmin" className="text-sm font-medium text-foreground">
              Admin privileges
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create User')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default UserForm;
