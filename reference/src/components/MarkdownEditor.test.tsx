import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownEditor from './MarkdownEditor';

// Mock MicButton to avoid audio API issues in tests
vi.mock('./MicButton', () => ({
  MicButton: () => <button data-testid="mic-button">Mic</button>,
}));

vi.mock('./ui/button', () => ({
  Button: ({ children, onClick, disabled }: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

describe('MarkdownEditor', () => {
  it('renders GFM tables as HTML table elements', () => {
    const tableContent = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
    const { container } = render(
      <MarkdownEditor content={tableContent} editable={false} />
    );
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(4);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('renders headers correctly', () => {
    const content = '# Heading 1\n\n## Heading 2\n\n### Heading 3';
    const { container } = render(
      <MarkdownEditor content={content} editable={false} />
    );
    expect(container.querySelector('h1')).toBeTruthy();
    expect(container.querySelector('h1')?.textContent).toBe('Heading 1');
    expect(container.querySelector('h2')?.textContent).toBe('Heading 2');
    expect(container.querySelector('h3')?.textContent).toBe('Heading 3');
  });

  it('renders unordered and ordered lists', () => {
    const content = '- Item A\n- Item B\n\n1. First\n2. Second';
    const { container } = render(
      <MarkdownEditor content={content} editable={false} />
    );
    expect(container.querySelector('ul')).toBeTruthy();
    expect(container.querySelector('ol')).toBeTruthy();
    expect(screen.getByText('Item A')).toBeTruthy();
    expect(screen.getByText('First')).toBeTruthy();
  });

  it('renders code blocks', () => {
    const content = '```js\nconst x = 1;\n```';
    const { container } = render(
      <MarkdownEditor content={content} editable={false} />
    );
    expect(container.querySelector('pre')).toBeTruthy();
    expect(container.querySelector('code')).toBeTruthy();
  });

  it('renders inline formatting (bold, italic, code, links)', () => {
    const content = '**bold** and *italic* and `code` and [link](https://example.com)';
    const { container } = render(
      <MarkdownEditor content={content} editable={false} />
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
    const link = container.querySelector('a');
    expect(link?.textContent).toBe('link');
    expect(link?.getAttribute('href')).toBe('https://example.com');
  });

  it('renders placeholder when content is empty', () => {
    render(<MarkdownEditor content="" editable={false} />);
    expect(screen.getByText('No documentation yet. Click Edit to add content.')).toBeTruthy();
  });

  it('renders placeholder when content is null', () => {
    render(<MarkdownEditor content={null} editable={false} />);
    expect(screen.getByText('No documentation yet. Click Edit to add content.')).toBeTruthy();
  });

  it('renders blockquotes', () => {
    const content = '> This is a quote';
    const { container } = render(
      <MarkdownEditor content={content} editable={false} />
    );
    expect(container.querySelector('blockquote')).toBeTruthy();
    expect(screen.getByText('This is a quote')).toBeTruthy();
  });

  it('renders strikethrough text', () => {
    const content = '~~deleted~~';
    const { container } = render(
      <MarkdownEditor content={content} editable={false} />
    );
    expect(container.querySelector('del')).toBeTruthy();
    expect(container.querySelector('del')?.textContent).toBe('deleted');
  });

  it('always renders full content without truncation', () => {
    const longContent = 'A'.repeat(500) + '\n\nMore content here';
    render(<MarkdownEditor content={longContent} editable={false} />);
    expect(screen.getByText(/More content here/)).toBeTruthy();
    expect(screen.queryByText('Show more')).toBeNull();
    expect(screen.queryByText('Show less')).toBeNull();
  });

  it('renders Show button when onShowClick is provided and content exists', () => {
    const onShowClick = vi.fn();
    render(
      <MarkdownEditor content="Some content" onShowClick={onShowClick} editable={true} />
    );
    const showButton = screen.getByText('Show');
    expect(showButton).toBeTruthy();
    showButton.click();
    expect(onShowClick).toHaveBeenCalled();
  });

  it('does not render Show button when onShowClick is not provided', () => {
    render(
      <MarkdownEditor content="Some content" editable={true} />
    );
    expect(screen.queryByText('Show')).toBeNull();
  });

  it('does not render Show button when content is empty', () => {
    const onShowClick = vi.fn();
    render(
      <MarkdownEditor content="" onShowClick={onShowClick} editable={true} />
    );
    expect(screen.queryByText('Show')).toBeNull();
  });
});
