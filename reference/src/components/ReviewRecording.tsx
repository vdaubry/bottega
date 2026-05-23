import React, { useState, useEffect } from 'react';
import { Video, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../utils/api';
import { cn } from '../lib/utils';

export interface ReviewRecordingProps {
  taskId: number | null | undefined;
  className?: string;
}

function ReviewRecording({ taskId, className }: ReviewRecordingProps) {
  const [hasRecording, setHasRecording] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setHasRecording(false);
      return;
    }

    let cancelled = false;

    const checkRecording = async () => {
      try {
        const response = await api.tasks.checkReviewRecording(taskId);
        if (!cancelled) {
          setHasRecording(response.ok);
          // Collapse if recording disappeared
          if (!response.ok) setIsExpanded(false);
        }
      } catch {
        if (!cancelled) setHasRecording(false);
      }
    };

    void checkRecording();

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!hasRecording) return null;

  const token = localStorage.getItem('auth-token');
  const videoSrc = `/api/tasks/${taskId}/review-recording${token ? `?token=${token}` : ''}`;

  return (
    <div className={cn('border-t border-border', className)}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        data-testid="review-recording-toggle"
      >
        <Video className="w-4 h-4" />
        <span>Review Recording</span>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 ml-auto" />
        ) : (
          <ChevronDown className="w-4 h-4 ml-auto" />
        )}
      </button>
      {isExpanded && (
        <div className="px-4 pb-3" data-testid="review-recording-player">
          <video
            controls
            className="w-full max-h-[60vh] rounded-lg border border-border bg-black"
            src={videoSrc}
            preload="metadata"
          >
            Your browser does not support the video tag.
          </video>
        </div>
      )}
    </div>
  );
}

export default ReviewRecording;
