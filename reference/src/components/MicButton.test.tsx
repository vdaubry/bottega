import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MicButton } from './MicButton';

vi.mock('../utils/whisper', () => ({ transcribeWithWhisper: vi.fn() }));
import { transcribeWithWhisper } from '../utils/whisper';

// Minimal MediaRecorder stand-in: start() flips to "recording"; stop() emits a
// chunk then fires onstop synchronously, which is what MicButton listens for.
class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const svgClass = (btn: HTMLElement) => btn.querySelector('svg')?.getAttribute('class') ?? '';

describe('MicButton', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
    // Each click reads Date.now(); keep successive reads >300ms apart so the
    // mobile double-tap debounce never swallows the test's second click.
    let t = 100000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
    (transcribeWithWhisper as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('hello world');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a microphone icon while idle', () => {
    render(<MicButton />);
    expect(svgClass(screen.getByLabelText('Start voice recording'))).toContain('lucide-mic');
  });

  it('swaps the mic for a stop icon while recording, then back to a mic after transcription', async () => {
    const onTranscript = vi.fn();
    render(<MicButton onTranscript={onTranscript} />);

    fireEvent.click(screen.getByLabelText('Start voice recording'));

    // Recording: the glyph must become a stop square, not stay a mic.
    const stopBtn = await screen.findByLabelText('Stop recording');
    expect(svgClass(stopBtn)).toContain('lucide-square');
    expect(svgClass(stopBtn)).not.toContain('lucide-mic');

    fireEvent.click(stopBtn);

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('hello world'));

    // Back to idle: the glyph returns to a mic so the user can record again.
    const idleBtn = await screen.findByLabelText('Start voice recording');
    expect(svgClass(idleBtn)).toContain('lucide-mic');
  });
});
