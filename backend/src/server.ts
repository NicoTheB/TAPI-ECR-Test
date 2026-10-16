import express, { NextFunction, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { cloudConfig, safeTerminals, terminals, terminalConfigured, CloudTerminal } from './cloudConfig';
import { makeAbortRequest, makeDeviceFeatureRequest, makeFinancialRequest, makePrintRequest, makeReconciliationRequest, receiptTextToJson, worldlineRequest, WorldlineHttpError, WorldlineOperationKind } from './worldlineClient';
import type { JsonReceiptLine } from './worldlineClient';
import { deviceFeatureTemplates } from './deviceFeatures';
import { buildStatusSlip, learnReceiptIdentity } from './receiptHeader';
import type { ReceiptIdentity } from './receiptHeader';
import { applySavedTerminals, applyTerminalDocument, MAX_TERMINALS, nextTerminalId, removedAfterRemoving, removeTerminalById } from './terminalSettings';
import type { TerminalDocument } from './terminalSettings';
import { deleteKey, historyKey, loadEncrypted, loadPlain, mergeHistory, parseHistory, PRODUCTS_KEY, productsStoredRemotely, safeMessage, saveEncrypted, savePlain, secretsStoredRemotely, serializeHistory, StoreError, storageStatus, TERMINALS_KEY } from './persistentStore';
import type { HistoryDoc } from './persistentStore';
import { getLogRecords, logEvent, redactForLog } from './structuredLog';

const app = express();
app.use(express.json({ limit: '512kb' }));

// Log API metadata only. Do not log bodies, cookies or authorization headers: requests/responses
// can contain JWTs, customer data, and payment receipt/card information.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) { next(); return; }
  const requestId = req.get('X-Request-ID') || randomUUID();
  const startedAt = Date.now();
  res.setHeader('X-Request-ID', requestId);
  logEvent('http_api_request', { requestId, method: req.method, path: req.path });
  res.on('finish', () => logEvent('http_api_response', {
    requestId,
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs: Date.now() - startedAt,
  }));
  next();
});

const moneySchema = z.object({
  terminalId: z.string().min(1),
  amount: z.number().positive().max(2_000_000_000),
  currencySymbol: z.string().trim().length(3).transform(value => value.toUpperCase()),
  minorUnitDivisor: z.number().int().positive().max(1000).optional(),
  cashierId: z.string().trim().min(1).max(35).optional(),
});
const reversalSchema = z.object({ terminalId: z.string().min(1), receiptNumber: z.string().trim().min(1).max(64) });
const reconciliationSchema = z.object({
  terminalId: z.string().min(1),
  sendCaptureEmail: z.boolean().optional(),
  captureEmail: z.string().trim().email().max(254).optional(),
}).superRefine((value, context) => {
  if (value.sendCaptureEmail && !value.captureEmail) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['captureEmail'], message: 'Enter an email address when capture-result email is enabled.' });
  }
});
const jsonReceiptLineSchema = z.object({ CharacterStyle: z.enum(['Normal', 'Bold']).optional(), Alignment: z.enum(['Left', 'Right', 'Centred']).optional(), EndOfLineFlag: z.boolean().optional(), Text: z.string().max(2000).optional(), FontSize: z.number().int().min(1).max(128).optional() });
const printSchema = z.object({ terminalId: z.string().min(1), receiptData: z.string().min(1).max(20000).optional(), outputJSON: z.array(jsonReceiptLineSchema).min(1).max(500).optional() }).refine(value => Boolean(value.receiptData?.trim() || value.outputJSON?.length), 'Provide receipt text or JSON receipt lines.');
const deviceFeatureSchema = z.object({
  terminalId: z.string().min(1),
  featureId: z.string().min(1).max(80),
  deviceRequest: z.record(z.unknown()).refine(value => Boolean(value.InputRequest || value.PrintRequest), 'DeviceRequest must include InputRequest or PrintRequest.'),
});
const productCatalogSchema = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  minorUnitDivisor: z.union([z.literal(1), z.literal(10), z.literal(100), z.literal(1000)]),
  products: z.array(z.object({
    id: z.string().trim().min(1).max(48).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(48),
    priceMinor: z.number().int().positive().max(2_000_000_000),
    description: z.string().trim().max(160).optional(),
    image: z.string().trim().max(512).optional(),
  })).max(250),
});

type OperationState = 'starting' | 'pending' | 'unknown' | 'abort-requested' | 'completed' | 'failed';
type Operation = {
  operationId: string;
  terminalId: string;
  kind: WorldlineOperationKind;
  state: OperationState;
  createdAt: string;
  result?: Record<string, any> | null;
  message?: string;
  callbackToken: string;
  exchangeId: string;
  requestId?: string;
  abortRequestId?: string;
  captureEmail?: string;
  requestedAmountMinor?: number;
  requestedCurrency?: string;
  reversalOf?: { TransactionDateTime: string; TransactionReference: string };
};
type SavedTransaction = {
  terminalId: string;
  receiptNumber: string;
  createdAt: string;
  result: Record<string, any>;
  originalTransaction?: { TransactionDateTime: string; TransactionReference: string };
};
const operations = new Map<string, Operation>();
const activeByTerminal = new Map<string, string>();
const transactions = new Map<string, SavedTransaction[]>();
const latestPayment = new Map<string, Record<string, any>>();
// TERMINAL: / MERCHANT: values copied from the last real receipt of each terminal, for the status slips.
const terminalIdentity = new Map<string, ReceiptIdentity>();
const receiptCounters = new Map<string, number>();
const failedAdminAttempts = new Map<string, { count: number; until: number }>();

function chosenTerminal(id: unknown): CloudTerminal | undefined {
  if (typeof id === 'string' && id) return terminals.find(terminal => terminal.id === id);
  return terminals.length === 1 ? terminals[0] : undefined;
}
function publicOperation(operation: Operation) {
  const { callbackToken: _secret, exchangeId: _exchange, captureEmail: _email, ...safe } = operation;
  return safe;
}
function requireTerminal(id: unknown, res: Response): CloudTerminal | undefined {
  const terminal = chosenTerminal(id);
  if (!terminal) {
    res.status(400).json({ error: 'Select one of the configured Worldline terminals.' });
    return undefined;
  }
  if (!terminalConfigured(terminal)) {
    const suffix = terminal.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    res.status(503).json({ error: `Terminal ${terminal.label} is not configured. Add TERMINAL_${suffix}_UMID, TERMINAL_${suffix}_UTID, and TERMINAL_${suffix}_JWT to the backend environment.` });
    return undefined;
  }
  return terminal;
}
function compareSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!cloudConfig.adminPin) {
    res.status(503).json({ error: 'Product settings are locked. Configure ADMIN_PIN in the backend environment.' });
    return;
  }
  const ip = req.ip || 'unknown';
  const failure = failedAdminAttempts.get(ip);
  if (failure && failure.until > Date.now()) {
    res.status(429).json({ error: 'Too many incorrect PIN attempts. Wait one minute and try again.' });
    return;
  }
  if (!compareSecret(req.get('X-Admin-Pin') ?? '', cloudConfig.adminPin)) {
    const count = (failure?.count ?? 0) + 1;
    failedAdminAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    res.status(401).json({ error: 'Incorrect settings PIN.' });
    return;
  }
  failedAdminAttempts.delete(ip);
  next();
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
// Settings changes run one at a time so two quick requests cannot overwrite each other.
let settingsQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = settingsQueue.then(() => task());
  settingsQueue = run.catch(() => undefined);
  return run;
}

