import React, { useState, useEffect, useRef, type ReactElement } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';
import { transcribeWithWhisper } from '../utils/whisper';

type MicState = 'idle' | 'recording' | 'transcribing';

export interface MicButtonProps {
  onTranscript?: (text: string) => void;
  className?: string;
}

interface ButtonAppearance {
  icon: ReactElement;
  className: string;
  disabled: boolean;
}

export function MicButton({ onTranscript, className = '' }: MicButtonProps) {
  const [state, setState] = useState<MicState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastTapRef = useRef(0);

  // Check microphone support on mount
  useEffect(() => {
    const checkSupport = () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setIsSupported(false);
        setError(
          'Microphone not supported. Please use HTTPS or a modern browser.',
        );
        return;
      }

      // Additional check for secure context
      if (
        location.protocol !== 'https:' &&
        location.hostname !== 'localhost'
      ) {
        setIsSupported(false);
        setError('Microphone requires HTTPS. Please use a secure connection.');
        return;
      }

      setIsSupported(true);
      setError(null);
    };

    checkSupport();
  }, []);

  // Start recording
  const startRecording = async () => {
    try {
      console.log('Starting recording...');
      setError(null);
      chunksRef.current = [];

      // Check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'Microphone access not available. Please use HTTPS or a supported browser.',
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        console.log('Recording stopped, creating blob...');
        const blob = new Blob(chunksRef.current, { type: mimeType });

        // Clean up stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        // Start transcribing
        setState('transcribing');

        try {
          const text = await transcribeWithWhisper(blob);
          if (text && onTranscript) {
            onTranscript(text);
          }
        } catch (err) {
          console.error('Transcription error:', err);
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setState('idle');
        }
      };

      recorder.start();
      setState('recording');
      console.log('Recording started successfully');
    } catch (err) {
      console.error('Failed to start recording:', err);

      // Provide specific error messages based on error type
      let errorMessage = 'Microphone access failed';
      const errName = err instanceof Error ? err.name : '';
      const errMsg = err instanceof Error ? err.message : '';

      if (errName === 'NotAllowedError') {
        errorMessage =
          'Microphone access denied. Please allow microphone permissions.';
      } else if (errName === 'NotFoundError') {
        errorMessage = 'No microphone found. Please check your audio devices.';
      } else if (errName === 'NotSupportedError') {
        errorMessage = 'Microphone not supported by this browser.';
      } else if (errName === 'NotReadableError') {
        errorMessage = 'Microphone is being used by another application.';
      } else if (errMsg.includes('HTTPS')) {
        errorMessage = errMsg;
      }

      setError(errorMessage);
      setState('idle');
    }
  };

  // Stop recording
  const stopRecording = () => {
    console.log('Stopping recording...');
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording'
    ) {
      mediaRecorderRef.current.stop();
      // Don't set state here - let the onstop handler do it
    } else {
      // If recorder isn't in recording state, force cleanup
      console.log('Recorder not in recording state, forcing cleanup');
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      setState('idle');
    }
  };

  // Handle button click
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Prevent double firing on mobile
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Don't proceed if microphone is not supported
    if (!isSupported) {
      return;
    }

    // Debounce for mobile double-tap issue
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      console.log('Ignoring rapid tap');
      return;
    }
    lastTapRef.current = now;

    console.log('Button clicked, current state:', state);

    if (state === 'idle') {
      void startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
    // Do nothing if transcribing or processing
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Button appearance based on state
  const getButtonAppearance = (): ButtonAppearance => {
    if (!isSupported) {
      return {
        icon: <Mic className="w-5 h-5 text-gray-200" />,
        className: 'bg-gray-400 cursor-not-allowed',
        disabled: true,
      };
    }

    switch (state) {
      case 'recording':
        // A solid stop square — clearly distinct from the mic glyph — so the
        // button visibly toggles mic ⇄ stop while recording.
        return {
          icon: <Square className="w-5 h-5 text-white" fill="currentColor" />,
          className: 'bg-red-500 hover:bg-red-600',
          disabled: false,
        };
      case 'transcribing':
        return {
          icon: <Loader2 className="w-5 h-5 text-white animate-spin" />,
          className: 'bg-blue-500 hover:bg-blue-600',
          disabled: true,
        };
      case 'idle':
        return {
          icon: <Mic className="w-5 h-5 text-white" />,
          className: 'bg-gray-700 hover:bg-gray-600',
          disabled: false,
        };
    }
  };

  const { icon, className: appearanceClassName, disabled } = getButtonAppearance();

  const ariaLabel = !isSupported
    ? 'Microphone unavailable'
    : state === 'recording'
      ? 'Stop recording'
      : state === 'transcribing'
        ? 'Transcribing'
        : 'Start voice recording';

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        // Background comes from the per-state Tailwind classes below (not an
        // inline style) and the button no longer runs a whole-element opacity
        // animation: on iOS Safari, animating opacity on a backdrop-blurred
        // overlay's child could drop the element's paint, making the red fill
        // and white icon disappear. The pulsing ring below conveys "recording".
        className={`
          flex items-center justify-center
          w-12 h-12 rounded-full
          text-white transition-colors duration-200
          focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500
          dark:ring-offset-gray-800
          touch-action-manipulation
          ${disabled ? 'cursor-not-allowed opacity-75' : 'cursor-pointer'}
          ${appearanceClassName}
          ${className}
        `}
        onClick={handleClick}
        disabled={disabled}
      >
        {icon}
      </button>

      {error && (
        <div
          className="absolute top-full mt-2 left-1/2 transform -translate-x-1/2
                        bg-red-500 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10
                        animate-fade-in"
        >
          {error}
        </div>
      )}

      {state === 'recording' && (
        <div className="absolute -inset-1 rounded-full border-2 border-red-500 animate-ping pointer-events-none" />
      )}
    </div>
  );
}
