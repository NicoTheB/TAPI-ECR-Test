import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';

// Free persistent storage for data that must survive a Render free restart (its filesystem is
// ephemeral): terminal settings, the product catalog, and the payment history. It uses an Upstash
// Redis database through Upstash's REST API, so no extra npm package is needed. Configure with:
//
//   UPSTASH_REDIS_REST_URL     e.g. https://eu1-example-12345.upstash.io
//   UPSTASH_REDIS_REST_TOKEN   the database's REST token (read/write)
//   SETTINGS_ENCRYPTION_KEY    a passphrase of at least 16 characters. Terminal settings (which
//                              include JWTs) and the payment history (receipts) are encrypted with
//                              AES-256-GCM before they are sent, so Upstash only stores ciphertext.
//
// Without these variables everything keeps working with local files / memory, as before.

export class StoreError extends Error {}

const KEY_PREFIX = 'showroom-ecr:';
export const TERMINALS_KEY = `${KEY_PREFIX}terminals`;
export const PRODUCTS_KEY = `${KEY_PREFIX}products`;
export const historyKey = (terminalId: string) => `${KEY_PREFIX}history:${terminalId}`;

const REQUEST_TIMEOUT_MS = 8000;
const MIN_PASSPHRASE_LENGTH = 16;

export type StorageStatus = {
  remote: boolean;
  encrypted: boolean;
  terminals: 'remote' | 'local';
  products: 'remote' | 'local';
  history: 'remote' | 'memory';
  message: string;
};

type RemoteSettings = { config?: { url: string; token: string }; problem?: string };

function remoteSettings(): RemoteSettings {
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!rawUrl && !token) return {};
  if (!rawUrl || !token) return { problem: 'Both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.' };
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return { problem: 'UPSTASH_REDIS_REST_URL is not a valid URL.' }; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    return { problem: 'UPSTASH_REDIS_REST_URL must start with https://.' };
  }
  return { config: { url: url.toString().replace(/\/+$/, ''), token } };
}

function encryptionPhrase(): string | undefined {
  const value = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  return value && value.length >= MIN_PASSPHRASE_LENGTH ? value : undefined;
}

// The product catalog contains nothing secret, so it only needs the database.
export function productsStoredRemotely(): boolean {
  return Boolean(remoteSettings().config);
}

// Terminal settings contain credentials and the payment history contains receipts, so they are only
// stored remotely when they can be encrypted.
export function secretsStoredRemotely(): boolean {
  return Boolean(remoteSettings().config) && Boolean(encryptionPhrase());
}

export function storageStatus(): StorageStatus {
  const settings = remoteSettings();
  const remote = Boolean(settings.config);
  const encrypted = Boolean(encryptionPhrase());
  let message: string;
  if (settings.problem) {
    message = `${settings.problem} Settings are stored in a local file only, which is lost whenever the Render free service restarts.`;
  } else if (!remote) {
    message = 'Settings are stored in a local file only, and the payment history in memory. On Render free both are lost whenever the service restarts. Set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN and SETTINGS_ENCRYPTION_KEY to keep them (see the README).';
  } else if (!encrypted) {
    message = `Upstash is configured, but SETTINGS_ENCRYPTION_KEY is missing or shorter than ${MIN_PASSPHRASE_LENGTH} characters. The product catalog is saved in Upstash, but terminal settings (which include credentials) and the payment history are NOT sent to it and are lost on restart.`;
  } else {
    message = 'Saved to Upstash Redis: terminal settings, payment history and product catalog. Terminal settings and payment history are encrypted before they leave this server.';
  }
  return {
    remote,
    encrypted,
    terminals: remote && encrypted ? 'remote' : 'local',
    products: remote ? 'remote' : 'local',
    history: remote && encrypted ? 'remote' : 'memory',
    message,
  };
}

