import { randomUUID } from 'node:crypto';
import { CloudTerminal, cloudConfig, terminalConfigured } from './cloudConfig';
import { logEvent, redactForLog } from './structuredLog';

export type WorldlineOperationKind = 'payment' | 'refund' | 'reversal' | 'reconciliation' | 'print' | 'device';

export class WorldlineHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createWebhookUrl(operationId: string, callbackToken: string): string {
  let url: URL;
  try { url = new URL(cloudConfig.webhookBaseUrl); }
  catch { throw new Error('WORLDLINE_WEBHOOK_URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:') throw new Error('WORLDLINE_WEBHOOK_URL must use HTTPS.');
  url.searchParams.set('operationId', operationId);
  url.searchParams.set('callbackToken', callbackToken);
  return url.toString();
}

function tokenFor(terminal: CloudTerminal): string {
  if (!terminalConfigured(terminal)) {
    throw new Error(`Terminal ${terminal.label} is not configured. Set TERMINAL_${terminal.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_UMID, _UTID, and _JWT in the backend environment.`);
  }
  return terminal.jwt.replace(/^Bearer\s+/i, '').trim();
}

function apiPath(terminal: CloudTerminal, endpoint: string): string {
  return `/api/v2/merchants/${encodeURIComponent(terminal.umid)}/terminals/${encodeURIComponent(terminal.utid)}/${endpoint}`;
}

export async function worldlineRequest<T = any>(terminal: CloudTerminal, endpoint: string, payload: unknown): Promise<{ status: number; data: T }> {
  const path = apiPath(terminal, endpoint);
  const requestId = randomUUID();
  const exchangeId = (payload as any)?.SaleToPOIServiceRequest?.Header?.ExchangeIdentification
    ?? (payload as any)?.SaleToPOIReconciliationRequest?.Header?.ExchangeIdentification
    ?? (payload as any)?.SaleToPOIDeviceRequest?.Header?.ExchangeIdentification
    ?? (payload as any)?.SaleToPOIAbort?.Header?.ExchangeIdentification;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), cloudConfig.requestTimeoutMs);
  let response: Response;
  let text: string;
  logEvent('worldline_api_request', { requestId, method: 'POST', endpoint, url: `${cloudConfig.baseUrl}${path}`, terminalId: terminal.id, ...(exchangeId ? { exchangeId } : {}), ...(cloudConfig.logWorldlinePayloads ? { requestPayload: redactForLog(payload) } : {}) });
  try {
    response = await fetch(`${cloudConfig.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenFor(terminal)}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
        'User-Agent': 'Worldline-Showroom-ECR/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await response.text();
    let responsePayload: unknown = text;
    if (text) {
      try { responsePayload = JSON.parse(text); } catch { /* Keep non-JSON response text for opt-in troubleshooting. */ }
    }
    logEvent('worldline_api_response', { requestId, method: 'POST', endpoint, url: `${cloudConfig.baseUrl}${path}`, terminalId: terminal.id, statusCode: response.status, durationMs: Date.now() - startedAt, ...(cloudConfig.logWorldlinePayloads ? { responsePayload: redactForLog(responsePayload) } : {}) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    logEvent('worldline_api_transport_error', { requestId, method: 'POST', endpoint, terminalId: terminal.id, durationMs: Date.now() - startedAt, errorType: timedOut ? 'timeout' : 'network_error' });
    if (timedOut) throw new Error('Worldline API request timed out; the terminal outcome may be unknown. Do not retry until resolved.');
    throw new Error('Could not reach the Worldline API; the terminal outcome may be unknown. Do not retry until resolved.');
  } finally {
    clearTimeout(timer);
  }

  let data: any = undefined;
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new Error('Worldline API returned a non-JSON response.'); }
  }
  if (!response.ok) {
    const safeMessage = data?.message ?? data?.error?.message ?? data?.error ?? data?.title ?? `Worldline API returned HTTP ${response.status}`;
    throw new WorldlineHttpError(response.status, String(safeMessage).slice(0, 500));
  }
  return { status: response.status, data: data as T };
}

function saleSoftwareInfo() {
  return {
    IntegratorId: cloudConfig.integratorId,
    SaleSoftware: [{
      Type: 'ECR',
      SubTypeInformation: 'Showroom',
      Identification: {
        ProviderIdentification: 'Worldline Showroom',
        Identification: 'Showroom ECR',
        SerialNumber: 'SHOWROOM-001',
      },
      Status: { VersionNumber: '1.0.0' },
    }],
  };
}

function makeHeader(terminal: CloudTerminal, operationId: string, webhookUrl: string, messageFunction: string) {
  return {
    MessageFunction: messageFunction,
    ProtocolVersion: '5.1-WL2.1.1',
    ExchangeIdentification: operationId,
    CreationDateTime: new Date().toISOString(),
    InitiatingParty: { Identification: terminal.initiatingParty, Type: 'Merchant' },
    SalesSystemInfo: saleSoftwareInfo(),
    WebhookUrl: webhookUrl,
    NumberOfRetries: cloudConfig.webhookRetries,
  };
}

function environment(terminal: CloudTerminal) {
  return terminal.poiId ? { POI: { Identification: { Identification: terminal.poiId } } } : {};
}

export function makeFinancialRequest(
  terminal: CloudTerminal,
  kind: 'payment' | 'refund' | 'reversal',
  operationId: string,
  callbackToken: string,
  input: { amount?: number; currency?: string; minorUnitDivisor?: number; originalTransaction?: any },
) {
  const webhookUrl = createWebhookUrl(operationId, callbackToken);
  const header = makeHeader(terminal, operationId, webhookUrl, 'SaleFinancialServiceRequest');
  if (kind === 'reversal') {
    if (!input.originalTransaction?.TransactionDateTime || !input.originalTransaction?.TransactionReference) {
      throw new Error('The original payment transaction reference was not found. Find the saved receipt and use its local receipt number.');
    }
    return {
      SaleToPOIServiceRequest: {
        Header: header,
        ServiceRequest: {
          Environment: environment(terminal),
          ServiceContent: 'FinancialReversalRequest',
          ReversalRequest: {
            ReversalTransaction: {
              TransactionType: 'CardPayment',
              OriginalTransaction: { TransactionIdentification: input.originalTransaction },
            },
            ReversalReason: 'MerchantCancellation',
          },
        },
      },
    };
  }

  const divisor = input.minorUnitDivisor ?? cloudConfig.minorUnitDivisor;
  const total = Number(input.amount) / divisor;
  if (!Number.isFinite(total) || total <= 0) throw new Error('Amount must be a positive number.');
  const currency = String(input.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter ISO code.');
  const now = new Date().toISOString();
  return {
    SaleToPOIServiceRequest: {
      Header: header,
      ServiceRequest: {
        Environment: environment(terminal),
        ServiceContent: 'FinancialPaymentRequest',
        PaymentRequest: {
          PaymentTransaction: {
            TransactionType: kind === 'payment' ? 'CardPayment' : 'Refund',
            TransactionIdentification: { TransactionDateTime: now, TransactionReference: operationId },
            TransactionDetails: { Currency: currency, TotalAmount: Number(total.toFixed(3)) },
          },
        },
      },
    },
  };
}


export function makeReconciliationRequest(terminal: CloudTerminal, operationId: string, callbackToken: string) {
  return {
    SaleToPOIReconciliationRequest: {
      Header: makeHeader(terminal, operationId, createWebhookUrl(operationId, callbackToken), 'SaleFinancialReconciliationRequest'),
      ReconciliationRequest: {
        Environment: environment(terminal),
        ReconciliationRequestData: { ReconciliationType: 'AcquirerReconciliation' },
      },
    },
  };
}

type JsonReceiptLine = {
  CharacterStyle: 'Normal';
  Alignment: 'Left' | 'Right' | 'Centred';
  EndOfLineFlag: boolean;
  Text: string;
};

// Convert Worldline's SimpleText receipt into the documented JSON printer extension.
// Remove original padding, keep centered headings, and render double-spaced label/value
// rows as a left-aligned label plus a right-aligned value on the same printer line.
export function receiptTextToJson(text: string, maxCharacters = 32): JsonReceiptLine[] {
  const output: JsonReceiptLine[] = [];
  const appendLine = (value: string, alignment: JsonReceiptLine['Alignment']) => {
    if (!value) {
      output.push({ CharacterStyle: 'Normal', Alignment: 'Left', EndOfLineFlag: true, Text: '' });
      return;
    }
    for (let offset = 0; offset < value.length; offset += maxCharacters) {
      const chunk = value.slice(offset, offset + maxCharacters);
      output.push({ CharacterStyle: 'Normal', Alignment: alignment, EndOfLineFlag: true, Text: chunk });
    }
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    const value = line.trim();
    if (!value) {
      appendLine('', 'Left');
      continue;
    }

    const columns = value.match(/^(.+?)\s{2,}(.+)$/);
    if (columns) {
      const left = columns[1].trim();
      const right = columns[2].trim();
      // On the Worldline JSON format, EndOfLineFlag=false continues on the same line.
      if (left.length <= maxCharacters && right.length <= maxCharacters) {
        output.push({ CharacterStyle: 'Normal', Alignment: 'Left', EndOfLineFlag: false, Text: left });
        output.push({ CharacterStyle: 'Normal', Alignment: 'Right', EndOfLineFlag: true, Text: right });
      } else {
        appendLine(left, 'Left');
        appendLine(right, 'Right');
      }
      continue;
    }

    const leading = line.length - line.trimStart().length;
    const trailing = line.length - line.trimEnd().length;
    const centered = leading > 0 && trailing > 0 && Math.abs(leading - trailing) <= 2;
    appendLine(value, centered ? 'Centred' : 'Left');
  }
  return output;
}

export function makeDeviceFeatureRequest(
  terminal: CloudTerminal,
  operationId: string,
  callbackToken: string,
  deviceRequest: Record<string, unknown>,
) {
  return {
    SaleToPOIDeviceRequest: {
      Header: makeHeader(terminal, operationId, createWebhookUrl(operationId, callbackToken), 'DeviceRequest'),
      DeviceRequest: {
        ...deviceRequest,
        // Do not allow client-provided POI routing; always use trusted backend terminal config.
        Environment: environment(terminal),
      },
    },
  };
}

export function makePrintRequest(terminal: CloudTerminal, operationId: string, callbackToken: string, text: string) {
  return {
    SaleToPOIDeviceRequest: {
      Header: makeHeader(terminal, operationId, createWebhookUrl(operationId, callbackToken), 'DeviceRequest'),
      DeviceRequest: {
        Environment: environment(terminal),
        PrintRequest: { OutputContent: { Format: 'JSON', OutputJSON: receiptTextToJson(text) } },
      },
    },
  };
}

export function makeAbortRequest(terminal: CloudTerminal) {
  // Diagnostic experiment: use independent UUIDs for the abort message and SystemAbort field.
  // This intentionally differs from the original-payment reference behavior so we can compare
  // against the Hoppscotch test. A 200 still only acknowledges delivery; inspect final outcome.
  return {
    SaleToPOIAbort: {
      Header: {
        MessageFunction: 'Abort',
        ProtocolVersion: '5.1-WL2.1.1',
        ExchangeIdentification: randomUUID(),
        CreationDateTime: new Date().toISOString(),
        InitiatingParty: { Identification: terminal.initiatingParty, Type: 'Merchant' },
        SalesSystemInfo: saleSoftwareInfo(),
      },
      Abort: {
        Environment: environment(terminal),
        SystemAbort: {
          ExchangeIdentification: randomUUID(),
          AbortReason: 'Cashier requested abort',
        },
      },
    },
  };
}
