/**
 * ToastContext.tsx - Toast Notification System
 *
 * Provides a simple toast notification system for displaying
 * temporary success, error, warning, and info messages.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
  type ComponentType,
} from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { cn } from '../lib/utils';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastEntry {
  id: number;
  message: string;
  type: ToastType;
}

export interface ToastApi {
  success: (message: string) => number;
  error: (message: string) => number;
  warning: (message: string) => number;
  info: (message: string) => number;
}

export interface ToastContextValue {
  toast: ToastApi;
  addToast: (message: string, type?: ToastType) => number;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

const TOAST_DURATION = 5000;

interface ToastStyle {
  bg: string;
  text: string;
  icon: ComponentType<{ className?: string | undefined }>;
  iconColor: string;
}

const toastStyles: Record<ToastType, ToastStyle> = {
  success: {
    bg: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
    text: 'text-green-800 dark:text-green-200',
    icon: CheckCircle,
    iconColor: 'text-green-500',
  },
  error: {
    bg: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    text: 'text-red-800 dark:text-red-200',
    icon: AlertCircle,
    iconColor: 'text-red-500',
  },
  warning: {
    bg: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
    text: 'text-yellow-800 dark:text-yellow-200',
    icon: AlertTriangle,
    iconColor: 'text-yellow-500',
  },
  info: {
    bg: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    text: 'text-blue-800 dark:text-blue-200',
    icon: Info,
    iconColor: 'text-blue-500',
  },
};

interface ToastProps {
  id: number;
  message: string;
  type?: ToastType;
  onDismiss: (id: number) => void;
}

function Toast({ id, message, type = 'info', onDismiss }: ToastProps) {
  const style = toastStyles[type] || toastStyles.info;
  const Icon = style.icon;

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg',
        'animate-in slide-in-from-top-2 fade-in duration-200',
        style.bg,
      )}
      role="alert"
    >
      <Icon className={cn('w-5 h-5 flex-shrink-0', style.iconColor)} />
      <p className={cn('text-sm font-medium flex-1', style.text)}>{message}</p>
      <button
        onClick={() => onDismiss(id)}
        className={cn(
          'p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
          style.text,
        )}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const addToast = useCallback((message: string, type: ToastType = 'info'): number => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION);

    return id;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // useMemo (the .jsx original wrapped this object in useCallback, which only
  // worked because React's useCallback returns its first argument verbatim;
  // useMemo is the semantically-correct hook for memoizing a non-function value).
  const toast = useMemo<ToastApi>(
    () => ({
      success: (message: string) => addToast(message, 'success'),
      error: (message: string) => addToast(message, 'error'),
      warning: (message: string) => addToast(message, 'warning'),
      info: (message: string) => addToast(message, 'info'),
    }),
    [addToast],
  );

  return (
    <ToastContext.Provider value={{ toast, addToast, dismissToast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            id={t.id}
            message={t.message}
            type={t.type}
            onDismiss={dismissToast}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export default ToastContext;