// A message that is safe to show in the UI and logs: never the token, a stored value or a stack.
export function safeMessage(error: unknown): string {
  if (error instanceof StoreError) return error.message;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'The stored data is not in the expected format.';
  return error instanceof Error ? error.message : 'Unexpected error.';
}

async function command(args: Array<string | number>): Promise<unknown> {
  const config = remoteSettings().config;
  if (!config) throw new StoreError('Persistent storage is not configured.');
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new StoreError(timedOut ? 'Persistent storage did not answer in time.' : 'Persistent storage could not be reached.');
  }
  const text = await response.text();
  let data: { result?: unknown; error?: unknown } | undefined;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!response.ok || data?.error) {
    // Never include the token or a stored value in the message.
    const detail = typeof data?.error === 'string' ? `: ${data.error.slice(0, 120)}` : '';
    throw new StoreError(`Persistent storage request failed (HTTP ${response.status}${detail}).`);
  }
  return data?.result;
}

async function remoteGet(key: string): Promise<string | null> {
  const result = await command(['GET', key]);
  return typeof result === 'string' ? result : null;
}

async function remoteSet(key: string, value: string): Promise<void> {
  const result = await command(['SET', key, value]);
  if (result !== 'OK') throw new StoreError('Persistent storage did not confirm the write.');
}

export async function deleteKey(key: string): Promise<void> {
  await command(['DEL', key]);
}

