import express, { NextFunction, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { cloudConfig, safeTerminals, terminals, terminalConfigured, CloudTerminal } from './cloudConfig';
import { makeAbortRequest, makeDeviceFeatureRequest, makeFinancialRequest, makePrintRequest, makeReconciliationRequest, receiptTextToJson, worldlineRequest, WorldlineHttpError, WorldlineOperationKind } from './worldlineClient';
import type { JsonReceiptLine } from './worldlineClient';
import { deviceFeatureTemplates } from './deviceFeatures';
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
const printSchema = z.object({ terminalId: z.string().min(1), receiptData: z.string().trim().min(1).max(20000).optional(), outputJSON: z.array(jsonReceiptLineSchema).min(1).max(500).optional() }).refine(value => Boolean(value.receiptData || value.outputJSON?.length), 'Provide receipt text or JSON receipt lines.');
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

function readProductCatalog() {
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
app.put('/api/admin/products', requireAdmin, (req, res) => {
  try {
    const catalog = productCatalogSchema.parse(req.body);
    const ids = catalog.products.map(product => product.id.toLowerCase());
    if (new Set(ids).size !== ids.length) { res.status(400).json({ error: 'Product IDs must be unique.' }); return; }
    writeProductCatalog(catalog);
    res.json(catalog);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid product catalog.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save product catalog.' });
  }
});

// Full terminal settings are editable behind ADMIN_PIN. JWTs are stored server-side only;
// the settings GET response exposes a configured flag, never the bearer token itself.
// Full cloud terminal settings are editable behind ADMIN_PIN. JWTs are write-only over the API.
const terminalDisplaySchema = z.array(z.object({
  id: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  initiatingParty: z.string().trim().min(1).max(35),
  poiId: z.string().trim().max(80),
  umid: z.string().trim().max(128).optional(),
  utid: z.string().trim().max(128).optional(),
  jwt: z.string().trim().max(16384).optional(),
})).min(1).max(50);
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
type PersistedTerminalSettings = z.infer<typeof terminalDisplaySchema>[number];

function publicTerminalSettings() {
  return terminals.map(terminal => ({
    id: terminal.id, name: terminal.name, label: terminal.label,
    initiatingParty: terminal.initiatingParty, poiId: terminal.poiId,
    umid: terminal.umid, utid: terminal.utid,
    jwtConfigured: Boolean(terminal.jwt), configured: terminalConfigured(terminal),
  }));
}
function loadTerminalSettings() {
  const file = path.resolve(process.cwd(), cloudConfig.terminalSettingsFile);
  if (!existsSync(file)) return;
  const records = terminalDisplaySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (records.length !== terminals.length || records.some(record => !terminals.some(terminal => terminal.id === record.id))) {
    throw new Error('Saved cloud terminal settings must contain exactly the terminal IDs configured in TERMINALS.');
  }
  for (const record of records) {
    const terminal = terminals.find(item => item.id === record.id)!;
    terminal.name = record.name; terminal.label = record.label;
    terminal.initiatingParty = record.initiatingParty; terminal.poiId = record.poiId.trim() || terminal.poiId;
    if (record.umid !== undefined) terminal.umid = record.umid;
    if (record.utid !== undefined) terminal.utid = record.utid;
    if (record.jwt !== undefined) terminal.jwt = record.jwt;
  }
}
function saveTerminalSettings(records: PersistedTerminalSettings[]) {
  const output = path.resolve(process.cwd(), cloudConfig.terminalSettingsFile);
  mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, output);
}
loadTerminalSettings();
app.get('/api/admin/terminals', requireAdmin, (_req, res) => res.json({ terminals: publicTerminalSettings() }));
app.put('/api/admin/terminals', requireAdmin, (req, res) => {
  if (activeByTerminal.size) { res.status(409).json({ error: 'Finish all active terminal operations before saving settings.' }); return; }
  try {
    const input = terminalSettingsInputSchema.parse(req.body?.terminals);
    const ids = input.map(record => record.id.toLowerCase());
    if (new Set(ids).size !== ids.length || ids.length !== terminals.length || terminals.some(terminal => !ids.includes(terminal.id.toLowerCase()))) {
      res.status(400).json({ error: 'Keep the configured terminal IDs unchanged and include each terminal exactly once.' }); return;
    }
    const records: PersistedTerminalSettings[] = input.map(({ clearJwt, jwt, ...record }) => {
      const current = terminals.find(terminal => terminal.id === record.id)!;
      return { ...record, poiId: record.poiId.trim() || current.poiId, jwt: clearJwt ? '' : (jwt?.trim() || current.jwt) };
    });
    saveTerminalSettings(records);
    for (const record of records) {
      const terminal = terminals.find(item => item.id === record.id)!;
      terminal.name = record.name; terminal.label = record.label;
      terminal.initiatingParty = record.initiatingParty; terminal.poiId = record.poiId.trim() || terminal.poiId;
      terminal.umid = record.umid ?? ''; terminal.utid = record.utid ?? ''; terminal.jwt = record.jwt ?? '';
    }
    logEvent('terminal_settings_updated', { terminalIds: records.map(record => record.id), configuredCount: records.filter(record => Boolean(record.umid && record.utid && record.jwt)).length });
    res.json({ terminals: publicTerminalSettings() });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid terminal settings.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) }); return;
    }
    logEvent('terminal_settings_save_failed', { error: error instanceof Error ? error.message : 'unknown error' });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save terminal settings.' });
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
      res.status(404).json({ error: 'No saved payment reference matches that receipt number. Reversal requires an original payment recorded by this showroom backend.' });
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
  operation.result = result;
  operation.state = 'completed';
  operation.message = undefined;
  operation.requestId = envelope?.requestId ?? operation.requestId;
  if (activeByTerminal.get(operation.terminalId) === operation.operationId) activeByTerminal.delete(operation.terminalId);

  // Latest payment means the latest completed payment attempt, regardless of its outcome.
  // Reversal/receipt history below remains limited to approved payments with a usable transaction reference.
  if (operation.kind === 'payment') latestPayment.set(operation.terminalId, result);

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
  const receiptList = Array.isArray(sourceReceipt) ? sourceReceipt : [sourceReceipt];
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
  const customerText = customerWrappedSections ? renderReceiptSections(customerWrappedSections) : customerOutput?.MessageContent ?? (customerJson ? renderJsonReceipt(customerJson) : undefined);
  const merchantText = merchantWrappedSections ? renderReceiptSections(merchantWrappedSections) : merchantOutput?.MessageContent ?? (merchantJson ? renderJsonReceipt(merchantJson) : undefined);
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

