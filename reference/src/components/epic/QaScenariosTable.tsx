/**
 * QaScenariosTable — renders `qa/scenarios.csv` in the artifacts tab: a
 * summary strip (pass / fail / not run), a Download link, and the scenario
 * table itself. Parsed with the shared QA contract (`shared/schemas/qa`), the
 * same module the server tools serialize with; a file that does not parse
 * degrades to an error banner over the raw text, never a blank pane.
 *
 * Read-only by design, like every artifacts surface: scenarios are revised in
 * the QA stage's conversation, results are recorded by the execution agent —
 * the table live-updates through `EpicFileBrowser`'s version-keyed cache as
 * the CSV is rewritten in place.
 */

import { Download } from 'lucide-react';
import { parseQaScenarios, type QaScenarioRow } from '@shared/schemas/qa';
import { cn } from '../../lib/utils';

export interface QaScenariosTableProps {
  content: string;
  filename: string;
  /** Pre-authenticated (`?token=`) href for the raw-CSV download route. */
  downloadUrl: string;
}

const STATUS_CLASSES: Record<'pass' | 'fail' | '', string> = {
  pass: 'bg-green-500/15 text-green-600 dark:text-green-400',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400',
  '': 'bg-muted text-muted-foreground',
};

const CONFIDENCE_TITLES: Record<string, string> = {
  '1': 'Confidence 1 — a judgment call (e.g. interpreting a screenshot)',
  '2': 'Confidence 2 — right behaviour observed through an indirect signal',
  '3': 'Confidence 3 — a deterministic check',
};

function StatusCell({ status }: { status: QaScenarioRow['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-xs font-medium',
        STATUS_CLASSES[status],
      )}
    >
      {status === '' ? 'not run' : status}
    </span>
  );
}

function DownloadLink({ downloadUrl, filename }: { downloadUrl: string; filename: string }) {
  return (
    <a
      href={downloadUrl}
      download={filename}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted/60"
    >
      <Download className="h-3.5 w-3.5" />
      Download CSV
    </a>
  );
}

function QaScenariosTable({ content, filename, downloadUrl }: QaScenariosTableProps) {
  // Anything except the scenario book itself (nothing else should land in
  // `qa/`, but a stray file must still be readable) shows raw.
  if (!filename.endsWith('.csv')) {
    return <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-sm">{content}</pre>;
  }

  const parsed = parseQaScenarios(content);
  if (!parsed.ok) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          <p className="font-medium">This file does not match the QA scenario format:</p>
          <ul className="mt-1 list-inside list-disc">
            {parsed.errors.slice(0, 10).map((err) => (
              <li key={err}>{err}</li>
            ))}
            {parsed.errors.length > 10 ? <li>… and {parsed.errors.length - 10} more</li> : null}
          </ul>
        </div>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-sm">{content}</pre>
      </div>
    );
  }

  const rows = parsed.rows;
  const pass = rows.filter((r) => r.status === 'pass').length;
  const fail = rows.filter((r) => r.status === 'fail').length;
  const notRun = rows.length - pass - fail;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{rows.length} scenarios:</span>
        <span className="text-green-600 dark:text-green-400">{pass} pass</span>
        <span className="text-red-600 dark:text-red-400">{fail} fail</span>
        <span className="text-muted-foreground">{notRun} not run</span>
        <div className="flex-1" />
        <DownloadLink downloadUrl={downloadUrl} filename={filename} />
      </div>

      <div className="max-h-[36rem] overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="px-2 py-1.5 font-medium">Id</th>
              <th className="px-2 py-1.5 font-medium">Feature</th>
              <th className="px-2 py-1.5 font-medium">Title</th>
              <th className="px-2 py-1.5 font-medium">Steps</th>
              <th className="px-2 py-1.5 font-medium">Expected</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium" title="1 = low, 3 = high">
                Conf.
              </th>
              <th className="px-2 py-1.5 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">{row.id}</td>
                <td className="px-2 py-1.5">{row.feature}</td>
                <td className="px-2 py-1.5">{row.title}</td>
                <td className="whitespace-pre-wrap px-2 py-1.5 text-xs">{row.steps}</td>
                <td className="whitespace-pre-wrap px-2 py-1.5 text-xs">{row.expected}</td>
                <td className="px-2 py-1.5">
                  <StatusCell status={row.status} />
                </td>
                <td
                  className="whitespace-nowrap px-2 py-1.5 text-center"
                  title={CONFIDENCE_TITLES[row.confidence] ?? ''}
                >
                  {row.confidence === '' ? '—' : row.confidence}
                </td>
                <td className="whitespace-pre-wrap px-2 py-1.5 text-xs text-muted-foreground">
                  {row.notes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default QaScenariosTable;
