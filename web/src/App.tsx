import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type Kind = 'payment' | 'refund' | 'reversal' | 'reconciliation';
type OperationKind = Kind | 'print' | 'device';
type OperationState = 'starting' | 'pending' | 'unknown' | 'abort-requested' | 'completed' | 'failed';
type Op = {
  operationId: string;
  terminalId: string;
  kind: OperationKind;
  state: OperationState;
  createdAt: string;
  result?: Record<string, any> | null;
  message?: string;
};
type Terminal = { id: string; name: string; label: string; ip: string; port: number; address: string; configured?: boolean };
type TerminalConfig = { terminals: Terminal[]; pollIntervalMs: number; settingsEnabled: boolean };
type TerminalEdit = { id: string; name: string; label: string; initiatingParty: string; poiId: string; configured: boolean };
type Product = { id: string; name: string; category: string; priceMinor: number; description?: string; image?: string };
type ProductCatalog = { currency: string; minorUnitDivisor: number; products: Product[] };
type ProductDraft = { id: string; name: string; category: string; price: string; description: string; image: string };
type ReceiptToPrint = { receiptNumber?: string; plain?: string; printerCommands?: string; source: string };
type DeviceFeature = { id: string; label: string; description: string; deviceRequest: Record<string, any> };

const labels: Record<OperationKind, string> = { payment: 'Payment', refund: 'Refund', reversal: 'Reversal', reconciliation: 'Capture / Reconciliation', print: 'Terminal receipt print', device: 'Device feature' };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

function getReceiptContent(response: any, source: string): ReceiptToPrint | null {
  const receipt = response?.receipt;
  if (!receipt) return null;
  const customer = receipt.customer ?? {};
  const merchant = receipt.merchant ?? {};
  const embedded = customer.embeddedPlain ?? merchant.embeddedPlain;
  const plain = customer.plain ?? merchant.plain ?? (embedded ? [embedded.header, embedded.content, embedded.footer].filter(Boolean).join('\n') : undefined);
  const printerCommands = customer.escpos ?? merchant.escpos;
  if (!plain && !printerCommands) return null;
  return { receiptNumber: response.receiptNumber, plain, printerCommands, source };
}

function printPlainReceipt(receiptText: string): boolean {
  const printWindow = window.open('', '_blank', 'width=480,height=720');
  if (!printWindow) return false;
  const doc = printWindow.document;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Transaction receipt</title><style>body{margin:0;padding:12mm;color:#111;background:#fff;font:12px/1.35 monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}@media print{body{padding:0}}</style></head><body><pre></pre></body></html>');
  doc.close();
  const pre = doc.querySelector('pre');
  if (pre) pre.textContent = receiptText;
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
    printWindow.onafterprint = () => printWindow.close();
  }, 200);
  return true;
}