app.get('/api/payments/latest', (req, res) => {
  const terminal = chosenTerminal(req.query.terminalId);
  if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
  if (activeByTerminal.has(terminal.id)) { res.status(409).json({ error: 'Payment lookup is unavailable while this terminal has an active operation.' }); return; }
  const latest = latestPayment.get(terminal.id);
  if (!latest) { res.status(404).json({ error: 'No completed payment attempt is available in this backend session.' }); return; }
  res.json(latest);
});
app.get('/api/payments/:receiptNumber', (req, res) => {
  const terminal = chosenTerminal(req.query.terminalId);
  if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
  if (activeByTerminal.has(terminal.id)) { res.status(409).json({ error: 'Receipt lookup is unavailable while this terminal has an active operation.' }); return; }
  const number = String(req.params.receiptNumber ?? '').trim();
  const found = (transactions.get(terminal.id) ?? []).find(item => item.receiptNumber === number || item.originalTransaction?.TransactionReference === number);
  if (!found) { res.status(404).json({ error: 'Receipt not found in the showroom transaction history for this backend session.' }); return; }
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

app.listen(cloudConfig.apiPort, '0.0.0.0', () => {
  const ready = terminals.filter(terminalConfigured).length;
  console.log(`Worldline showroom backend listening on port ${cloudConfig.apiPort}; ${ready}/${terminals.length} terminal(s) have credentials and IDs configured.`);
});
