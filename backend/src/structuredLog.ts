/** Timestamped, redacted structured logs retained for a session-scoped JSON export. */
export type LogRecord = { timestamp: string; event: string; [key: string]: unknown };
const MAX_LOG_RECORDS = 5000;
const MAX_LOG_BYTES = 15 * 1024 * 1024;
const records: Array<{ record: LogRecord; bytes: number }> = [];
let retainedBytes = 0;

/** Redact bearer credentials and operation-specific callback secrets before any payload is logged/exported. */
export function redactForLog(value: unknown, parentKey = ''): unknown {
  if (/(authorization|jwt|api.?key|secret|password|callback.?token|access.?token|refresh.?token)/i.test(parentKey)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redactForLog(item));
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) clean[key] = redactForLog(item, key);
    return clean;
  }
  if (typeof value === 'string') {
    // Worldline carries our webhook callback credential as a query parameter inside Header.WebhookUrl.
    return value.replace(/([?&]callbackToken=)[^&#\s"']+/gi, '$1[REDACTED]');
  }
  return value;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const record: LogRecord = { timestamp: new Date().toISOString(), event, ...fields };
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