// With persistent storage the product catalog is kept in memory after it has been loaded.
let productCatalogCache: z.infer<typeof productCatalogSchema> | undefined;
let productStoreLoaded = !productsStoredRemotely();
let productStoreError = '';
async function loadRemoteProductCatalog() {
  if (!productsStoredRemotely()) return;
  try {
    const text = await loadPlain(PRODUCTS_KEY);
    if (text !== null) {
      productCatalogCache = productCatalogSchema.parse(JSON.parse(text));
      logEvent('product_catalog_loaded', { source: 'persistent_storage', products: productCatalogCache.products.length });
    }
    productStoreLoaded = true;
    productStoreError = '';
  } catch (error) {
    productStoreLoaded = false;
    productStoreError = safeMessage(error);
    logEvent('product_catalog_load_failed', { error: productStoreError });
  }
}
// Saving over a catalog that could not be read could destroy it, so read it again first.
async function ensureProductStore() {
  if (!productsStoredRemotely() || productStoreLoaded) return;
  await loadRemoteProductCatalog();
  if (!productStoreLoaded) throw new StoreError(`Persistent storage is not reachable, so the product catalog cannot be saved right now. ${productStoreError}`.trim());
  if (productCatalogCache) throw new HttpError(409, 'The saved product catalog was just loaded from persistent storage. Reload this page, unlock the catalog again and repeat your edits.');
}
async function saveProductCatalog(catalog: z.infer<typeof productCatalogSchema>) {
  if (productsStoredRemotely()) {
    await savePlain(PRODUCTS_KEY, JSON.stringify(catalog));
    productCatalogCache = catalog;
    return;
  }
  writeProductCatalog(catalog);
}

function readProductCatalog() {
  if (productCatalogCache) return productCatalogCache;
  const persisted = path.resolve(process.cwd(), cloudConfig.productsFile);
  const starter = path.resolve(process.cwd(), 'public/products.json');
  const file = existsSync(persisted) ? persisted : starter;
  if (!existsSync(file)) throw new Error(`Product catalog not found: ${file}`);
  return productCatalogSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
function writeProductCatalog(catalog: z.infer<typeof productCatalogSchema>) {
  const output = path.resolve(process.cwd(), cloudConfig.productsFile);
  mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, output);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, provider: 'Worldline Terminal API' }));
app.get('/api/config', (_req, res) => res.json({
  terminalConfigured: terminals.some(terminalConfigured),
  settingsEnabled: Boolean(cloudConfig.adminPin),
  terminals: safeTerminals(),
  pollIntervalMs: 1200,
  worldlinePayloadLogging: cloudConfig.logWorldlinePayloads,
  webhookMode: (() => { try { return new URL(cloudConfig.webhookBaseUrl).hostname; } catch { return 'invalid'; } })(),
}));
app.get('/api/device/features', (_req, res) => res.json({ features: deviceFeatureTemplates }));
app.get('/api/products', (_req, res) => {
  try { res.json(readProductCatalog()); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not load product catalog.' }); }
});
app.get('/api/admin/products', requireAdmin, (_req, res) => {
  try { res.json(readProductCatalog()); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not load product catalog.' }); }
});
app.put('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const catalog = productCatalogSchema.parse(req.body);
    const ids = catalog.products.map(product => product.id.toLowerCase());
    if (new Set(ids).size !== ids.length) { res.status(400).json({ error: 'Product IDs must be unique.' }); return; }
    await serialized(async () => {
      await ensureProductStore();
      await saveProductCatalog(catalog);
    });
    res.json(catalog);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid product catalog.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
      return;
    }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(error instanceof StoreError ? 502 : 400).json({ error: error instanceof Error ? error.message : 'Could not save product catalog.' });
  }
});

// Full terminal settings are editable behind ADMIN_PIN. JWTs are stored server-side only;
// the settings GET response exposes a configured flag, never the bearer token itself.
// Full cloud terminal settings are editable behind ADMIN_PIN. JWTs are write-only over the API.
const terminalRecordSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  initiatingParty: z.string().trim().min(1).max(35),
  poiId: z.string().trim().max(80),
  umid: z.string().trim().max(128).optional(),
  utid: z.string().trim().max(128).optional(),
  jwt: z.string().trim().max(16384).optional(),
});
const terminalFileSchema = z.object({
  terminals: z.array(terminalRecordSchema).max(50),
  removed: z.array(z.string().min(1).max(32)).max(200).default([]),
});
const terminalSettingsInputSchema = z.array(z.object({
  id: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  initiatingParty: z.string().trim().min(1).max(35),
  poiId: z.string().trim().max(80),
  umid: z.string().trim().max(128),
  utid: z.string().trim().max(128),
  jwt: z.string().trim().max(16384).optional(),
  clearJwt: z.boolean().optional(),
})).min(1).max(50);
type PersistedTerminalSettings = z.infer<typeof terminalRecordSchema>;

function publicTerminalSettings() {
  return terminals.map(terminal => ({
    id: terminal.id, name: terminal.name, label: terminal.label,
    initiatingParty: terminal.initiatingParty, poiId: terminal.poiId,
    umid: terminal.umid, utid: terminal.utid,
    jwtConfigured: Boolean(terminal.jwt), configured: terminalConfigured(terminal),
  }));
}

// ---- Saved terminal settings ------------------------------------------------------------------
// With UPSTASH_REDIS_REST_URL / _TOKEN / SETTINGS_ENCRYPTION_KEY set, they live in Upstash Redis
// (encrypted) and the local file is not used. Otherwise they are kept in a local file, which on
// Render free is lost whenever the service restarts.
let terminalDoc: TerminalDocument = { terminals: [], removed: [] };
let terminalStoreLoaded = !secretsStoredRemotely();
let terminalStoreError = '';

function parseTerminalDocument(raw: unknown): TerminalDocument {
  // Older versions saved a plain array of terminal records.
  if (Array.isArray(raw)) return { terminals: z.array(terminalRecordSchema).max(50).parse(raw), removed: [] };
  return terminalFileSchema.parse(raw);
}
function readLocalTerminalDocument(): TerminalDocument | undefined {
  const file = path.resolve(process.cwd(), cloudConfig.terminalSettingsFile);
  if (!existsSync(file)) return undefined;
  return parseTerminalDocument(JSON.parse(readFileSync(file, 'utf8')));
}
function writeLocalTerminalDocument(doc: TerminalDocument) {
  const output = path.resolve(process.cwd(), cloudConfig.terminalSettingsFile);
  mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, output);
}
async function loadTerminalSettings() {
  let doc: TerminalDocument | undefined;
  if (secretsStoredRemotely()) {
    try {
      const text = await loadEncrypted(TERMINALS_KEY);
      if (text !== null) {
        doc = parseTerminalDocument(JSON.parse(text));
        logEvent('terminal_settings_loaded', { source: 'persistent_storage', savedTerminals: doc.terminals.length, removedTerminals: doc.removed.length });
      } else {
        // First start with persistent storage: carry over a local file if there is one.
        doc = readLocalTerminalDocument();
        if (doc) {
          await saveEncrypted(TERMINALS_KEY, JSON.stringify(doc));
          logEvent('terminal_settings_seeded', { source: 'local_file', savedTerminals: doc.terminals.length });
        }
      }
      terminalStoreLoaded = true;
      terminalStoreError = '';
    } catch (error) {
      // Keep running with the terminals from the environment settings, but block changes until
      // the saved settings can be read, so they are never overwritten.
      terminalStoreLoaded = false;
      terminalStoreError = safeMessage(error);
      logEvent('terminal_settings_load_failed', { error: terminalStoreError });
      doc = undefined;
    }
  } else {
    doc = readLocalTerminalDocument();
  }
  if (!doc) return;
  terminalDoc = doc;
  applyTerminalDocument(terminals, doc);
}
async function ensureTerminalStore() {
  if (!secretsStoredRemotely() || terminalStoreLoaded) return;
  await loadTerminalSettings();
  if (!terminalStoreLoaded) throw new StoreError(`Persistent storage is not reachable, so terminal settings cannot be changed right now. ${terminalStoreError}`.trim());
  throw new HttpError(409, 'The saved terminal settings were just loaded from persistent storage. Reload this page, unlock Terminal settings again and repeat your change.');
}
async function persistTerminalDocument(doc: TerminalDocument) {
  if (secretsStoredRemotely()) {
    await ensureTerminalStore();
    await saveEncrypted(TERMINALS_KEY, JSON.stringify(doc));
  } else {
    writeLocalTerminalDocument(doc);
  }
  terminalDoc = doc;
}

