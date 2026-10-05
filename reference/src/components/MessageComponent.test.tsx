import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import MessageComponent, { type DisplayMessage } from './MessageComponent';

const IMAGE: DisplayMessage = {
  type: 'image',
  fileName: 'exec-1.png',
  width: 1536,
  height: 1024,
  timestamp: '2026-10-05T00:00:00.000Z',
};

describe('MessageComponent — generated image', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads the image through the conversation it belongs to, authenticated by query token', () => {
    localStorage.setItem('auth-token', 'tok en');

    render(<MessageComponent message={IMAGE} conversationId={5} />);

    expect(screen.getByAltText('Generated image')).toHaveAttribute(
      'src',
      '/api/conversations/5/images/exec-1.png?token=tok%20en',
    );
  });

  it('renders nothing without a conversation to load it from', () => {
    const { container } = render(<MessageComponent message={IMAGE} />);

    expect(container).toBeEmptyDOMElement();
  });
});
