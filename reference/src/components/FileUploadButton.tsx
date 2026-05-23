import React, { useState, useRef } from 'react';
import { Paperclip, AlertCircle } from 'lucide-react';
import { api } from '../utils/api';

export interface FileUploadButtonProps {
  projectId: number | null | undefined;
  onUploadComplete?: ((path: string) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

interface UploadResponseFile {
  absolutePath: string;
}

interface UploadResponseBody {
  file: UploadResponseFile;
}

interface UploadErrorBody {
  error?: string;
}

function FileUploadButton({
  projectId,
  onUploadComplete,
  onError,
  disabled = false,
  className = '',
}: FileUploadButtonProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const setError = (message: string | null) => {
    if (onError && message) {
      onError(message);
    } else {
      setLocalError(message);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || projectId == null) return;

    setError(null);
    setIsUploading(true);

    try {
      const response = await api.projects.uploadFile(projectId, file);
      if (response.ok) {
        const data = (await response.json()) as UploadResponseBody;
        onUploadComplete?.('@' + data.file.absolutePath);
      } else {
        let message = `Upload failed (${response.status})`;
        try {
          const errorData = (await response.json()) as UploadErrorBody;
          if (errorData?.error) message = errorData.error;
        } catch {
          // response body wasn't JSON — keep default message
        }
        setError(message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      e.target.value = ''; // Reset input for re-upload of same file
    }
  };

  const handleClick = () => {
    setError(null);
    fileInputRef.current?.click();
  };

  return (
    <div className={`relative ${className}`}>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          void handleFileSelect(e);
        }}
        disabled={disabled || isUploading}
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || isUploading || !projectId}
        className="w-8 h-8 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-full flex items-center justify-center transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        title={isUploading ? 'Uploading…' : 'Attach file'}
      >
        {isUploading ? (
          <div className="w-4 h-4 border-2 border-gray-600 dark:border-gray-300 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Paperclip className="w-4 h-4 text-gray-600 dark:text-gray-300" />
        )}
      </button>

      {/* Local error tooltip (only shown when parent didn't supply onError) */}
      {localError && !onError && (
        <div className="absolute bottom-full right-0 mb-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap z-50 shadow-lg">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          <span>{localError}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setLocalError(null);
            }}
            className="ml-1 hover:text-red-900 dark:hover:text-red-100"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}

export default FileUploadButton;
