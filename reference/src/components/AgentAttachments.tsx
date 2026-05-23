/**
 * AgentAttachments.tsx - Agent File Attachments Component
 *
 * Displays and manages file attachments for a custom agent.
 * Files uploaded here are automatically read by Claude at the start of each conversation.
 */

import React, { useState, useRef, type ComponentType, type ChangeEvent } from 'react';
import { Paperclip, Trash2, Upload, Download, File, Image, FileText, Code, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

type IconComponent = ComponentType<{ className?: string | undefined }>;

// File type to icon mapping
const getFileIcon = (filename: string): IconComponent => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return File;
  if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return Image;
  if (['md', 'txt', 'pdf'].includes(ext)) return FileText;
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'sh', 'sql'].includes(ext)) return Code;
  return File;
};

// Format file size
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export interface AttachmentFile {
  name: string;
  size: number;
  // Other shape fields (path, uploadedAt) come from the API but aren't read here.
  [key: string]: unknown;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

interface AgentAttachmentsProps {
  attachments?: AttachmentFile[];
  isLoading?: boolean;
  onUpload: (file: File) => Promise<ActionResult>;
  onDownload?: (filename: string) => Promise<ActionResult>;
  onDelete: (filename: string) => Promise<ActionResult>;
  className?: string;
}

function AgentAttachments({
  attachments = [],
  isLoading = false,
  onUpload,
  onDownload,
  onDelete,
  className
}: AgentAttachmentsProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setIsUploading(true);
    try {
      const result = await onUpload(file);
      if (!result.success) {
        setError(result.error || 'Upload failed');
      }
    } catch (err) {
      setError((err as Error)?.message || 'Upload failed');
    } finally {
      setIsUploading(false);
      e.target.value = ''; // Reset input
    }
  };

  const handleDownload = async (filename: string) => {
    if (!onDownload) return;
    setDownloadingFile(filename);
    setError(null);
    try {
      const result = await onDownload(filename);
      if (!result.success) {
        setError(result.error ?? null);
      }
    } finally {
      setDownloadingFile(null);
    }
  };

  const handleDelete = async (filename: string) => {
    setDeletingFile(filename);
    setError(null);
    try {
      const result = await onDelete(filename);
      if (!result.success) {
        setError(result.error ?? null);
      }
    } finally {
      setDeletingFile(null);
    }
  };

  if (isLoading) {
    return (
      <div className={cn('p-4', className)}>
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-muted rounded w-1/3" />
          <div className="h-8 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
          <Paperclip className="w-4 h-4" />
          Attachments
          {attachments.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({attachments.length})
            </span>
          )}
        </h3>
      </div>

      {/* Description */}
      <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border bg-muted/30">
        Files uploaded here will be automatically read by Claude at the start of each conversation.
      </div>

      {/* Error message */}
      {error && (
        <div className="mx-3 mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-200"
          >
            &times;
          </button>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-auto p-3">
        {attachments.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Paperclip className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No attachments yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {attachments.map((file) => {
              const FileIcon = getFileIcon(file.name);
              const isDeleting = deletingFile === file.name;
              const isDownloading = downloadingFile === file.name;

              return (
                <div
                  key={file.name}
                  className="group flex items-center gap-3 p-2 rounded-lg border border-border hover:border-primary/50 transition-colors"
                >
                  <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" title={file.name}>{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatSize(file.size)}</p>
                  </div>
                  {onDownload && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                      onClick={() => handleDownload(file.name)}
                      disabled={isDownloading}
                      title="Download attachment"
                    >
                      {isDownloading ? (
                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Download className="w-3 h-3" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(file.name)}
                    disabled={isDeleting}
                    title="Delete attachment"
                  >
                    {isDeleting ? (
                      <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upload button */}
      <div className="p-3 border-t border-border">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? (
            <>
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
              Uploading...
            </>
          ) : (
            <>
              <Upload className="w-4 h-4 mr-2" />
              Add Attachment
            </>
          )}
        </Button>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Any file type. Files are read by Claude at the start of each conversation.
        </p>
      </div>
    </div>
  );
}

export default AgentAttachments;
