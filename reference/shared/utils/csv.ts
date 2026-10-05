// Minimal RFC-4180 CSV codec — the QA scenario file's wire format.
//
// Dependency-free on purpose: the only CSV in the app is the epic QA stage's
// `qa/scenarios.csv`, whose cells (steps, expected, notes) routinely carry
// commas and newlines, so naive `split(',')` handling is not an option. Shared
// between the server (the bottega QA tools own serialization) and the frontend
// (the artifacts-tab table parses for display).
//
// Dialect: `,` separator; `"`-quoted cells may contain commas, newlines and
// doubled quotes (`""` = one literal quote); LF, CRLF and lone-CR row
// terminators are all accepted; output uses LF with a trailing newline.

export class CsvParseError extends Error {
  /** 1-based line number (of the source text) where parsing failed. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

/**
 * Parse CSV text into rows of cells. Throws `CsvParseError` on an unterminated
 * quoted cell. A trailing newline does not produce an empty final row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  // A quote only OPENS a cell at its start; a stray quote mid-cell is literal.
  let atCellStart = true;
  let line = 1;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && atCellStart) {
      inQuotes = true;
      atCellStart = false;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      atCellStart = true;
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      i++;
      continue;
    }
    cell += ch;
    atCellStart = false;
    i++;
  }

  if (inQuotes) throw new CsvParseError('Unterminated quoted cell', line);
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function encodeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize rows to CSV text (LF-terminated, trailing newline). */
export function stringifyCsv(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  return rows.map((row) => row.map(encodeCell).join(',')).join('\n') + '\n';
}
