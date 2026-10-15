import type { JsonReceiptLine } from './worldlineClient';

// Header block printed on the Showroom status slips (declined / aborted payments), in the same
// layout as the receipts the terminal prints:
//
//             Nico's Nightclub          (centred)
//              Sverigesgade 5
//              5000 Odense C
//              Tel.: 27798122
//             ORG.NR: 00000000
//
//   TERMINAL:                23AXMD884320
//   MERCHANT:                65856718 123456
//   DATE:2026-10-15              TIME:10:10
//
// The wording can be changed without touching the code:
//   RECEIPT_HEADER       lines separated by "|", e.g. "Nico's Nightclub|Sverigesgade 5|..."
//   RECEIPT_TERMINAL_ID  fallback for the TERMINAL: row
//   RECEIPT_MERCHANT_ID  fallback for the MERCHANT: row
// The TERMINAL: and MERCHANT: values are normally copied from the last real receipt the terminal
// returned (see learnReceiptIdentity); the environment values / defaults below are only used until
// one has been seen.

export type ReceiptIdentity = { terminalId?: string; merchantId?: string };

const DEFAULT_HEADER = ["Nico's Nightclub", 'Sverigesgade 5', '5000 Odense C', 'Tel.: 27798122', 'ORG.NR: 00000000'];
const DEFAULT_TERMINAL_ID = '23AXMD884320';
const DEFAULT_MERCHANT_ID = '65856718 123456';
const HEADER_WIDTH = 32;
const PLAIN_WIDTH = 34;

export function receiptHeaderLines(): string[] {
  const configured = process.env.RECEIPT_HEADER?.split('|').map(line => line.trim()).filter(Boolean);
  return configured && configured.length ? configured : DEFAULT_HEADER;
}

// Reads the TERMINAL: and MERCHANT: values out of a receipt text returned by the terminal.
export function learnReceiptIdentity(text: string): ReceiptIdentity {
  const found: ReceiptIdentity = {};
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = raw.trim().match(/^(TERMINAL|MERCHANT):\s*(.+)$/i);
    if (!match) continue;
    const value = match[2].trim().replace(/\s{2,}/g, ' ');
    if (!value) continue;
    if (match[1].toUpperCase() === 'TERMINAL') found.terminalId ??= value;
    else found.merchantId ??= value;
  }
  return found;
}

// Local date (YYYY-MM-DD) and time (HH:MM), in the same time zone as the structured logs.
export function localDateTime(now: Date): { date: string; time: string } {
  const timeZone = process.env.LOG_TIME_ZONE?.trim() || 'Europe/Copenhagen';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
  } catch {
    const iso = now.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

function wrapText(text: string, width: number): string[] {
  const result: string[] = [];
  let remaining = text.trim();
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(' ', width);
    if (splitAt < Math.floor(width * 0.55)) splitAt = width;
    result.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  result.push(remaining);
  return result;
}

const entry = (text: string, alignment: JsonReceiptLine['Alignment'], endOfLine = true): JsonReceiptLine => (
  { CharacterStyle: 'Normal', Alignment: alignment, EndOfLineFlag: endOfLine, Text: text }
);

// Header + TERMINAL / MERCHANT / DATE rows, followed by a blank line, as printer JSON lines.
export function receiptHeaderJson(identity: ReceiptIdentity | undefined, now: Date): JsonReceiptLine[] {
  const terminalId = identity?.terminalId || process.env.RECEIPT_TERMINAL_ID?.trim() || DEFAULT_TERMINAL_ID;
  const merchantId = identity?.merchantId || process.env.RECEIPT_MERCHANT_ID?.trim() || DEFAULT_MERCHANT_ID;
  const { date, time } = localDateTime(now);
  return [
    ...receiptHeaderLines().flatMap(line => wrapText(line, HEADER_WIDTH).map(part => entry(part, 'Centred'))),
    entry('', 'Left'),
    entry('TERMINAL:', 'Left', false), entry(terminalId, 'Right'),
    entry('MERCHANT:', 'Left', false), entry(merchantId, 'Right'),
    entry(`DATE:${date}`, 'Left', false), entry(`TIME:${time}`, 'Right'),
    entry('', 'Left'),
  ];
}

// Monospace text version of printer JSON lines (centred / left / right columns), used for
// "Print on this device" and for the on-screen receipt text.
export function renderLinesPlain(lines: JsonReceiptLine[], width = PLAIN_WIDTH): string {
  const out: string[] = [];
  let left: string | undefined;
  for (const line of lines) {
    const text = line.Text ?? '';
    if (line.EndOfLineFlag === false) { left = (left ?? '') + text; continue; }
    if (left !== undefined) {
      out.push(line.Alignment === 'Right' ? left + ' '.repeat(Math.max(1, width - left.length - text.length)) + text : left + text);
      left = undefined;
      continue;
    }
    if (line.Alignment === 'Centred') out.push(' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text);
    else if (line.Alignment === 'Right') out.push(' '.repeat(Math.max(0, width - text.length)) + text);
    else out.push(text);
  }
  if (left !== undefined) out.push(left);
  return out.join('\n');
}

// Header section followed by the slip content: returns both the printer JSON and the plain text.
export function buildStatusSlip(identity: ReceiptIdentity | undefined, now: Date, bodyLines: JsonReceiptLine[]): { json: JsonReceiptLine[]; plain: string } {
  const json = [...receiptHeaderJson(identity, now), ...bodyLines];
  return { json, plain: renderLinesPlain(json) };
}
