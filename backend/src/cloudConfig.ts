import dotenv from 'dotenv';

dotenv.config();

export type CloudTerminal = {
  id: string;
  name: string;
  label: string;
  umid: string;
  utid: string;
  jwt: string;
  initiatingParty: string;
  poiId: string;
};

function cleanEnv(key: string, fallback = ''): string {
  const value = (process.env[key] ?? fallback).trim();
  return value.startsWith('REPLACE_WITH_') ? '' : value;
}

const ids = (process.env.TERMINALS ?? 'terminal1,terminal2,terminal3')
  .split(',').map(value => value.trim()).filter(Boolean);
if (!ids.length || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
  throw new Error('TERMINALS must contain one or more unique terminal IDs.');
}

function envKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export const terminals: CloudTerminal[] = ids.map(id => {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error(`Invalid terminal ID: ${id}`);
  const key = envKey(id);
  const label = cleanEnv(`TERMINAL_${key}_LABEL`, id);
  return {
    id,
    name: cleanEnv(`TERMINAL_${key}_NAME`, label),
    label,
    umid: cleanEnv(`TERMINAL_${key}_UMID`),
    utid: cleanEnv(`TERMINAL_${key}_UTID`),
    jwt: cleanEnv(`TERMINAL_${key}_JWT`),
    initiatingParty: cleanEnv(`TERMINAL_${key}_INITIATING_PARTY`, `Showroom-${id}`),
    poiId: cleanEnv(`TERMINAL_${key}_POI_ID`),
  };
});

export const cloudConfig = {
  baseUrl: (cleanEnv('WORLDLINE_BASE_URL', 'https://api.terminal.iacc.global.worldline-solutions.com') || 'https://api.terminal.iacc.global.worldline-solutions.com').replace(/\/$/, ''),
  integratorId: cleanEnv('WORLDLINE_INTEGRATOR_ID', '239240630F36B979') || '239240630F36B979',
  webhookBaseUrl: cleanEnv('WORLDLINE_WEBHOOK_URL', 'https://webhook.site/8d5670ad-0d7b-4f90-bca6-0740b759fddd') || 'https://webhook.site/8d5670ad-0d7b-4f90-bca6-0740b759fddd',
  webhookRetries: Math.max(0, Math.min(10, Number(process.env.WORLDLINE_WEBHOOK_RETRIES ?? 3) || 3)),
  minorUnitDivisor: Math.max(1, Number(process.env.WORLDLINE_MINOR_UNIT_DIVISOR ?? 100) || 100),
  apiPort: Number(process.env.PORT ?? process.env.API_PORT ?? 3001),
  requestTimeoutMs: Math.max(1000, Number(process.env.WORLDLINE_REQUEST_TIMEOUT_MS ?? 25000) || 25000),
  adminPin: cleanEnv('ADMIN_PIN'),
  productsFile: process.env.PRODUCTS_FILE?.trim() || 'data/products.json',
  terminalSettingsFile: process.env.TERMINAL_SETTINGS_FILE?.trim() || 'data/cloud-terminals.json',
};
if (cloudConfig.adminPin && cloudConfig.adminPin.length < 6) throw new Error('ADMIN_PIN must be at least 6 characters.');
if (new URL(cloudConfig.baseUrl).protocol !== 'https:') throw new Error('WORLDLINE_BASE_URL must use HTTPS.');

export function terminalConfigured(terminal: CloudTerminal): boolean {
  return Boolean(terminal.umid && terminal.utid && terminal.jwt);
}

export function safeTerminals() {
  return terminals.map(terminal => ({
    id: terminal.id,
    name: terminal.name,
    label: terminal.label,
    // Legacy display fields retained for the existing showroom UI; these are not LAN addresses.
    ip: 'Worldline Cloud',
    port: 443,
    address: 'Worldline Cloud API',
    configured: terminalConfigured(terminal),
  }));
}
