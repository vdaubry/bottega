/**
 * SQLite CURRENT_TIMESTAMP is UTC in 'YYYY-MM-DD HH:MM:SS' form — without a
 * timezone marker `Date.parse` reads it as LOCAL time, skewing elapsed-time
 * math by the UTC offset. Normalize to ISO-with-Z before parsing.
 */
export function parseSqliteUtc(timestamp: string): number {
  const iso = timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}