// ---- Payment history in persistent storage ------------------------------------------------------
// One encrypted document per terminal (see persistentStore.ts). It is loaded at start-up, saved
// after every payment, refund, reversal and capture, and never written before it has been read, so
// stored history cannot be overwritten by an empty one.
type HistoryState = { loaded: boolean; running: boolean; again: boolean; loading?: Promise<boolean>; current?: Promise<void>; error?: string };
const historyState = new Map<string, HistoryState>();
function historyStateFor(id: string): HistoryState {
  let state = historyState.get(id);
  if (!state) { state = { loaded: false, running: false, again: false }; historyState.set(id, state); }
  return state;
}
function buildHistoryDoc(id: string): HistoryDoc {
  const identity = terminalIdentity.get(id);
  const latest = latestPayment.get(id);
  return { v: 1, counter: receiptCounters.get(id) ?? 0, ...(identity ? { identity } : {}), ...(latest ? { latest } : {}), transactions: transactions.get(id) ?? [] };
}
function applyHistoryDoc(id: string, doc: HistoryDoc) {
  transactions.set(id, doc.transactions);
  receiptCounters.set(id, doc.counter);
  if (doc.latest) latestPayment.set(id, doc.latest);
  if (doc.identity) terminalIdentity.set(id, doc.identity);
}
function loadHistory(id: string): Promise<boolean> {
  if (!secretsStoredRemotely()) return Promise.resolve(true);
  const state = historyStateFor(id);
  if (state.loaded) return Promise.resolve(true);
  if (state.loading) return state.loading;
  const pending = (async () => {
    try {
      const text = await loadEncrypted(historyKey(id));
      const stored = text === null ? undefined : parseHistory(text);
      const hadMemory = (transactions.get(id)?.length ?? 0) > 0 || latestPayment.has(id);
      applyHistoryDoc(id, mergeHistory(stored, buildHistoryDoc(id)));
      state.loaded = true;
      state.error = undefined;
      logEvent('payment_history_loaded', { terminalId: id, transactions: transactions.get(id)?.length ?? 0 });
      // Anything that happened while the store could not be read is saved now.
      if (hadMemory) scheduleHistorySave(id);
      return true;
    } catch (error) {
      state.error = safeMessage(error);
      logEvent('payment_history_load_failed', { terminalId: id, error: state.error });
      return false;
    } finally {
      state.loading = undefined;
    }
  })();
  state.loading = pending;
  return pending;
}
async function ensureHistoryLoaded(id: string): Promise<void> {
  await loadHistory(id);
}
// A message for when earlier payments cannot be shown because the stored history could not be read.
function historyProblem(id: string): string | undefined {
  if (!secretsStoredRemotely()) return undefined;
  const state = historyStateFor(id);
  if (state.loaded) return undefined;
  return `The payment history could not be read from persistent storage (${state.error ?? 'unknown reason'}), so earlier payments are not available right now. Try again shortly.`;
}
function scheduleHistorySave(id: string) {
  if (!secretsStoredRemotely()) return;
  const state = historyStateFor(id);
  if (state.running) { state.again = true; return; }
  state.running = true;
  state.current = (async () => {
    try {
      do {
        if (!terminals.some(terminal => terminal.id === id)) return;
        // Never overwrite stored history that could not be read.
        if (!state.loaded && !(await loadHistory(id))) return;
        state.again = false;
        await saveEncrypted(historyKey(id), serializeHistory(buildHistoryDoc(id)));
        state.error = undefined;
      } while (state.again);
    } catch (error) {
      state.error = safeMessage(error);
      logEvent('payment_history_save_failed', { terminalId: id, error: state.error });
    } finally {
      state.running = false;
    }
  })();
}
// A terminal that has just been added has no stored history to read.
function markHistoryFresh(id: string) {
  historyStateFor(id).loaded = true;
}
// Everything the backend remembers about a terminal that was removed, including its stored history.
async function forgetTerminal(id: string) {
  const state = historyState.get(id);
  transactions.delete(id);
  latestPayment.delete(id);
  receiptCounters.delete(id);
  terminalIdentity.delete(id);
  historyState.delete(id);
  if (!secretsStoredRemotely()) return;
  await state?.current; // let a save that is still running finish first, so it cannot bring the key back
  try { await deleteKey(historyKey(id)); }
  catch (error) { logEvent('payment_history_delete_failed', { terminalId: id, error: safeMessage(error) }); }
}

function storageInfo() {
  const status = storageStatus();
  const warnings: string[] = [];
  if (secretsStoredRemotely() && !terminalStoreLoaded) warnings.push(`Saved terminal settings could not be read (${terminalStoreError}). Changes are blocked until persistent storage can be read.`);
  if (productsStoredRemotely() && !productStoreLoaded) warnings.push(`The saved product catalog could not be read (${productStoreError}).`);
  if (secretsStoredRemotely()) {
    const failing = terminals.filter(terminal => historyState.get(terminal.id)?.error);
    if (failing.length) warnings.push(`Payment history problem for ${failing.map(terminal => terminal.label).join(', ')}: ${historyState.get(failing[0].id)?.error}`);
  }
  return { ...status, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
}
function sendAdminError(res: Response, error: unknown, fallback: string, event: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid terminal settings.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
    return;
  }
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
  logEvent(event, { error: safeMessage(error) });
  res.status(error instanceof StoreError ? 502 : 400).json({ error: error instanceof Error ? error.message : fallback });
}

