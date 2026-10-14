/** Timestamped, redacted structured logs retained for a session-scoped JSON export. */
export type LogRecord = { timestamp: string; event: string; [key: string]: unknown };
const MAX_LOG_RECORDS = 5000;
const records: LogRecord[] = [];
const DEFAULT_LOG_TIME_ZONE = 'Europe/Copenhagen';

function localTimestamp(date: Date): { timestampLocal: string; timeZone: string } {
  const timeZone = process.env.LOG_TIME_ZONE?.trim() || DEFAULT_LOG_TIME_ZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(date);
    const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
    const zone = part('timeZoneName');
    const offset = zone === 'GMT' ? '+00:00' : zone.replace(/^GMT/, '');
    return {
      timestampLocal: `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${String(date.getUTCMilliseconds()).padStart(3, '0')}${offset}`,
      timeZone,
    };
  } catch {
    return { timestampLocal: date.toISOString(), timeZone: 'UTC (invalid LOG_TIME_ZONE)' };
  }
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const now = new Date();
  const record: LogRecord = { timestamp: now.toISOString(), ...localTimestamp(now), event, ...fields };
  records.push(record);
  if (records.length > MAX_LOG_RECORDS) records.splice(0, records.length - MAX_LOG_RECORDS);
  console.log(JSON.stringify(record));
}

export function getLogRecords(): LogRecord[] {
  return records.map(record => ({ ...record }));
}