export default function App() {
  const [config, setConfig] = useState<TerminalConfig | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState('');
  const selectedTerminalRef = useRef('');
  const [catalog, setCatalog] = useState<ProductCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [view, setView] = useState<'products' | 'manual' | 'device' | 'settings' | 'product-settings'>('products');
  const [category, setCategory] = useState('All');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartOperationId, setCartOperationId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('payment');
  const [amount, setAmount] = useState('100');
  const [currency, setCurrency] = useState('DKK');
  const [receipt, setReceipt] = useState('');
  const [receiptToPrint, setReceiptToPrint] = useState<ReceiptToPrint | null>(null);
  const [deviceFeatures, setDeviceFeatures] = useState<DeviceFeature[]>([]);
  const [deviceFeatureId, setDeviceFeatureId] = useState('');
  const [deviceRequestJson, setDeviceRequestJson] = useState('');
  const [operation, setOperation] = useState<Op | null>(null);
  const [latest, setLatest] = useState<Record<string, any> | null>(null);
  const [latestError, setLatestError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [settings, setSettings] = useState<TerminalEdit[]>([]);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [productAdminPin, setProductAdminPin] = useState('');
  const [productsUnlocked, setProductsUnlocked] = useState(false);
  const [productCatalogDraft, setProductCatalogDraft] = useState<ProductCatalog | null>(null);
  const [productDrafts, setProductDrafts] = useState<ProductDraft[]>([]);
  const [productSettingsMessage, setProductSettingsMessage] = useState('');
  const [productSettingsBusy, setProductSettingsBusy] = useState(false);
  const polling = useRef(false);

  useEffect(() => {
    api<TerminalConfig>('/api/config').then(value => {
      setConfig(value);
      if (value.terminals.length) setSelectedTerminalId(current => current || value.terminals[0].id);
    }).catch(e => setNotice(e.message));
    api<{ features: DeviceFeature[] }>('/api/device/features').then(value => {
      setDeviceFeatures(value.features);
      if (value.features.length) {
        setDeviceFeatureId(value.features[0].id);
        setDeviceRequestJson(JSON.stringify(value.features[0].deviceRequest, null, 2));
      }
    }).catch(e => setNotice(e instanceof Error ? e.message : 'Could not load device feature templates'));
    api<ProductCatalog>('/api/products').then(value => {
      if (!value.currency || !Number.isFinite(value.minorUnitDivisor) || value.minorUnitDivisor <= 0 || !Array.isArray(value.products)) {
        throw new Error('Product configuration is missing currency, minorUnitDivisor, or products.');
      }
      setCatalog(value);
    }).catch(e => setCatalogError(e instanceof Error ? e.message : 'Could not load product list'));
  }, []);

  useEffect(() => {
    selectedTerminalRef.current = selectedTerminalId;
    if (!selectedTerminalId) return;
    setOperation(null);
    setLatest(null);
    setReceiptToPrint(null);
    const query = `?terminalId=${encodeURIComponent(selectedTerminalId)}`;
    api<Op | null>(`/api/operations/current${query}`).then(current => {
      if (selectedTerminalRef.current === selectedTerminalId) setOperation(current);
    }).catch(e => setNotice(e.message));
  }, [selectedTerminalId]);

  useEffect(() => {
    if (!operation || !['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state)) return;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const updated = await api<Op>(`/api/operations/${encodeURIComponent(operation.operationId)}`);
        if (selectedTerminalRef.current === updated.terminalId) setOperation(updated);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not check operation status');
      } finally { polling.current = false; }
    }, config?.pollIntervalMs ?? 1500);
    return () => window.clearInterval(timer);
  }, [operation?.operationId, operation?.state, config?.pollIntervalMs]);

  const categories = useMemo(() => ['All', ...new Set((catalog?.products ?? []).map(product => product.category))], [catalog]);
  const visibleProducts = useMemo(() => (catalog?.products ?? []).filter(product => category === 'All' || product.category === category), [catalog, category]);
  const cartLines = useMemo(() => (catalog?.products ?? []).filter(product => (cart[product.id] ?? 0) > 0).map(product => ({ product, quantity: cart[product.id] })), [catalog, cart]);
  const cartTotalMinor = cartLines.reduce((sum, line) => sum + line.product.priceMinor * line.quantity, 0);
  const formatPrice = (minor: number) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: catalog?.currency ?? 'DKK',
    minimumFractionDigits: Math.log10(catalog?.minorUnitDivisor ?? 100),
    maximumFractionDigits: Math.log10(catalog?.minorUnitDivisor ?? 100),
  }).format(minor / (catalog?.minorUnitDivisor ?? 100));
  const selectedTerminal = config?.terminals.find(t => t.id === selectedTerminalId);
  const operationIsActive = !!operation && operation.terminalId === selectedTerminalId && ['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state);
  const result = operation?.result as any;
  const responseCurrency = result?.amounts?.currency?.symbol ?? result?.amounts?.currencySymbol;

  useEffect(() => {
    if (operation?.state === 'completed') {
      const content = getReceiptContent(operation.result, `${labels[operation.kind]} response`);
      if (content && selectedTerminalRef.current === operation.terminalId) setReceiptToPrint(content);
      if (operation.kind === 'payment' && operation.result?.transactionOutcome === 'Approved') setLatest(operation.result);
    }
  }, [operation?.state, operation?.operationId, operation?.terminalId, operation?.kind, operation?.result]);

  useEffect(() => {
    if (operation?.kind === 'payment' && operation.state === 'completed' && operation.operationId === cartOperationId && result?.transactionOutcome === 'Approved') {
      setCart({});
      setCartOperationId(null);
      setNotice('Payment approved. The cart has been cleared.');
    }
  }, [operation?.state, operation?.operationId, cartOperationId, result?.transactionOutcome]);

  function changeCart(productId: string, change: number) {
    setCart(current => {
      const quantity = Math.max(0, Math.min(99, (current[productId] ?? 0) + change));
      const next = { ...current };
      if (quantity === 0) delete next[productId]; else next[productId] = quantity;
      return next;
    });
  }

  async function startOperation(operationKind: Kind | 'device', body: Record<string, unknown>, fromCart = false) {
    setNotice('');
    setReceiptToPrint(null);
    setBusy(true);
    try {
      const started = await api<Op>(`/api/operations/${operationKind}`, { method: 'POST', body: JSON.stringify(body) });
      setOperation(started);
      if (fromCart) setCartOperationId(started.operationId);
      if (started.state === 'unknown') setNotice('The terminal response was uncertain. Checking this operation; do not retry yet.');
      setLatest(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not start operation');
    } finally { setBusy(false); }
  }

  async function checkout() {
    if (!selectedTerminalId || !catalog || cartTotalMinor <= 0) return;
    await startOperation('payment', { terminalId: selectedTerminalId, amount: cartTotalMinor, currencySymbol: catalog.currency, minorUnitDivisor: catalog.minorUnitDivisor }, true);
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    const body = kind === 'reversal'
      ? { terminalId: selectedTerminalId, receiptNumber: receipt.trim() }
      : kind === 'reconciliation'
        ? { terminalId: selectedTerminalId }
        : { terminalId: selectedTerminalId, amount: Number(amount), currencySymbol: currency.trim().toUpperCase(), minorUnitDivisor: 100 };
    await startOperation(kind, body);
  }

  async function submitDeviceFeature() {
    if (!selectedTerminalId || !deviceFeatureId) return;
    let deviceRequest: Record<string, any>;
    try {
      const parsed = JSON.parse(deviceRequestJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The request must be a JSON object.');
      deviceRequest = parsed;
    } catch (error) {
      setNotice(error instanceof Error ? `Invalid DeviceRequest JSON: ${error.message}` : 'Invalid DeviceRequest JSON.');
      return;
    }
    await startOperation('device', { terminalId: selectedTerminalId, featureId: deviceFeatureId, deviceRequest });
  }

  async function abort() {
    if (!operation) return;
    setBusy(true); setNotice('');
    try { setOperation(await api<Op>(`/api/operations/${encodeURIComponent(operation.operationId)}/abort`, { method: 'POST' })); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Abort request failed'); }
    finally { setBusy(false); }
  }

  async function getLatest() {
    setBusy(true); setLatestError(''); setLatest(null); setNotice('');
    try {
      const found = await api<Record<string, any>>(`/api/payments/latest?terminalId=${encodeURIComponent(selectedTerminalId)}`);
      setLatest(found);
      setReceiptToPrint(getReceiptContent(found, 'Latest payment'));
    } catch (e) { setLatestError(e instanceof Error ? e.message : 'Could not retrieve latest payment'); }
    finally { setBusy(false); }
  }

  async function printOnTerminal() {
    if (!receiptToPrint?.printerCommands || !selectedTerminalId) return;
    setBusy(true); setNotice('');
    try {
      const started = await api<Op>('/api/operations/print', {
        method: 'POST',
        body: JSON.stringify({ terminalId: selectedTerminalId, receiptData: receiptToPrint.printerCommands }),
      });
      setOperation(started);
      if (started.state === 'unknown') setNotice('Print request outcome is uncertain; checking terminal status.');
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not start terminal receipt print'); }
    finally { setBusy(false); }
  }

  async function unlockSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true); setSettingsMessage('');
    try {
      const data = await api<{ terminals: TerminalEdit[] }>('/api/admin/terminals', { headers: { 'X-Admin-Pin': adminPin } });
      setSettings(data.terminals);
      setSettingsUnlocked(true);
      setSettingsMessage('Terminal settings unlocked.');
    } catch (e) { setSettingsMessage(e instanceof Error ? e.message : 'Could not unlock terminal settings'); }
    finally { setSettingsBusy(false); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true); setSettingsMessage('');
    try {
      const saved = await api<{ terminals: TerminalEdit[] }>('/api/admin/terminals', {
        method: 'PUT',
        headers: { 'X-Admin-Pin': adminPin },
        body: JSON.stringify({ terminals: settings.map(({ configured: _configured, ...terminal }) => terminal) }),
      });
      setSettings(saved.terminals);
      const updatedConfig = await api<TerminalConfig>('/api/config');
      setConfig(updatedConfig);
      setSettingsMessage('Terminal names and request settings saved.');
    } catch (e) { setSettingsMessage(e instanceof Error ? e.message : 'Could not save terminal settings'); }
    finally { setSettingsBusy(false); }
  }

  function updateSetting(index: number, field: 'name' | 'label' | 'initiatingParty' | 'poiId', value: string) {
    setSettings(current => current.map((terminal, i) => i === index ? { ...terminal, [field]: value } : terminal));
  }

  async function unlockProducts(event: FormEvent) {
    event.preventDefault();
    setProductSettingsBusy(true);
    setProductSettingsMessage('');
    try {
      const data = await api<ProductCatalog>('/api/admin/products', { headers: { 'X-Admin-Pin': productAdminPin } });
      setProductCatalogDraft(data);
      setProductDrafts(data.products.map(product => ({ ...product, price: (product.priceMinor / data.minorUnitDivisor).toFixed(Math.log10(data.minorUnitDivisor)), description: product.description ?? '', image: product.image ?? '' })));
      setProductsUnlocked(true);
      setProductSettingsMessage('Product catalog unlocked.');
    } catch (e) { setProductSettingsMessage(e instanceof Error ? e.message : 'Could not unlock product catalog'); }
    finally { setProductSettingsBusy(false); }
  }

  async function saveProducts(event: FormEvent) {
    event.preventDefault();
    if (!productCatalogDraft) return;
    setProductSettingsBusy(true);
    setProductSettingsMessage('');
    try {
      const products = productDrafts.map(product => ({
        id: product.id.trim(), name: product.name.trim(), category: product.category.trim(),
        priceMinor: Math.round(Number(product.price) * productCatalogDraft.minorUnitDivisor),
        ...(product.description.trim() ? { description: product.description.trim() } : {}),
        ...(product.image.trim() ? { image: product.image.trim() } : {}),
      }));
      const updated = await api<ProductCatalog>('/api/admin/products', {
        method: 'PUT',
        headers: { 'X-Admin-Pin': productAdminPin },
        body: JSON.stringify({ ...productCatalogDraft, products }),
      });
      setCatalog(updated);
      setProductCatalogDraft(updated);
      setProductDrafts(updated.products.map(product => ({ ...product, price: (product.priceMinor / updated.minorUnitDivisor).toFixed(Math.log10(updated.minorUnitDivisor)), description: product.description ?? '', image: product.image ?? '' })));
      setProductSettingsMessage('Product catalog saved. The register now uses the updated products.');
    } catch (e) { setProductSettingsMessage(e instanceof Error ? e.message : 'Could not save product catalog'); }
    finally { setProductSettingsBusy(false); }
  }

  function addProduct() {
    const id = `product-${Date.now().toString(36)}`;
    setProductDrafts(current => [...current, { id, name: 'New product', category: 'Other', price: '1.00', description: '', image: '' }]);
  }

  function updateProduct(index: number, field: keyof ProductDraft, value: string) {
    setProductDrafts(current => current.map((product, i) => i === index ? { ...product, [field]: value } : product));
  }

  function lockProducts() {
    setProductsUnlocked(false);
    setProductAdminPin('');
    setProductCatalogDraft(null);
    setProductDrafts([]);
  }

  const operationStatus = <section className="card status-card">
    <div className="card-title"><div><span className="eyebrow">LIVE STATUS</span><h3>Worldline operation</h3></div><span className="step">STATUS</span></div>
    {!operation || operation.terminalId !== selectedTerminalId ? <div className="empty-state"><div className="empty-icon">↗</div><strong>Ready for an operation</strong><p>The selected terminal's current operation and result will appear here.</p></div> : <>
      <div className={`state-banner ${operation.state}`}><span className="state-dot" /><div><strong>{stateLabel(operation.state)}</strong><span>{operation.message || (operation.state === 'pending' ? 'Waiting for the Worldline webhook response.' : operation.state === 'completed' ? 'Terminal returned the final operation response.' : operation.state === 'failed' ? 'The terminal did not accept the operation.' : 'Requesting operation status from terminal…')}</span></div></div>
      <div className="meta-row"><span>Terminal</span><span>{selectedTerminal?.label ?? operation.terminalId}</span></div>
      <div className="meta-row"><span>Operation</span><code>{operation.operationId}</code></div>
      <div className="meta-row"><span>Type</span><span>{labels[operation.kind]}</span></div>
      <div className="meta-row"><span>Started</span><span>{new Date(operation.createdAt).toLocaleTimeString()}</span></div>
      {operation.result && <div className="result-box"><div className="result-heading">FINAL RESPONSE</div><div className="meta-row"><span>Result</span><strong className={result?.transactionOutcome === 'Approved' || result?.printResult === 'Success' ? 'approved' : ''}>{result?.transactionOutcome ?? result?.printResult ?? 'Completed'}</strong></div>{result?.outcomeDescription && <div className="meta-row"><span>Description</span><span>{result.outcomeDescription}</span></div>}{result?.receiptNumber !== undefined && <div className="meta-row"><span>Receipt</span><span>{result.receiptNumber}</span></div>}{result?.approvalCode && <div className="meta-row"><span>Approval code</span><span>{result.approvalCode}</span></div>}{result?.amounts && <div className="meta-row"><span>Amount</span><span>{result.amounts.total !== undefined ? `${result.amounts.total} ${responseCurrency ?? ''}` : formatPrice(result.amounts.base ?? 0)}</span></div>}<details><summary>Full terminal response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></div>}
      {operationIsActive && operation.kind !== 'reconciliation' && operation.kind !== 'print' && <button className="abort" type="button" onClick={abort} disabled={busy || operation.state === 'abort-requested'}>{operation.state === 'abort-requested' ? 'Abort requested…' : 'Abort operation'}</button>}
      {operation.state === 'abort-requested' && <p className="field-note">Worldline accepted the abort signal; the terminal’s final response will confirm whether it cancelled.</p>}
    </>}
    {notice && <div className="notice" role="alert">{notice}</div>}
  </section>;

  const latestPaymentPanel = (
    <section className="card latest-card"><div className="latest-copy"><span className="eyebrow">PAYMENT RECEIPT</span><h3>Latest payment</h3><p>View and print the latest approved payment receipt.</p></div><button className="secondary" type="button" onClick={getLatest} disabled={busy || operationIsActive || !selectedTerminalId}>{busy ? 'Working…' : 'Get latest payment'}<span>↗</span></button>{latestError && <div className="notice latest-notice">{latestError}</div>}{latest && <div className="latest-result"><div className="meta-row"><span>Outcome</span><strong className={latest.transactionOutcome === 'Approved' ? 'approved' : ''}>{latest.transactionOutcome ?? '—'}</strong></div><div className="meta-row"><span>Receipt</span><span>{latest.receiptNumber ?? '—'}</span></div><div className="meta-row"><span>Amount</span><span>{latest.amounts?.total ?? latest.amounts?.base ?? '—'} {latest.amounts?.currency?.symbol ?? latest.amounts?.currencySymbol ?? ''}</span></div><details><summary>Full terminal response</summary><pre>{JSON.stringify(latest, null, 2)}</pre></details></div>}{receiptToPrint && <div className="receipt-actions"><div><strong>{receiptToPrint.source}</strong><span>{receiptToPrint.receiptNumber ? ` · Receipt ${receiptToPrint.receiptNumber}` : ''}</span></div><div className="receipt-buttons"><button className="secondary" type="button" onClick={() => { if (!receiptToPrint.plain) return; if (!printPlainReceipt(receiptToPrint.plain)) setNotice('Allow pop-ups for this site to print the receipt.'); }} disabled={!receiptToPrint.plain}>Print on this device</button><button className="secondary" type="button" onClick={printOnTerminal} disabled={busy || operationIsActive || !receiptToPrint.printerCommands}>{operation?.kind === 'print' && operationIsActive ? 'Printing…' : 'Print on terminal'}</button></div>{!receiptToPrint.printerCommands && <p className="field-note">This response has no receipt text for terminal printing. Plain-text printing may still be available.</p>}</div>}</section>
  );

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">W</div><div><span className="eyebrow">WORLDLINE CLOUD TERMINALS</span><h1>Showroom ECR</h1></div></div>
      <div className="terminal-pill"><span className={`dot ${config ? 'online' : ''}`} />{selectedTerminal?.label ?? 'Connecting to backend…'}{selectedTerminal ? ` · ${selectedTerminal.address}` : ''}</div>
    </header>

    <section className="intro"><div><span className="eyebrow">ECR · ASYNCHRONOUS MODE</span><h2>Showroom ECR</h2><p>Build a product cart or start a manual terminal operation.</p></div><div className="intro-badge">TEST / SHOWROOM</div></section>

    {config && config.terminals.length > 1 && <div className="terminal-toolbar"><label htmlFor="terminal-select">Active terminal</label><select id="terminal-select" value={selectedTerminalId} onChange={e => { setLatest(null); setLatestError(''); setReceiptToPrint(null); setNotice(''); setSelectedTerminalId(e.target.value); }} disabled={busy}><option value="" disabled>Select a terminal</option>{config.terminals.map(t => <option key={t.id} value={t.id}>{t.label}{t.name && t.name !== t.label ? ` · ${t.name}` : ''}{t.configured === false ? ' · credentials pending' : ''}</option>)}</select><span>Operations are tracked separately for each terminal.</span></div>}

    <div className="register-tabs" role="tablist" aria-label="Register mode">
      <button type="button" role="tab" aria-selected={view === 'products'} className={view === 'products' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('products'); setNotice(''); }}>Product register</button>
      <button type="button" role="tab" aria-selected={view === 'manual'} className={view === 'manual' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('manual'); setNotice(''); }}>Manual operations</button>
      <button type="button" role="tab" aria-selected={view === 'device'} className={view === 'device' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('device'); setNotice(''); }}>Device features</button>
      <button type="button" role="tab" aria-selected={view === 'settings'} className={view === 'settings' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('settings'); setNotice(''); setSettingsMessage(''); }}>Terminal settings</button>
      <button type="button" role="tab" aria-selected={view === 'product-settings'} className={view === 'product-settings' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('product-settings'); setProductSettingsMessage(''); }}>Product settings</button>
    </div>

    {view === 'products' ? <>
      <div className="product-layout">
        <section className="card catalog-card">
          <div className="card-title"><div><span className="eyebrow">PRODUCT CATALOG</span><h3>Tap to add products</h3></div><span className="step">{catalog?.products.length ?? '—'} ITEMS</span></div>
          {catalogError && <div className="notice" role="alert">{catalogError} Check `public/products.json` in the project root.</div>}
          {!catalog && !catalogError && <p className="muted">Loading product catalog…</p>}
          {catalog && <>
            <div className="category-list">{categories.map(value => <button type="button" key={value} className={category === value ? 'category-chip active' : 'category-chip'} onClick={() => setCategory(value)}>{value}</button>)}</div>
            <div className="product-grid">{visibleProducts.map(product => <button type="button" className="product-tile" key={product.id} onClick={() => changeCart(product.id, 1)} disabled={!selectedTerminalId || operationIsActive}>
              {product.image && <img className="product-image" src={product.image} alt={product.name} loading="lazy" onError={e => { e.currentTarget.hidden = true; }} />}
              <span className="product-category">{product.category}</span><strong>{product.name}</strong>{product.description && <span className="product-description">{product.description}</span>}<span className="product-price">{formatPrice(product.priceMinor)}</span>
            </button>)}</div>
            {visibleProducts.length === 0 && <p className="muted">No products in this category.</p>}
          </>}
        </section>

        <section className="card cart-card">
          <div className="card-title"><div><span className="eyebrow">CURRENT ORDER</span><h3>Cart <span className="cart-count">{cartLines.reduce((sum, line) => sum + line.quantity, 0)}</span></h3></div><button className="text-button" type="button" disabled={!cartLines.length || operationIsActive || busy} onClick={() => setCart({})}>Clear</button></div>
          {cartLines.length === 0 ? <div className="empty-cart"><div className="empty-icon">＋</div><strong>Cart is empty</strong><p>Select a product to start an order.</p></div> : <div className="cart-lines">{cartLines.map(({ product, quantity }) => <div className="cart-line" key={product.id}>
            <div className="cart-line-info"><strong>{product.name}</strong><span>{formatPrice(product.priceMinor)} each</span></div>
            <div className="quantity-control"><button type="button" aria-label={`Remove one ${product.name}`} onClick={() => changeCart(product.id, -1)} disabled={operationIsActive || busy}>−</button><span>{quantity}</span><button type="button" aria-label={`Add one ${product.name}`} onClick={() => changeCart(product.id, 1)} disabled={operationIsActive || busy}>＋</button></div>
            <strong className="line-total">{formatPrice(product.priceMinor * quantity)}</strong>
          </div>)}</div>}
          <div className="cart-total"><span>Total</span><strong>{formatPrice(cartTotalMinor)}</strong></div>
          <button className="primary checkout-button" type="button" disabled={busy || operationIsActive || !selectedTerminalId || !catalog || cartTotalMinor <= 0} onClick={checkout}>{busy ? 'Please wait…' : 'Pay at selected terminal'}<span>→</span></button>
          {latestPaymentPanel}
          <p className="security-note"><span>◆</span> Product lines stay in this register; the terminal receives the total amount only.</p>
          {operationStatus}
        </section>
      </div>
    </> : view === 'manual' ? <>
      <div className="layout">
        <section className="card transaction-card">
          <div className="card-title"><div><span className="eyebrow">MANUAL TRANSACTION</span><h3>Operation</h3></div><span className="step">01</span></div>
          <div className="tabs" role="tablist">{(['payment', 'refund', 'reversal', 'reconciliation'] as Kind[]).map(value => <button type="button" key={value} role="tab" aria-selected={kind === value} className={kind === value ? 'tab selected' : 'tab'} disabled={operationIsActive || busy} onClick={() => { setKind(value); setNotice(''); }}>{labels[value]}</button>)}</div>
          <form onSubmit={submitManual}>
            {kind === 'payment' || kind === 'refund' ? <>
              <label>Amount <span className="hint">minor units (e.g. 1000 = 10.00)</span></label>
              <div className="amount-row"><input className="amount-input" type="number" min="1" step="1" required value={amount} onChange={e => setAmount(e.target.value)} disabled={operationIsActive || busy} /><select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)} disabled={operationIsActive || busy}><option>SEK</option><option>EUR</option><option>USD</option><option>NOK</option><option>DKK</option><option>GBP</option></select></div>
            </> : kind === 'reversal' ? <><label htmlFor="receipt">Original local receipt number</label><input id="receipt" type="text" required maxLength={6} placeholder="e.g. 000013" value={receipt} onChange={e => setReceipt(e.target.value)} disabled={operationIsActive || busy} /><p className="field-note">Reversals can reference payments saved by this backend during the current session.</p></> : <div className="field-note"><strong>Acquirer reconciliation / day end</strong><br />Sends `ReconciliationType: AcquirerReconciliation` to the selected terminal and waits for the async webhook result. This may initiate terminal day-end settlement.</div>}
            <button className="primary" type="submit" disabled={busy || operationIsActive || !config || !selectedTerminalId}>{busy ? 'Please wait…' : `Start ${labels[kind].toLowerCase()}`}<span>→</span></button>
          </form>
          {latestPaymentPanel}
          <p className="security-note"><span>◆</span> Terminal credentials stay on the backend. Never retry while an operation outcome is unknown.</p>
        </section>
        {operationStatus}
      </div>
    </> : view === 'device' ? <>
      <div className="layout device-layout">
        <section className="card device-card">
          <div className="card-title"><div><span className="eyebrow">WORLDLINE DEVICE API</span><h3>Device feature console</h3></div><span className="step">ASYNC</span></div>
          <p className="field-note">Select a UI, input, or print example from the OpenAPI specification. The backend creates a fresh exchange ID, webhook URL, and trusted terminal environment for each request.</p>
          <label htmlFor="device-feature-select">Device feature</label>
          <select id="device-feature-select" value={deviceFeatureId} disabled={busy || operationIsActive || !deviceFeatures.length} onChange={event => {
            const selected = deviceFeatures.find(feature => feature.id === event.target.value);
            setDeviceFeatureId(event.target.value);
            setDeviceRequestJson(selected ? JSON.stringify(selected.deviceRequest, null, 2) : '');
            setNotice('');
          }}>
            {deviceFeatures.map(feature => <option key={feature.id} value={feature.id}>{feature.label}</option>)}
          </select>
          <p className="device-description">{deviceFeatures.find(feature => feature.id === deviceFeatureId)?.description}</p>
          <label htmlFor="device-request-json">DeviceRequest fields <span className="hint">JSON editor</span></label>
          <textarea id="device-request-json" className="device-json-editor" spellCheck={false} value={deviceRequestJson} onChange={event => setDeviceRequestJson(event.target.value)} disabled={busy || operationIsActive} />
          <p className="field-note">Edit the selected example as needed. Send only the contents of Nexo `DeviceRequest`; do not add Header or wrapper fields. Unsupported features may be rejected by the terminal.</p>
          <button className="primary" type="button" onClick={() => void submitDeviceFeature()} disabled={busy || operationIsActive || !config || !selectedTerminalId || !deviceFeatureId || selectedTerminal?.configured === false}>{busy ? 'Please wait…' : `Send ${deviceFeatures.find(feature => feature.id === deviceFeatureId)?.label ?? 'device request'}`}<span>→</span></button>
        </section>
        {operationStatus}
      </div>
    </> : view === 'settings' ? <section className="card settings-card">
      <div className="card-title"><div><span className="eyebrow">BACKEND-MANAGED</span><h3>Worldline terminal settings</h3></div><span className="step">ADMIN</span></div>
      {!config?.settingsEnabled && <div className="notice" role="alert">Terminal settings are locked. Configure `ADMIN_PIN` in the backend environment to unlock this page.</div>}
      {!settingsUnlocked ? <form className="settings-unlock" onSubmit={unlockSettings}>
        <p>Set display names and non-secret request identity settings for the configured terminals. Credentials stay on the backend.</p>
        <label htmlFor="admin-pin">Administrator PIN</label><input id="admin-pin" type="password" autoComplete="current-password" value={adminPin} onChange={e => setAdminPin(e.target.value)} disabled={!config?.settingsEnabled || settingsBusy} />
        <button className="primary settings-submit" type="submit" disabled={!config?.settingsEnabled || settingsBusy || !adminPin}>{settingsBusy ? 'Checking…' : 'Unlock terminal settings'}<span>→</span></button>
      </form> : <form onSubmit={saveSettings}>
        <p className="field-note settings-note">Edit terminal name, selector label, Nexo InitiatingParty, and optional POI identification. UMID, UTID, and JWT are deliberately managed in the backend/Render environment and are never sent to this browser.</p>
        {settings.map((terminal, index) => <div className="terminal-settings-card" key={terminal.id}>
          <div className="card-title"><div><span className="eyebrow">{terminal.id}</span><h3>{terminal.label || terminal.name}</h3></div><span className="step">{terminal.configured ? 'READY' : 'CREDENTIALS PENDING'}</span></div>
          <div className="catalog-settings-meta terminal-settings-fields">
            <label>Display name<input value={terminal.name} maxLength={80} onChange={e => updateSetting(index, 'name', e.target.value)} disabled={settingsBusy} required /></label>
            <label>Selector label<input value={terminal.label} maxLength={80} onChange={e => updateSetting(index, 'label', e.target.value)} disabled={settingsBusy} required /></label>
            <label>Nexo InitiatingParty ID<input value={terminal.initiatingParty} maxLength={35} onChange={e => updateSetting(index, 'initiatingParty', e.target.value)} disabled={settingsBusy} required /></label>
            <label>POI identification <span className="hint">optional</span><input value={terminal.poiId} maxLength={80} onChange={e => updateSetting(index, 'poiId', e.target.value)} disabled={settingsBusy} placeholder="Leave blank unless Worldline supplies one" /></label>
          </div>
          <p className="field-note">{terminal.configured ? 'UMID, UTID, and JWT are present in backend environment.' : 'Add this terminal’s UMID, UTID, and JWT in backend environment variables before use.'}</p>
        </div>)}
        <div className="settings-actions"><button className="primary settings-save" type="submit" disabled={settingsBusy}>{settingsBusy ? 'Saving…' : 'Save terminal settings'}<span>→</span></button></div>
        <button className="text-button lock-settings" type="button" onClick={() => { setSettingsUnlocked(false); setSettings([]); setAdminPin(''); }}>Lock terminal settings</button>
      </form>}
      {settingsMessage && <div className="notice" role="status">{settingsMessage}</div>}
    </section> : view === 'product-settings' ? <section className="card settings-card product-settings-card">
      <div className="card-title"><div><span className="eyebrow">BACKEND-MANAGED</span><h3>Product catalog</h3></div><span className="step">ADMIN</span></div>
      {!config?.settingsEnabled && <div className="notice" role="alert">Product editing is locked. Configure `ADMIN_PIN` in the backend `.env` and restart the app.</div>}
      {!productsUnlocked ? <form className="settings-unlock" onSubmit={unlockProducts}>
        <p>Enter the administrator PIN to edit product names, categories, prices, and currency.</p>
        <label htmlFor="product-admin-pin">Administrator PIN</label><input id="product-admin-pin" type="password" autoComplete="current-password" value={productAdminPin} onChange={e => setProductAdminPin(e.target.value)} disabled={!config?.settingsEnabled || productSettingsBusy} />
        <button className="primary settings-submit" type="submit" disabled={!config?.settingsEnabled || productSettingsBusy || !productAdminPin}>{productSettingsBusy ? 'Checking…' : 'Unlock product editor'}<span>→</span></button>
      </form> : productCatalogDraft && <form onSubmit={saveProducts}>
        <p className="field-note settings-note">Changes are saved by the backend in `data/products.json` and remain after restart. Prices are entered in major currency units; the terminal receives minor units.</p>
        <div className="catalog-settings-meta">
          <label>Currency code<input value={productCatalogDraft.currency} maxLength={3} onChange={e => setProductCatalogDraft(current => current ? { ...current, currency: e.target.value.toUpperCase() } : current)} disabled={productSettingsBusy} /></label>
          <label>Minor-unit divisor<select value={productCatalogDraft.minorUnitDivisor} onChange={e => setProductCatalogDraft(current => current ? { ...current, minorUnitDivisor: Number(e.target.value) } : current)} disabled={productSettingsBusy}><option value={1}>1 (no decimals)</option><option value={10}>10 (1 decimal)</option><option value={100}>100 (2 decimals)</option><option value={1000}>1000 (3 decimals)</option></select></label>
        </div>
        <div className="product-editor-head"><span>ID</span><span>Product name</span><span>Category</span><span>Price ({productCatalogDraft.currency})</span><span>Description</span><span>Image path / HTTPS URL</span><span /></div>
        {productDrafts.map((product, index) => <div className="product-editor-row" key={`${product.id}-${index}`}>
          <input aria-label="Product ID" value={product.id} onChange={e => updateProduct(index, 'id', e.target.value)} disabled={productSettingsBusy} />
          <input aria-label="Product name" value={product.name} onChange={e => updateProduct(index, 'name', e.target.value)} disabled={productSettingsBusy} />
          <input aria-label="Category" value={product.category} onChange={e => updateProduct(index, 'category', e.target.value)} disabled={productSettingsBusy} />
          <input aria-label="Product price" type="number" min="0.01" step={1 / productCatalogDraft.minorUnitDivisor} value={product.price} onChange={e => updateProduct(index, 'price', e.target.value)} disabled={productSettingsBusy} />
          <input aria-label="Product description" value={product.description} onChange={e => updateProduct(index, 'description', e.target.value)} disabled={productSettingsBusy} />
          <input aria-label="Product image path or HTTPS URL" value={product.image} onChange={e => updateProduct(index, 'image', e.target.value)} placeholder="/products/images/example.svg" disabled={productSettingsBusy} />
          <button className="remove-terminal" type="button" aria-label={`Remove ${product.name}`} onClick={() => setProductDrafts(current => current.filter((_, i) => i !== index))} disabled={productSettingsBusy}>×</button>
        </div>)}
        <div className="settings-actions"><button className="secondary" type="button" onClick={addProduct} disabled={productSettingsBusy || productDrafts.length >= 250}>＋ Add product</button><button className="primary settings-save" type="submit" disabled={productSettingsBusy}>{productSettingsBusy ? 'Saving…' : 'Save product catalog'}<span>→</span></button></div>
        <button className="text-button lock-settings" type="button" onClick={lockProducts}>Lock product editor</button>
      </form>}
      {productSettingsMessage && <div className="notice" role="status">{productSettingsMessage}</div>}
    </section> : null}



    <footer><span>Worldline Terminal API · Async mode</span><span>Showroom integration · Webhook callback</span></footer>
  </main>;
}

function stateLabel(state: OperationState) {
  const names: Record<OperationState, string> = {
    starting: 'Starting', pending: 'In progress', unknown: 'Outcome unknown — checking',
    'abort-requested': 'Abort requested', completed: 'Completed', failed: 'Not accepted',
  };
  return names[state];
}