app.get('/api/admin/terminals', requireAdmin, (_req, res) => res.json({ terminals: publicTerminalSettings(), storage: storageInfo() }));
app.put('/api/admin/terminals', requireAdmin, async (req, res) => {
  if (activeByTerminal.size) { res.status(409).json({ error: 'Finish all active terminal operations before saving settings.' }); return; }
  try {
    const input = terminalSettingsInputSchema.parse(req.body?.terminals);
    await serialized(async () => {
      await ensureTerminalStore();
      const ids = input.map(record => record.id.toLowerCase());
      if (new Set(ids).size !== ids.length || ids.length !== terminals.length || terminals.some(terminal => !ids.includes(terminal.id.toLowerCase()))) {
        throw new HttpError(400, 'Keep the configured terminal IDs unchanged and include each terminal exactly once.');
      }
      const records: PersistedTerminalSettings[] = input.map(({ clearJwt, jwt, ...record }) => {
        const current = terminals.find(terminal => terminal.id === record.id)!;
        return { ...record, poiId: record.poiId.trim() || current.poiId, jwt: clearJwt ? '' : (jwt?.trim() || current.jwt) };
      });
      await persistTerminalDocument({ terminals: records, removed: terminalDoc.removed });
      for (const record of records) {
        const terminal = terminals.find(item => item.id === record.id)!;
        terminal.name = record.name; terminal.label = record.label;
        terminal.initiatingParty = record.initiatingParty; terminal.poiId = record.poiId.trim() || terminal.poiId;
        terminal.umid = record.umid ?? ''; terminal.utid = record.utid ?? ''; terminal.jwt = record.jwt ?? '';
      }
      logEvent('terminal_settings_updated', { terminalIds: records.map(record => record.id), configuredCount: records.filter(record => Boolean(record.umid && record.utid && record.jwt)).length });
    });
    res.json({ terminals: publicTerminalSettings(), storage: storageInfo() });
  } catch (error) {
    sendAdminError(res, error, 'Could not save terminal settings.', 'terminal_settings_save_failed');
  }
});

const terminalAddSchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  initiatingParty: z.string().trim().max(35).optional(),
  poiId: z.string().trim().max(80).optional(),
  umid: z.string().trim().max(128).optional(),
  utid: z.string().trim().max(128).optional(),
  jwt: z.string().trim().max(16384).optional(),
});
app.post('/api/admin/terminals', requireAdmin, async (req, res) => {
  try {
    const input = terminalAddSchema.parse(req.body);
    const added = await serialized(async () => {
      await ensureTerminalStore();
      if (terminals.length >= MAX_TERMINALS) throw new HttpError(400, `At most ${MAX_TERMINALS} terminals are supported.`);
      const id = nextTerminalId(terminals, terminalDoc.removed);
      const record: PersistedTerminalSettings = {
        id,
        name: input.name,
        label: input.label,
        initiatingParty: input.initiatingParty || `Showroom-${id}`,
        poiId: input.poiId ?? '',
        umid: input.umid ?? '',
        utid: input.utid ?? '',
        jwt: input.jwt ?? '',
      };
      // Save first, then add to the live list, so a failed write leaves nothing half-added.
      await persistTerminalDocument({
        terminals: [...terminalDoc.terminals.filter(item => item.id !== id), record],
        removed: terminalDoc.removed.filter(item => item.toLowerCase() !== id.toLowerCase()),
      });
      applySavedTerminals(terminals, [record]);
      markHistoryFresh(id);
      logEvent('terminal_added', { terminalId: id, configured: Boolean(record.umid && record.utid && record.jwt) });
      return id;
    });
    res.status(201).json({ terminals: publicTerminalSettings(), added, storage: storageInfo() });
  } catch (error) {
    sendAdminError(res, error, 'Could not add the terminal.', 'terminal_add_failed');
  }
});
app.delete('/api/admin/terminals/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id ?? '');
  try {
    await serialized(async () => {
      await ensureTerminalStore();
      if (!terminals.some(terminal => terminal.id === id)) throw new HttpError(404, 'No terminal with that ID.');
      if (terminals.length <= 1) throw new HttpError(400, 'At least one terminal must remain.');
      if (activeByTerminal.has(id)) throw new HttpError(409, 'This terminal has an active operation. Finish or abort it before removing the terminal.');
      // Save first, then remove from the live list, so a failed write leaves the terminal in place.
      await persistTerminalDocument({
        terminals: terminalDoc.terminals.filter(record => record.id !== id),
        removed: removedAfterRemoving(terminalDoc.removed, id),
      });
      removeTerminalById(terminals, id);
      await forgetTerminal(id);
      logEvent('terminal_removed', { terminalId: id });
    });
    res.json({ terminals: publicTerminalSettings(), removed: id, storage: storageInfo() });
  } catch (error) {
    sendAdminError(res, error, 'Could not remove the terminal.', 'terminal_remove_failed');
  }
});

app.get('/api/admin/logs', requireAdmin, (_req, res) => {
  res.json({ exportedAt: new Date().toISOString(), records: getLogRecords() });
});

app.get('/api/operations/current', (req, res) => {
  const terminal = chosenTerminal(req.query.terminalId);
  if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
  const id = activeByTerminal.get(terminal.id);
  const operation = id ? operations.get(id) : undefined;
  res.json(operation ? publicOperation(operation) : null);
});
app.post('/api/operations/payment', (req, res) => void startOperation('payment', req, res));
app.post('/api/operations/refund', (req, res) => void startOperation('refund', req, res));
app.post('/api/operations/reversal', (req, res) => void startOperation('reversal', req, res));
app.post('/api/operations/reconciliation', (req, res) => void startOperation('reconciliation', req, res));
app.post('/api/operations/capture', (req, res) => void startOperation('reconciliation', req, res));
app.post('/api/operations/print', (req, res) => void startOperation('print', req, res));
app.post('/api/operations/device', (req, res) => void startOperation('device', req, res));

