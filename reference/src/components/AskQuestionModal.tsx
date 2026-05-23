import React, { useState, useEffect, useRef } from 'react';
import { X, MessageCircleQuestion } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { MicButton } from './MicButton';
import { ProviderModelPicker } from './ProviderModelPicker';
import { useProviderModelSelection } from '../hooks/useProviderModelSelection';
import type { Provider } from '../../shared/providers/types';

export interface AskQuestionPayload {
  title: string;
  question: string;
  provider: Provider;
  model: string;
}

export interface AskQuestionResult {
  success: boolean;
  error?: string;
}

export interface AskQuestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: AskQuestionPayload) => Promise<AskQuestionResult | void>;
  projectName?: string;
  isSubmitting?: boolean;
}

function AskQuestionModal({
  isOpen,
  onClose,
  onSubmit,
  projectName,
  isSubmitting = false,
}: AskQuestionModalProps) {
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    loadingOpenCodeModels,
    reset: resetProviderModel,
  } = useProviderModelSelection();

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setQuestion('');
      setError(null);
      resetProviderModel();
    }
  }, [isOpen, resetProviderModel]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!question.trim()) {
      setError('Question is required');
      return;
    }
    if (provider === 'opencode' && !model) {
      setError(
        'Select an OpenCode model. If the list is empty, connect an OpenCode key in Settings → Providers.',
      );
      return;
    }

    try {
      const result = await onSubmit({
        title: title.trim(),
        question: question.trim(),
        provider,
        model,
      });
      if (result && !result.success) {
        setError(result.error || 'Failed to ask question');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ask question');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={!isSubmitting ? onClose : undefined}
      />

      <div
        className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-md mx-4"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <MessageCircleQuestion className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">
              Ask a Question
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="p-4 space-y-4"
        >
          {projectName && (
            <div className="text-sm text-muted-foreground">
              Asking in:{' '}
              <span className="font-medium text-foreground">{projectName}</span>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="ask-question-title"
              className="text-sm font-medium text-foreground"
            >
              Task Title
            </label>
            <Input
              id="ask-question-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Architecture exploration"
              disabled={isSubmitting}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label
              htmlFor="ask-question-content"
              className="text-sm font-medium text-foreground"
            >
              Question
            </label>
            <div className="flex gap-2 items-start">
              <Textarea
                ref={questionRef}
                id="ask-question-content"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. What Rails version is this project using?"
                rows={5}
                disabled={isSubmitting}
                className="resize-y min-h-[100px] flex-1"
              />
              <MicButton
                onTranscript={(transcript) => {
                  setQuestion((prev) => {
                    if (!prev.trim()) return transcript;
                    return prev.trimEnd() + ' ' + transcript;
                  });
                  requestAnimationFrame(() => {
                    if (questionRef.current) {
                      questionRef.current.focus();
                    }
                  });
                }}
              />
            </div>
          </div>

          <ProviderModelPicker
            provider={provider}
            model={model}
            setModel={setModel}
            handleProviderChange={handleProviderChange}
            modelOptions={modelOptions}
            loadingOpenCodeModels={loadingOpenCodeModels}
            disabled={isSubmitting}
            testIdPrefix="ask-question"
          />

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              className="flex-1"
              disabled={isSubmitting || !title.trim() || !question.trim()}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Asking...
                </>
              ) : (
                'Ask Question'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AskQuestionModal;
