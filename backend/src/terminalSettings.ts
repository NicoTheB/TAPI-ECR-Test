import type { CloudTerminal } from './cloudConfig';

// Terminal records as saved in the terminal settings file (data/cloud-terminals.json).
export type TerminalRecord = {
  id: string;
  name: string;
  label: string;
  initiatingParty: string;
  poiId: string;
  umid?: string;
  utid?: string;
  jwt?: string;
};

// What is saved: the terminal records, plus the IDs of terminals that were removed. The removed list
// matters because terminals from the TERMINALS environment setting would otherwise come back every
// time the backend starts.
export type TerminalDocument = { terminals: TerminalRecord[]; removed: string[] };

export const MAX_TERMINALS = 50;
export const MAX_REMOVED = 200;
const TERMINAL_ID = /^[a-zA-Z0-9_-]{1,32}$/;

// Next free ID of the form terminal1, terminal2, ... (case-insensitive). IDs of removed terminals
// are never handed out again, so an old terminal's history cannot be mixed up with a new one.
export function nextTerminalId(terminals: ReadonlyArray<{ id: string }>, reserved: readonly string[] = []): string {
  const used = new Set([...terminals.map(terminal => terminal.id), ...reserved].map(id => id.toLowerCase()));
  for (let n = 1; n <= 999; n++) {
    const id = `terminal${n}`;
    if (!used.has(id)) return id;
  }
  throw new Error('No free terminal ID is available.');
}

// Applies saved records to the live terminal list. A record for a terminal that already exists
// (from the TERMINALS environment setting) updates it; a record with a new ID adds a terminal.
// Returns the IDs that were added.
export function applySavedTerminals(terminals: CloudTerminal[], records: TerminalRecord[]): string[] {
  const added: string[] = [];
  for (const record of records) {
    const existing = terminals.find(terminal => terminal.id === record.id);
    if (existing) {
      existing.name = record.name;
      existing.label = record.label;
      existing.initiatingParty = record.initiatingParty;
      existing.poiId = record.poiId.trim() || existing.poiId;
      if (record.umid !== undefined) existing.umid = record.umid;
      if (record.utid !== undefined) existing.utid = record.utid;
      if (record.jwt !== undefined) existing.jwt = record.jwt;
      continue;
    }
    if (!TERMINAL_ID.test(record.id)) throw new Error(`Invalid saved terminal ID: ${record.id}`);
    if (terminals.some(terminal => terminal.id.toLowerCase() === record.id.toLowerCase())) continue;
    if (terminals.length >= MAX_TERMINALS) throw new Error(`At most ${MAX_TERMINALS} terminals are supported.`);
    terminals.push({
      id: record.id,
      name: record.name,
      label: record.label,
      initiatingParty: record.initiatingParty,
      poiId: record.poiId.trim(),
      umid: record.umid ?? '',
      utid: record.utid ?? '',
      jwt: record.jwt ?? '',
    });
    added.push(record.id);
  }
  return added;
}

// Removes the terminal with this ID from the live list. Returns it, or undefined if not found.
export function removeTerminalById(terminals: CloudTerminal[], id: string): CloudTerminal | undefined {
  const index = terminals.findIndex(terminal => terminal.id === id);
  if (index < 0) return undefined;
  return terminals.splice(index, 1)[0];
}

// Applies a saved document at startup: first the saved records (so added terminals exist), then the
// removals. The last remaining terminal is never removed, so the app always has one to select.
export function applyTerminalDocument(terminals: CloudTerminal[], doc: TerminalDocument): { added: string[]; removed: string[]; keptLast: boolean } {
  const removedIds = new Set(doc.removed.map(id => id.toLowerCase()));
  const added = applySavedTerminals(terminals, doc.terminals.filter(record => !removedIds.has(record.id.toLowerCase())));
  const removed: string[] = [];
  let keptLast = false;
  for (const id of removedIds) {
    const terminal = terminals.find(item => item.id.toLowerCase() === id);
    if (!terminal) continue;
    if (terminals.length <= 1) { keptLast = true; continue; }
    removeTerminalById(terminals, terminal.id);
    removed.push(terminal.id);
  }
  return { added, removed, keptLast };
}

// The removed list after removing `id` (case-insensitive, no duplicates, newest last).
export function removedAfterRemoving(removed: readonly string[], id: string): string[] {
  return [...removed.filter(item => item.toLowerCase() !== id.toLowerCase()), id].slice(-MAX_REMOVED);
}