async function startOperation(kind: WorldlineOperationKind, req: Request, res: Response) {
  let input: z.infer<typeof moneySchema> | z.infer<typeof reversalSchema> | z.infer<typeof reconciliationSchema> | z.infer<typeof printSchema> | z.infer<typeof deviceFeatureSchema>;
  try {
    input = kind === 'payment' || kind === 'refund' ? moneySchema.parse(req.body) : kind === 'reversal' ? reversalSchema.parse(req.body) : kind === 'reconciliation' ? reconciliationSchema.parse(req.body) : kind === 'device' ? deviceFeatureSchema.parse(req.body) : printSchema.parse(req.body);
  } catch (error) {
    const issues = error instanceof z.ZodError ? error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) : [];
    res.status(400).json({ error: 'Invalid operation request.', details: issues });
    return;
  }
  if (kind === 'reconciliation' && (input as z.infer<typeof reconciliationSchema>).sendCaptureEmail) {
    if (!cloudConfig.resendApiKey || !cloudConfig.captureEmailFrom) {
      res.status(503).json({ error: 'Capture email is enabled for this request, but RESEND_API_KEY and CAPTURE_EMAIL_FROM are not configured on the backend.' });
      return;
    }
  }
  const terminal = requireTerminal(input.terminalId, res);
  if (!terminal) return;
  // A reversal looks up an earlier payment, which may have to be loaded from persistent storage first.
  if (kind === 'reversal') await ensureHistoryLoaded(terminal.id);
  const currentId = activeByTerminal.get(terminal.id);
  if (currentId) {
    res.status(409).json({ error: `Terminal ${terminal.label} already has an active operation. Finish or abort it first.`, operationId: currentId });
    return;
  }

  let originalTransaction: SavedTransaction | undefined;
  if (kind === 'reversal') {
    const receipt = (input as z.infer<typeof reversalSchema>).receiptNumber;
    originalTransaction = (transactions.get(terminal.id) ?? []).find(item => item.receiptNumber === receipt || item.originalTransaction?.TransactionReference === receipt);
    if (!originalTransaction?.originalTransaction) {
      const problem = historyProblem(terminal.id);
      if (problem) { res.status(503).json({ error: problem }); return; }
      res.status(404).json({ error: 'No saved payment matches that transaction reference. Reversal requires an original payment recorded by this showroom backend.' });
      return;
    }
  }

  const operationId = randomUUID();
  const callbackToken = randomUUID();
  const operation: Operation = {
    operationId,
    terminalId: terminal.id,
    kind,
    state: 'starting',
    createdAt: new Date().toISOString(),
    callbackToken,
    exchangeId: operationId,
    ...(kind === 'reconciliation' && (input as z.infer<typeof reconciliationSchema>).sendCaptureEmail
      ? { captureEmail: (input as z.infer<typeof reconciliationSchema>).captureEmail }
      : {}),
    ...(kind === 'payment' || kind === 'refund' ? {
      requestedAmountMinor: (input as z.infer<typeof moneySchema>).amount,
      requestedCurrency: (input as z.infer<typeof moneySchema>).currencySymbol,
    } : {}),
    ...(kind === 'reversal' && originalTransaction?.originalTransaction ? { reversalOf: originalTransaction.originalTransaction } : {}),
  };
  let payload: unknown;
  try {
    if (kind === 'payment' || kind === 'refund') {
      const value = input as z.infer<typeof moneySchema>;
      payload = makeFinancialRequest(terminal, kind, operationId, callbackToken, {
        amount: value.amount,
        currency: value.currencySymbol,
        minorUnitDivisor: value.minorUnitDivisor,
      });
    } else if (kind === 'reversal') {
      payload = makeFinancialRequest(terminal, 'reversal', operationId, callbackToken, { originalTransaction: originalTransaction!.originalTransaction });
    } else if (kind === 'reconciliation') {
      payload = makeReconciliationRequest(terminal, operationId, callbackToken);
    } else if (kind === 'device') {
      const deviceInput = input as z.infer<typeof deviceFeatureSchema>;
      if (!deviceFeatureTemplates.some(feature => feature.id === deviceInput.featureId)) {
        throw new Error('Select a supported Worldline Device feature.');
      }
      payload = makeDeviceFeatureRequest(terminal, operationId, callbackToken, deviceInput.deviceRequest);
    } else {
      const printInput = input as z.infer<typeof printSchema>;
      payload = makePrintRequest(terminal, operationId, callbackToken, printInput.receiptData, printInput.outputJSON as JsonReceiptLine[] | undefined);
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not prepare Worldline request.' });
    return;
  }

  operations.set(operationId, operation);
  activeByTerminal.set(terminal.id, operationId);
  try {
    const endpoint = kind === 'print' || kind === 'device' ? 'device' : kind === 'reconciliation' ? 'reconciliation' : 'payments';
    const reply = await worldlineRequest<any>(terminal, endpoint, payload);
    operation.requestId = reply.data?.requestId;
    if (reply.data?.data) {
      completeOperation(operation, reply.data);
    } else {
      operation.state = 'pending';
      operation.message = 'Request accepted by Worldline. Waiting for the terminal response at the configured webhook.';
    }
    res.status(202).json(publicOperation(operation));
  } catch (error) {
    operation.message = error instanceof Error ? error.message : 'Worldline request failed.';
    if (error instanceof WorldlineHttpError) {
      operation.state = 'failed';
      activeByTerminal.delete(terminal.id);
      res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({ error: operation.message, operation: publicOperation(operation) });
      return;
    }
    operation.state = 'unknown';
    res.status(202).json(publicOperation(operation));
  }
}

