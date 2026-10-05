import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import QaScenariosTable from './QaScenariosTable';
import { QA_CSV_HEADER, serializeQaScenarios, type QaScenarioRow } from '@shared/schemas/qa';

const row = (overrides: Partial<QaScenarioRow> = {}): QaScenarioRow => ({
  id: 'S-001',
  feature: 'Login',
  title: 'Wrong password shows an error',
  steps: '1. Open /login\n2. Submit, with a comma',
  expected: 'Shows "Invalid credentials"',
  status: '',
  confidence: '',
  notes: '',
  ...overrides,
});

function renderTable(content: string, filename = 'scenarios.csv') {
  return render(
    <QaScenariosTable content={content} filename={filename} downloadUrl="/dl?token=x" />,
  );
}

describe('QaScenariosTable', () => {
  it('renders the book as a table with a result summary strip', () => {
    renderTable(
      serializeQaScenarios([
        row(),
        row({ id: 'S-002', status: 'pass', confidence: '3' }),
        row({ id: 'S-003', status: 'fail', confidence: '1', notes: 'expected X, observed Y' }),
      ]),
    );

    expect(screen.getByText('3 scenarios:')).toBeInTheDocument();
    expect(screen.getByText('1 pass')).toBeInTheDocument();
    expect(screen.getByText('1 fail')).toBeInTheDocument();
    expect(screen.getByText('1 not run')).toBeInTheDocument();

    expect(screen.getByText('S-001')).toBeInTheDocument();
    // Quoted newlines and commas survive into the cell (one per row).
    expect(screen.getAllByText(/1\. Open \/login\s*2\. Submit, with a comma/)).toHaveLength(3);
    expect(screen.getByText('expected X, observed Y')).toBeInTheDocument();
    // A not-run row reads as such.
    expect(screen.getByText('not run')).toBeInTheDocument();
  });

  it('links the download to the pre-authenticated raw route', () => {
    renderTable(serializeQaScenarios([row()]));

    const link = screen.getByRole('link', { name: /Download CSV/ });
    expect(link).toHaveAttribute('href', '/dl?token=x');
    expect(link).toHaveAttribute('download', 'scenarios.csv');
  });

  it('degrades a malformed book to an error banner over the raw text — never a blank pane', () => {
    const text = QA_CSV_HEADER.join(',') + '\nS-001,Login,Title\n';
    renderTable(text);

    expect(screen.getByText(/does not match the QA scenario format/)).toBeInTheDocument();
    expect(screen.getByText(/expected 8 cells, got 3/)).toBeInTheDocument();
    expect(screen.getByText(/S-001,Login,Title/)).toBeInTheDocument();
  });

  it('shows a stray non-CSV file raw', () => {
    renderTable('just a note', 'note.txt');

    expect(screen.getByText('just a note')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
