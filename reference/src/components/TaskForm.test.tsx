import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TaskForm from './TaskForm';

vi.mock('../utils/whisper', () => ({ transcribeWithWhisper: vi.fn() }));
import { transcribeWithWhisper } from '../utils/whisper';

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

const realMatchMedia = window.matchMedia;
const setCoarsePointer = (coarse: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: typeof query === 'string' && query.includes('coarse') ? coarse : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

const docTextarea = () => document.getElementById('task-documentation') as HTMLTextAreaElement;

const renderForm = () =>
  render(
    <TaskForm
      isOpen
      onClose={vi.fn()}
      onSubmit={vi.fn().mockResolvedValue({ success: true })}
      projectName="TestProject"
    />,
  );

async function recordAndStop() {
  fireEvent.click(screen.getByLabelText('Start voice recording'));
  const stopBtn = await screen.findByLabelText('Stop recording');
  fireEvent.click(stopBtn);
  await waitFor(() => expect(docTextarea().value).toBe('hello world'));
}

describe('TaskForm voice transcription', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
    let t = 100000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
    (transcribeWithWhisper as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('hello world');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.matchMedia = realMatchMedia;
  });

  it('inserts the transcript and focuses the textarea on a fine pointer (desktop)', async () => {
    setCoarsePointer(false);
    renderForm();
    await recordAndStop();
    await waitFor(() => expect(document.activeElement).toBe(docTextarea()));
  });

  it('inserts the transcript without stealing focus on a coarse pointer (touch)', async () => {
    setCoarsePointer(true);
    renderForm();
    await recordAndStop();
    // Focus is intentionally NOT moved to the textarea on touch devices: doing
    // so leaves it focused with the keyboard closed, and iOS Safari then eats
    // the next tap (on "Create Task") to open the keyboard instead of submitting.
    expect(docTextarea().value).toBe('hello world');
    expect(document.activeElement).not.toBe(docTextarea());
  });
});