app.get('/api/operations/:operationId', (req, res) => {
  const operation = operations.get(req.params.operationId);
  if (!operation) { res.status(404).json({ error: 'Operation not found in this backend session.' }); return; }
  res.json(publicOperation(operation));
});
app.post('/api/operations/:operationId/abort', async (req, res) => {
  const operation = operations.get(req.params.operationId);
  if (!operation || activeByTerminal.get(operation.terminalId) !== operation.operationId) {
    res.status(404).json({ error: 'No active operation with that ID.' }); return;
  }
  if (operation.kind === 'print') { res.status(409).json({ error: 'Abort is available for ongoing payment operations, not a receipt-print request.' }); return; }
  if (!['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state)) {
    res.status(409).json({ error: 'This operation is no longer in progress.' }); return;
  }
  const terminal = terminals.find(item => item.id === operation.terminalId)!;
  try {
    const payload = makeAbortRequest(terminal);
    const abortMessage = (payload as any).SaleToPOIAbort;
    const abortHeaderExchangeId = abortMessage.Header.ExchangeIdentification;
    const systemAbortExchangeId = abortMessage.Abort.SystemAbort.ExchangeIdentification;
    const acknowledgement = await worldlineRequest<{ requestId?: string }>(terminal, 'payments/abort', payload);
    operation.abortRequestId = acknowledgement.data?.requestId;
    operation.state = 'abort-requested';
    operation.message = 'Worldline accepted the abort signal. This diagnostic request uses fresh IDs in both abort fields; check the final payment webhook to see whether the terminal cancels.';
    logEvent('worldline_abort_accepted', {
      operationId: operation.operationId,
      terminalId: operation.terminalId,
      originalPaymentExchangeId: operation.exchangeId,
      abortHeaderExchangeId,
      systemAbortExchangeId,
      idsAreDistinct: abortHeaderExchangeId !== systemAbortExchangeId && systemAbortExchangeId !== operation.exchangeId,
      abortRequestId: operation.abortRequestId,
    });
    res.json(publicOperation(operation));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Abort request failed.';
    logEvent('worldline_abort_failed', { operationId: operation.operationId, terminalId: operation.terminalId, error: message });
    res.status(error instanceof WorldlineHttpError ? error.status : 502).json({ error: message, operation: publicOperation(operation) });
  }
});

// Worldline POSTs final Nexo envelopes here when WORLDLINE_WEBHOOK_URL points at this service.
// webhook.site is an inspector only: it cannot update this backend's in-memory operation state.
app.post('/api/worldline/webhook', (req, res) => {
  const operationId = typeof req.query.operationId === 'string' ? req.query.operationId : '';
  const callbackToken = typeof req.query.callbackToken === 'string' ? req.query.callbackToken : '';
  const operation = operations.get(operationId);
  if (!operation || !compareSecret(callbackToken, operation.callbackToken)) {
    res.status(404).json({ error: 'Unknown or invalid webhook operation.' });
    return;
  }
  if (operation.state === 'completed') { res.status(200).json({ ok: true, duplicate: true }); return; }
  // Async Worldline endpoints return an acknowledgement; the final terminal response arrives here.
  // Full callback logging is opt-in because response payloads may include receipt/payment data.
  if (cloudConfig.logWorldlinePayloads) {
    logEvent('worldline_webhook_payload', {
      operationId,
      terminalId: operation.terminalId,
      kind: operation.kind,
      responsePayload: redactForLog(req.body),
    });
  }
  completeOperation(operation, req.body);
  logEvent('worldline_webhook_completed', { operationId, terminalId: operation.terminalId, kind: operation.kind, state: operation.state, outcome: operation.result?.transactionOutcome, detail: operation.result?.outcomeDescription });
  res.status(200).json({ ok: true });
});

function completeOperation(operation: Operation, envelope: any) {
  const raw = envelope?.data ?? envelope ?? null;
  const result = normalizeResult(operation.kind, raw);
  // Remember the TERMINAL: / MERCHANT: values printed on the terminal's own receipts.
  const receiptSample = result.receipt?.customer?.plain ?? result.receipt?.merchant?.plain;
  if (typeof receiptSample === 'string') {
    const learned = learnReceiptIdentity(receiptSample);
    if (learned.terminalId || learned.merchantId) terminalIdentity.set(operation.terminalId, { ...terminalIdentity.get(operation.terminalId), ...learned });
  }
  if (operation.kind === 'payment' && !result.receipt && ['Declined', 'Cancelled'].includes(result.transactionOutcome)) {
    const status = result.transactionOutcome === 'Cancelled' ? 'CANCELLED' : 'DECLINED';
    const amountMajor = operation.requestedAmountMinor !== undefined ? operation.requestedAmountMinor / 100 : undefined;
    const amountText = amountMajor !== undefined
      ? `Amount: ${operation.requestedCurrency ?? ''} ${amountMajor.toFixed(2)}`.trim()
      : '';
    const reason = result.outcomeDescription ? `Reason: ${String(result.outcomeDescription)}` : '';
    const slipBody = [
      'PAYMENT NOT COMPLETED',
      status,
      'NO PAYMENT TAKEN',
      amountText,
      reason,
      'SHOWROOM STATUS SLIP',
      'Not an official terminal receipt',
    ].filter(Boolean).join('\n');
    // Same header section as the terminal's own receipts, followed by the slip content.
    const slip = buildStatusSlip(terminalIdentity.get(operation.terminalId), new Date(), receiptTextToJson(slipBody));
    result.receiptStatusSlip = true;
    result.receipt = {
      customer: { plain: slip.plain, escpos: slip.plain, json: slip.json },
      merchant: { plain: slip.plain, escpos: slip.plain, json: slip.json },
    };
  }
  if (operation.kind === 'payment' || operation.kind === 'reversal' || operation.kind === 'reconciliation') result.operationKind = operation.kind;
  // The terminal's reversal response carries no transaction reference of its own; show the reference
  // of the payment that was reversed.
  if (operation.kind === 'reversal' && !result.originalTransaction && operation.reversalOf) result.originalTransaction = operation.reversalOf;
  if (operation.kind === 'payment' && !result.amounts && operation.requestedAmountMinor !== undefined) {
    result.amounts = {
      base: operation.requestedAmountMinor,
      total: operation.requestedAmountMinor / 100,
      currency: { symbol: operation.requestedCurrency ?? '' },
      currencySymbol: operation.requestedCurrency,
    };
  }
  operation.result = result;
  operation.state = 'completed';
  operation.message = undefined;
  operation.requestId = envelope?.requestId ?? operation.requestId;
  if (activeByTerminal.get(operation.terminalId) === operation.operationId) activeByTerminal.delete(operation.terminalId);

  // Latest means the latest completed payment, reversal or capture attempt, regardless of its outcome.
  // Reversal/receipt history below remains limited to approved payments with a usable transaction reference.
  if (operation.kind === 'payment' || operation.kind === 'reversal' || operation.kind === 'reconciliation') latestPayment.set(operation.terminalId, result);

  if (operation.kind === 'payment' && result.transactionOutcome === 'Approved') {
    const original = result.originalTransaction;
    const list = transactions.get(operation.terminalId) ?? [];
    const nextReceipt = (receiptCounters.get(operation.terminalId) ?? 0) + 1;
    receiptCounters.set(operation.terminalId, nextReceipt);
    const receiptNumber = String(nextReceipt % 1_000_000).padStart(6, '0');
    result.receiptNumber = receiptNumber;
    const saved: SavedTransaction = { terminalId: operation.terminalId, receiptNumber, createdAt: operation.createdAt, result, originalTransaction: original };
    list.push(saved);
    if (list.length > 500) list.splice(0, list.length - 500);
    transactions.set(operation.terminalId, list);
  }
  if (['payment', 'refund', 'reversal', 'reconciliation'].includes(operation.kind)) scheduleHistorySave(operation.terminalId);
  if (operation.kind === 'reconciliation' && operation.captureEmail && operation.result) {
    operation.result.captureEmail = { status: 'sending' };
    void sendCaptureResultEmail(operation);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
function redactCaptureEmailValue(value: any): any {
  if (Array.isArray(value)) return value.map(redactCaptureEmailValue);
  if (value && typeof value === 'object') {
    const clean: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase() === 'callbacktoken' || key.toLowerCase() === 'authorization') clean[key] = '[REDACTED]';
      else clean[key] = redactCaptureEmailValue(item);
    }
    return clean;
  }
  if (typeof value === 'string' && value.startsWith('https://') && value.includes('callbackToken=')) {
    try {
      const url = new URL(value);
      if (url.searchParams.has('callbackToken')) url.searchParams.set('callbackToken', '[REDACTED]');
      return url.toString();
    } catch { return value.replace(/([?&]callbackToken=)[^&]+/gi, '$1[REDACTED]'); }
  }
  return value;
}
async function sendCaptureResultEmail(operation: Operation) {
  const terminal = terminals.find(item => item.id === operation.terminalId);
  if (!terminal || !operation.captureEmail || !operation.result) return;
  const json = JSON.stringify(redactCaptureEmailValue(operation.result.worldlineResponse ?? operation.result), null, 2);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudConfig.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cloudConfig.captureEmailFrom,
        to: [operation.captureEmail],
        subject: `Worldline capture result — ${terminal.label} — ${operation.createdAt}`,
        text: `Worldline capture/reconciliation result for ${terminal.label}.\n\n${json}`,
        html: `<p>Worldline capture/reconciliation result for <strong>${escapeHtml(terminal.label)}</strong>.</p><pre style="white-space:pre-wrap">${escapeHtml(json)}</pre>`,
        attachments: [{ filename: `worldline-capture-${operation.operationId}.json`, content: Buffer.from(json, 'utf8').toString('base64') }],
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Mail provider HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 250)}` : ''}`);
    operation.result.captureEmail = { status: 'sent', sentAt: new Date().toISOString() };
    logEvent('capture_result_email_sent', { operationId: operation.operationId, terminalId: operation.terminalId });
  } catch (error) {
    operation.result.captureEmail = { status: 'failed', message: error instanceof Error && error.name === 'AbortError' ? 'Email provider request timed out.' : error instanceof Error ? error.message : 'Email delivery failed.' };
    logEvent('capture_result_email_failed', { operationId: operation.operationId, terminalId: operation.terminalId, errorType: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'provider_error' });
  } finally {
    clearTimeout(timeout);
  }
}

function renderJsonReceipt(lines: any[]): string {
  let current = '';
  const rendered: string[] = [];
  for (const line of lines) {
    current += String(line?.Text ?? '');
    if (line?.EndOfLineFlag !== false) { rendered.push(current); current = ''; }
  }
  if (current) rendered.push(current);
  return rendered.join('\n');
}

type ReceiptSections = { header: string; content: string; footer: string };

