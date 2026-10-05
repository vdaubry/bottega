import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv, stringifyCsv } from './csv.js';

describe('parseCsv', () => {
  it('parses plain rows and drops the trailing newline row', () => {
    expect(parseCsv('a,b,c\nd,e,f\n')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('parses quoted cells carrying commas, newlines and doubled quotes', () => {
    const text = 'id,steps\nS-001,"1. Click ""Save""\n2. Wait, then reload"\n';
    expect(parseCsv(text)).toEqual([
      ['id', 'steps'],
      ['S-001', '1. Click "Save"\n2. Wait, then reload'],
    ]);
  });

  it('accepts CRLF and lone-CR row terminators', () => {
    expect(parseCsv('a,b\r\nc,d\re,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('treats a quote in the middle of an unquoted cell as literal', () => {
    expect(parseCsv('5" screen,x')).toEqual([['5" screen', 'x']]);
  });

  it('throws CsvParseError with a line number on an unterminated quote', () => {
    expect(() => parseCsv('a,b\nc,"open\nstill open')).toThrowError(CsvParseError);
    try {
      parseCsv('a,b\nc,"open\nstill open');
    } catch (error) {
      expect((error as CsvParseError).line).toBe(3);
    }
  });
});

describe('stringifyCsv', () => {
  it('round-trips cells that need quoting', () => {
    const rows = [
      ['id', 'notes'],
      ['S-001', 'expected "OK", got:\nerror, twice'],
    ];
    expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
  });

  it('leaves plain cells unquoted and ends with a newline', () => {
    expect(stringifyCsv([['a', 'b']])).toBe('a,b\n');
  });

  it('serializes no rows to an empty string', () => {
    expect(stringifyCsv([])).toBe('');
  });
});