export function encryptText(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

export function decryptText(blob: string, passphrase: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(blob); }
  catch { throw new StoreError('The stored data is not in the expected format.'); }
  const { v, salt, iv, tag, data } = (parsed ?? {}) as { v?: unknown; salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
  if (v !== 1 || typeof salt !== 'string' || typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') {
    throw new StoreError('The stored data is not in the expected format.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(salt, 'base64'), 32), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new StoreError('The stored data could not be decrypted. Check that SETTINGS_ENCRYPTION_KEY has the same value that was used when it was saved.');
  }
}

// Encrypted values (terminal settings, payment history). Returns null when nothing is stored yet.
export async function loadEncrypted(key: string): Promise<string | null> {
  const passphrase = encryptionPhrase();
  if (!passphrase) throw new StoreError('SETTINGS_ENCRYPTION_KEY is missing or too short.');
  const blob = await remoteGet(key);
  return blob === null ? null : decryptText(blob, passphrase);
}

export async function saveEncrypted(key: string, plain: string): Promise<void> {
  const passphrase = encryptionPhrase();
  if (!passphrase) throw new StoreError('SETTINGS_ENCRYPTION_KEY is missing or too short.');
  await remoteSet(key, encryptText(plain, passphrase));
}

// Plain values (the product catalog).
export async function loadPlain(key: string): Promise<string | null> {
  return remoteGet(key);
}

export async function savePlain(key: string, value: string): Promise<void> {
  await remoteSet(key, value);
}

// ---------------------------------------------------------------------------------------------
// Payment history, one document per terminal.
//
// Holds what the backend otherwise only keeps in memory, so that after a restart you can still use
// "Get latest", look up a receipt and reverse an earlier payment:
//   - the approved payments (local receipt number, Transaction Reference, receipt text)
//   - the latest completed payment / reversal / capture of the terminal
//   - the local receipt counter, so receipt numbers do not start over
//   - the TERMINAL: / MERCHANT: values learned from the terminal's receipts
// The raw terminal responses are not kept, and the duplicate printer copy of the receipt text is
// rebuilt on load.

export type SavedTransactionData = {
  terminalId: string;
  receiptNumber: string;
  createdAt: string;
  result: Record<string, any>;
  originalTransaction?: { TransactionDateTime: string; TransactionReference: string };
};
export type HistoryIdentity = { terminalId?: string; merchantId?: string };
export type HistoryDoc = {
  v: 1;
  counter: number;
  identity?: HistoryIdentity;
  latest?: Record<string, any>;
  transactions: SavedTransactionData[];
};

export const MAX_SAVED_TRANSACTIONS = 100;
export const MAX_HISTORY_BYTES = 400_000;

const resultSchema = z.record(z.string(), z.any());
const historySchema = z.object({
  v: z.literal(1),
  counter: z.number().int().min(0),
  identity: z.object({ terminalId: z.string().optional(), merchantId: z.string().optional() }).optional(),
  latest: resultSchema.optional(),
  transactions: z.array(z.object({
    terminalId: z.string(),
    receiptNumber: z.string(),
    createdAt: z.string(),
    result: resultSchema,
    originalTransaction: z.object({ TransactionDateTime: z.string(), TransactionReference: z.string() }).optional(),
  })).max(500),
});

const AUDIENCES = ['customer', 'merchant'] as const;

// A result without the raw terminal response and without the duplicate printer copy of the text.
export function compactResult(result: Record<string, any>): Record<string, any> {
  const { worldlineResponse: _raw, ...rest } = result;
  if (rest.receipt && typeof rest.receipt === 'object') {
    const receipt: Record<string, any> = { ...rest.receipt };
    for (const audience of AUDIENCES) {
      if (receipt[audience] && typeof receipt[audience] === 'object') {
        const { escpos: _printerCopy, ...keep } = receipt[audience];
        receipt[audience] = keep;
      }
    }
    rest.receipt = receipt;
  }
  return rest;
}

// The reverse of compactResult for the receipt text the front end prints from.
export function expandResult(result: Record<string, any>): Record<string, any> {
  if (result.receipt && typeof result.receipt === 'object') {
    const receipt: Record<string, any> = { ...result.receipt };
    for (const audience of AUDIENCES) {
      const part = receipt[audience];
      if (part && typeof part === 'object' && typeof part.plain === 'string' && part.escpos === undefined) {
        receipt[audience] = { ...part, escpos: part.plain };
      }
    }
    return { ...result, receipt };
  }
  return result;
}

// Serialises a history document: newest transactions only, and small enough for one request.
export function serializeHistory(doc: HistoryDoc): string {
  const copy: HistoryDoc = {
    ...doc,
    latest: doc.latest ? compactResult(doc.latest) : undefined,
    transactions: doc.transactions.slice(-MAX_SAVED_TRANSACTIONS).map(item => ({ ...item, result: compactResult(item.result) })),
  };
  let text = JSON.stringify(copy);
  while (text.length > MAX_HISTORY_BYTES && copy.transactions.length > 1) {
    copy.transactions = copy.transactions.slice(Math.ceil(copy.transactions.length * 0.1));
    text = JSON.stringify(copy);
  }
  return text;
}

export function parseHistory(text: string): HistoryDoc {
  const parsed = historySchema.parse(JSON.parse(text));
  return {
    v: 1,
    counter: parsed.counter,
    ...(parsed.identity ? { identity: parsed.identity } : {}),
    ...(parsed.latest ? { latest: expandResult(parsed.latest) } : {}),
    transactions: parsed.transactions.map(item => ({ ...item, result: expandResult(item.result) })),
  };
}

// Combines what is stored with what happened in memory while the store could not be read.
// Receipt numbers handed out in that time can repeat stored ones; lookups by Transaction Reference
// are unaffected.
export function mergeHistory(stored: HistoryDoc | undefined, memory: HistoryDoc): HistoryDoc {
  if (!stored) return memory;
  const keyOf = (item: SavedTransactionData) => `${item.createdAt}|${item.originalTransaction?.TransactionReference ?? ''}`;
  const known = new Set(stored.transactions.map(keyOf));
  const identity = { ...stored.identity, ...memory.identity };
  const latest = memory.latest ?? stored.latest;
  return {
    v: 1,
    counter: Math.max(stored.counter, memory.counter),
    ...(identity.terminalId || identity.merchantId ? { identity } : {}),
    ...(latest ? { latest } : {}),
    transactions: [...stored.transactions, ...memory.transactions.filter(item => !known.has(keyOf(item)))],
  };
}