function extractReceiptTargetSections(output: any, audience: 'customer' | 'merchant'): ReceiptSections | undefined {
  const parseCandidate = (candidate: any): any => {
    if (Array.isArray(candidate)) {
      const serialized = candidate.map((entry: any) => String(entry?.Text ?? '')).join('');
      try { return JSON.parse(serialized.trim()); } catch { return undefined; }
    }
    if (typeof candidate === 'string') {
      try { return JSON.parse(candidate.trim()); } catch { return undefined; }
    }
    return candidate && typeof candidate === 'object' ? candidate : undefined;
  };

  const parsed = parseCandidate(output?.MessageContent) ?? parseCandidate(output?.OutputJSON);
  if (!parsed || typeof parsed !== 'object' || !parsed.receiptTargets || !parsed.additionalData) return undefined;

  const additional = new Map<string, string>();
  if (Array.isArray(parsed.additionalData)) {
    for (const entry of parsed.additionalData) {
      if (entry && typeof entry.key === 'string') {
        additional.set(entry.key.toLowerCase().replace(/[^a-z0-9]/g, ''), String(entry.value ?? ''));
      }
    }
  } else if (typeof parsed.additionalData === 'object') {
    for (const [key, entry] of Object.entries(parsed.additionalData)) {
      additional.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), String((entry as any)?.value ?? entry ?? ''));
    }
  }

  const suffixes = audience === 'merchant' ? ['merchant', 'cashier'] : ['customer', 'client', 'cardholder'];
  const readPart = (part: 'header' | 'content' | 'footer') => {
    for (const suffix of suffixes) {
      const value = additional.get(`receipt${part}${suffix}`);
      if (value !== undefined) return value;
    }
    return '';
  };
  const sections = { header: readPart('header'), content: readPart('content'), footer: readPart('footer') };
  return sections.header || sections.content || sections.footer ? sections : undefined;
}

function wrapCenteredReceiptHeader(text: string, width = 32): JsonReceiptLine[] {
  const result: JsonReceiptLine[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let remaining = raw.trim();
    if (!remaining) {
      result.push({ CharacterStyle: 'Normal', Alignment: 'Centred', EndOfLineFlag: true, Text: '' });
      continue;
    }
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(' ', width);
      if (splitAt < Math.floor(width * 0.55)) splitAt = width;
      result.push({ CharacterStyle: 'Normal', Alignment: 'Centred', EndOfLineFlag: true, Text: remaining.slice(0, splitAt).trimEnd() });
      remaining = remaining.slice(splitAt).trimStart();
    }
    result.push({ CharacterStyle: 'Normal', Alignment: 'Centred', EndOfLineFlag: true, Text: remaining });
  }
  return result;
}

function receiptSectionsToJson(sections: ReceiptSections): JsonReceiptLine[] {
  const rows: JsonReceiptLine[] = [];
  if (sections.header) rows.push(...wrapCenteredReceiptHeader(sections.header));
  if (sections.header && sections.content) rows.push({ CharacterStyle: 'Normal', Alignment: 'Left', EndOfLineFlag: true, Text: '' });
  if (sections.content) rows.push(...receiptTextToJson(sections.content));
  if (sections.content && sections.footer) rows.push({ CharacterStyle: 'Normal', Alignment: 'Left', EndOfLineFlag: true, Text: '' });
  if (sections.footer) rows.push(...wrapCenteredReceiptHeader(sections.footer));
  return rows;
}

function renderReceiptSections(sections: ReceiptSections): string {
  return [sections.header, sections.content, sections.footer].filter(section => section.length > 0).join('\n');
}

// Finds receipt documents (objects with a DocumentQualifier and OutputContent) anywhere in a terminal
// response. Payments and captures put them at known places; for reversals the location is not
// documented in this project, so they are searched for.
function findReceiptDocuments(node: any, depth = 0, found: any[] = []): any[] {
  if (!node || typeof node !== 'object' || depth > 10) return found;
  if (Array.isArray(node)) { for (const item of node) findReceiptDocuments(item, depth + 1, found); return found; }
  if (typeof node.DocumentQualifier === 'string' && node.OutputContent && typeof node.OutputContent === 'object') { found.push(node); return found; }
  for (const value of Object.values(node)) findReceiptDocuments(value, depth + 1, found);
  return found;
}
// Receipt text delivered as standard Nexo OutputText entries instead of MessageContent / OutputJSON.
function receiptOutputText(output: any): string | undefined {
  const items = Array.isArray(output?.OutputText) ? output.OutputText : undefined;
  if (!items?.length) return undefined;
  const text = items.map((item: any) => String(item?.Text ?? '')).join('\n');
  return text.trim() ? text : undefined;
}

