/** Timestamped structured logs retained in a bounded, session-scoped export buffer. */
export type LogRecord = { timestamp: string; timestampLocal?: string; timeZone?: string; event: string; [key: string]: unknown };
const MAX_LOG_RECORDS = 5000;
const MAX_LOG_BYTES = 15 * 1024 * 1024;
const DEFAULT_LOG_TIME_ZONE = 'Europe/Copenhagen';
const records: Array<{ record: LogRecord; bytes: number }> = [];
let retainedBytes = 0;

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

/** Redact API credentials and per-operation webhook secrets from payload logs/exports. */
export function redactForLog(value: unknown, parentKey = ''): unknown {
  if (/(authorization|jwt|api.?key|secret|password|callback.?token|access.?token|refresh.?token)/i.test(parentKey)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redactForLog(item));
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) clean[key] = redactForLog(item, key);
    return clean;
  }
  if (typeof value === 'string') {
    return value.replace(/([?&]callbackToken=)[^&#\s"']+/gi, '$1[REDACTED]');
  }
  return value;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const now = new Date();
  const record: LogRecord = { timestamp: now.toISOString(), ...localTimestamp(now), event, ...fields };
  const line = JSON.stringify(record);
  const bytes = Buffer.byteLength(line, 'utf8');
  records.push({ record, bytes });
  retainedBytes += bytes;
  while (records.length > MAX_LOG_RECORDS || retainedBytes > MAX_LOG_BYTES) {
    const removed = records.shift();
    if (removed) retainedBytes -= removed.bytes;
  }
  console.log(line);
}

export function getLogRecords(): LogRecord[] {
  return records.map(({ record }) => ({ ...record }));
}