function normalizeResult(kind: WorldlineOperationKind, raw: any): Record<string, any> {
  const isRejection = Boolean(raw?.SaleToPOIMessageRejection);
  const service = raw?.SaleToPOIServiceResponse?.ServiceResponse ?? {};
  const reconciliation = raw?.SaleToPOIReconciliationResponse?.ReconciliationResponse ?? {};
  const payment = service?.PaymentResponse ?? {};
  const paymentTransaction = payment?.PaymentTransaction ?? {};
  const retailerResult = payment?.RetailerPaymentResult ?? {};
  const authResponse = retailerResult?.TransactionResponse?.AuthorisationResult?.ResponseToAuthorisation?.Response
    ?? paymentTransaction?.TransactionResponse?.AuthorisationResult?.ResponseToAuthorisation?.Response;
  const rejection = raw?.SaleToPOIMessageRejection?.Reject ?? {};
  const deviceResponse = raw?.SaleToPOIDeviceResponse?.DeviceResponse ?? {};
  const deviceStatus = deviceResponse?.Response?.Response ?? '';
  const responseStatus = service?.Response?.Response ?? service?.Response?.Result ?? reconciliation?.Response?.Response ?? deviceStatus ?? '';
  const responseReason = service?.Response?.ResponseReason ?? reconciliation?.Response?.ResponseReason ?? deviceResponse?.Response?.ResponseReason ?? rejection?.RejectReason ?? '';
  const rejectionDetail = rejection?.AdditionalInformation ?? rejection?.RejectReason ?? '';
  const successfulServiceResponse = ['success', 'successful'].includes(String(responseStatus).toLowerCase());
  const approved = String(authResponse ?? '').toLowerCase() === 'approved'
    || (successfulServiceResponse && !authResponse && kind !== 'print');
  const declined = ['failed', 'failure'].includes(String(responseStatus).toLowerCase())
    || Boolean(responseReason) || Boolean(authResponse && String(authResponse).toLowerCase() !== 'approved') || isRejection;
  const transactionOutcome = approved ? 'Approved' : declined ? (['aborted', 'cancel'].includes(String(responseReason).toLowerCase()) ? 'Cancelled' : 'Declined') : 'Unknown';
  const reversal = service?.FinancialReversalResponse ?? {};
  const sourceReceipt = payment?.PaymentReceipt ?? paymentTransaction?.PaymentReceipt ?? reversal?.Receipt ?? reconciliation?.PaymentReceipt ?? [];
  const knownReceipts = (Array.isArray(sourceReceipt) ? sourceReceipt : [sourceReceipt]).filter((item: any) => item?.DocumentQualifier);
  // Not at one of the known places (e.g. a reversal): look for the receipt documents anywhere in the response.
  const receiptList = knownReceipts.length ? knownReceipts : findReceiptDocuments(raw);
  const customerReceipt = receiptList.find((item: any) => item?.DocumentQualifier === 'CustomerReceipt');
  const merchantReceipt = receiptList.find((item: any) => item?.DocumentQualifier === 'CashierReceipt');
  const customerOutput = customerReceipt?.OutputContent ?? {};
  const merchantOutput = merchantReceipt?.OutputContent ?? {};
  const customerOriginalJson = customerOutput?.Format === 'JSON' && Array.isArray(customerOutput?.OutputJSON) ? customerOutput.OutputJSON : undefined;
  const merchantOriginalJson = merchantOutput?.Format === 'JSON' && Array.isArray(merchantOutput?.OutputJSON) ? merchantOutput.OutputJSON : undefined;
  const customerWrappedSections = extractReceiptTargetSections(customerOutput, 'customer');
  const merchantWrappedSections = extractReceiptTargetSections(merchantOutput, 'merchant');
  const customerJson = customerWrappedSections ? receiptSectionsToJson(customerWrappedSections) : customerOriginalJson;
  const merchantJson = merchantWrappedSections ? receiptSectionsToJson(merchantWrappedSections) : merchantOriginalJson;
  const customerText = customerWrappedSections ? renderReceiptSections(customerWrappedSections) : customerOutput?.MessageContent ?? (customerJson ? renderJsonReceipt(customerJson) : undefined) ?? receiptOutputText(customerOutput);
  const merchantText = merchantWrappedSections ? renderReceiptSections(merchantWrappedSections) : merchantOutput?.MessageContent ?? (merchantJson ? renderJsonReceipt(merchantJson) : undefined) ?? receiptOutputText(merchantOutput);
  const originalId = payment?.POITransactionIdentification ?? paymentTransaction?.POITransactionIdentification;
  const totalAmount = retailerResult?.RequestedTransaction?.TransactionDetails?.TotalAmount
    ?? paymentTransaction?.TransactionDetails?.TotalAmount
    ?? reversal?.OriginalPaymentTransaction?.TransactionDetails?.TotalAmount;
  const currency = retailerResult?.RequestedTransaction?.TransactionDetails?.Currency
    ?? paymentTransaction?.TransactionDetails?.Currency
    ?? reversal?.OriginalPaymentTransaction?.TransactionDetails?.Currency;
  const amounts = totalAmount !== undefined ? {
    total: totalAmount,
    base: Math.round(Number(totalAmount) * cloudConfig.minorUnitDivisor),
    currency: currency ? { symbol: currency } : undefined,
    currencySymbol: currency,
  } : undefined;
  let outcomeDescription = rejectionDetail || responseReason || service?.Response?.AdditionalResponseInformation || reconciliation?.Response?.AdditionalResponseInformation || '';
  if (!outcomeDescription && authResponse && authResponse !== 'Approved') outcomeDescription = `Authorisation: ${authResponse}`;
  if (!outcomeDescription && responseStatus && !approved) outcomeDescription = `Worldline response: ${responseStatus}`;
  const identifier = originalId ?? payment?.SaleTransactionIdentification ?? paymentTransaction?.TransactionIdentification;
  const result: Record<string, any> = {
    transactionOutcome,
    ...(outcomeDescription ? { outcomeDescription: String(outcomeDescription) } : {}),
    ...(amounts ? { amounts } : {}),
    ...(retailerResult?.TransactionResponse?.AuthorisationResult?.AuthorisationCode ? { approvalCode: retailerResult.TransactionResponse.AuthorisationResult.AuthorisationCode } : {}),
    ...(paymentTransaction?.TransactionResponse?.AuthorisationResult?.AuthorisationCode ? { approvalCode: paymentTransaction.TransactionResponse.AuthorisationResult.AuthorisationCode } : {}),
    ...(identifier?.TransactionReference ? { transactionReference: identifier.TransactionReference } : {}),
    ...(originalId?.TransactionDateTime && originalId?.TransactionReference ? { originalTransaction: { TransactionDateTime: originalId.TransactionDateTime, TransactionReference: originalId.TransactionReference } } : {}),
    ...(customerText || merchantText ? { receipt: { customer: { ...(customerText ? { plain: customerText, escpos: customerText } : {}), ...(customerJson ? { json: customerJson } : {}) }, merchant: { ...(merchantText ? { plain: merchantText, escpos: merchantText } : {}), ...(merchantJson ? { json: merchantJson } : {}) } } } : {}),
    ...(kind === 'reconciliation' && merchantText ? { receipt: { customer: { plain: merchantText, escpos: merchantText }, merchant: { plain: merchantText, escpos: merchantText } } } : {}),
    ...(kind === 'print' ? { printResult: isRejection || (deviceStatus && !['success', 'successful'].includes(String(deviceStatus).toLowerCase())) ? 'Failed' : 'Success' } : {}),
    ...(kind === 'device' ? { deviceResult: isRejection || (deviceStatus && !['success', 'successful'].includes(String(deviceStatus).toLowerCase())) ? 'Failed' : 'Success' } : {}),
    worldlineResponse: raw,
  };
  if (kind === 'print') result.transactionOutcome = result.printResult === 'Success' ? 'Approved' : 'Declined';
  if (kind === 'device') result.transactionOutcome = result.deviceResult === 'Success' ? 'Completed' : 'Failed';
  return result;
}

app.get('/api/payments/latest', async (req, res) => {
  const terminal = chosenTerminal(req.query.terminalId);
  if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
  if (activeByTerminal.has(terminal.id)) { res.status(409).json({ error: 'Payment lookup is unavailable while this terminal has an active operation.' }); return; }
  await ensureHistoryLoaded(terminal.id);
  const latest = latestPayment.get(terminal.id);
  if (!latest) {
    const problem = historyProblem(terminal.id);
    if (problem) { res.status(503).json({ error: problem }); return; }
    res.status(404).json({ error: 'No completed payment, reversal or capture is available in this backend session.' });
    return;
  }
  res.json(latest);
});
app.get('/api/payments/:receiptNumber', async (req, res) => {
  const terminal = chosenTerminal(req.query.terminalId);
  if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
  if (activeByTerminal.has(terminal.id)) { res.status(409).json({ error: 'Receipt lookup is unavailable while this terminal has an active operation.' }); return; }
  await ensureHistoryLoaded(terminal.id);
  const number = String(req.params.receiptNumber ?? '').trim();
  const found = (transactions.get(terminal.id) ?? []).find(item => item.receiptNumber === number || item.originalTransaction?.TransactionReference === number);
  if (!found) {
    const problem = historyProblem(terminal.id);
    if (problem) { res.status(503).json({ error: problem }); return; }
    res.status(404).json({ error: 'Receipt not found in the showroom transaction history for this backend session.' });
    return;
  }
  res.json(found.result);
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected server error.' });
});

const staticDir = path.resolve(process.cwd(), 'web/dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
}

// Render stops the service with SIGTERM when it redeploys or spins it down. Give a payment-history
// save that is still running (at most a few seconds) the chance to finish first.
process.on('SIGTERM', () => {
  const pending = [...historyState.values()].map(state => state.current).filter((current): current is Promise<void> => Boolean(current));
  void Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, 5000))]).finally(() => process.exit(0));
});

// Load what was saved (terminal settings, product catalog, payment history) before accepting
// requests, so a restart never serves stale settings. Nothing is read when persistent storage is
// not configured.
void (async () => {
  await Promise.all([loadTerminalSettings(), loadRemoteProductCatalog()]);
  await Promise.all(terminals.map(terminal => loadHistory(terminal.id)));
  app.listen(cloudConfig.apiPort, '0.0.0.0', () => {
    const ready = terminals.filter(terminalConfigured).length;
    const storage = storageStatus();
    console.log(`Worldline showroom backend listening on port ${cloudConfig.apiPort}; ${ready}/${terminals.length} terminal(s) have credentials and IDs configured. Storage: terminals=${storage.terminals}, products=${storage.products}, history=${storage.history}.`);
  });
})().catch(error => {
  console.error('Startup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
