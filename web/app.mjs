import { createBrowserAdapter } from './browser-adapter.mjs';

const $ = id => document.getElementById(id);
const money = (minor, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
const text = (id, value) => { $(id).textContent = value; };
const state = { config: null, adapter: null, documents: [], selectedId: new URLSearchParams(location.search).get('documentId'), doc: null, history: { events: [], delivery: null }, erp: { requests: [], businessWrites: 0 }, busy: false, stale: new Map() };

function localAdapter(config) {
  return { async request(path, { method = 'GET', body, role = 'submitter' } = {}) {
    const demo = path.startsWith('/demo/');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!demo) headers.Authorization = `Bearer ${role === 'reviewer' ? config.reviewerToken : config.submitterToken}`;
    const response = await fetch(demo ? path : `${config.apiBase || '/api'}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let result;
    try { result = await response.json(); } catch { throw new Error(`HTTP ${response.status}: expected a JSON response.`); }
    if (!response.ok) {
      const info = result.error;
      const error = new Error((typeof info === 'object' ? info.message : result.message) || info || `HTTP ${response.status}`);
      Object.assign(error, { status: response.status, code: info?.code || result.code });
      throw error;
    }
    return result;
  } };
}
function notice(message, tone = '') {
  text('notice', message);
  $('notice').className = `notice ${tone}`;
  $('notice').hidden = !message;
}
function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('busy', value);
  document.querySelector('.demo').setAttribute('aria-busy', String(value));
  document.querySelector('.demo').inert = value;
}
async function refresh() {
  const [list, erp] = await Promise.all([state.adapter.request('/documents'), state.adapter.request('/demo/erp')]);
  state.documents = list.documents.sort((a, b) => (a.extracted.invoiceNumber === 'DEMO-2048' ? -1 : 0) - (b.extracted.invoiceNumber === 'DEMO-2048' ? -1 : 0));
  state.erp = erp;
  if (!state.documents.some(doc => doc.id === state.selectedId)) state.selectedId = state.documents[0]?.id;
  state.doc = state.documents.find(doc => doc.id === state.selectedId);
  state.history = state.doc ? await state.adapter.request(`/documents/${state.doc.id}/history`) : { events: [], delivery: null };
  render();
}
async function perform(work) {
  if (state.busy) return;
  setBusy(true);
  try { await work(); await refresh(); }
  catch (error) { notice(`${error.status ? `HTTP ${error.status} · ` : ''}${error.message}`, 'error'); }
  finally { setBusy(false); }
}
function invoiceLabel(doc) { return doc.extracted.invoiceNumber || doc.intakeKey || 'Invoice'; }
function render() {
  const doc = state.doc;
  const delivery = state.history.delivery;
  if (!doc) { notice('Create an invoice through the API, or reset the demo to load synthetic examples.', 'info'); return; }
  const review = doc.status === 'REVIEW';
  const synced = doc.status === 'SYNCED';
  const rejected = doc.status === 'REJECTED';
  const attempted = (delivery?.attempts || 0) > 0;
  const firstInvoice = doc.extracted.invoiceNumber === 'DEMO-2048';
  $('document-tabs').replaceChildren(...state.documents.map(item => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `document-tab ${item.id === doc.id ? 'active' : ''}`;
    button.textContent = invoiceLabel(item);
    button.setAttribute('aria-pressed', String(item.id === doc.id));
    if (item.extracted.invoiceNumber === 'DEMO-2049') { const hint = document.createElement('small'); hint.textContent = ' try rejection'; button.append(hint); }
    button.addEventListener('click', () => perform(async () => { state.selectedId = item.id; notice(''); $('reject-form').hidden = true; $('reject-toggle').setAttribute('aria-expanded', 'false'); }));
    return button;
  }));
  if (state.config.mode === 'postgres') {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'document-tab'; button.textContent = '↻ Refresh'; button.addEventListener('click', () => perform(async () => { notice('Invoice list refreshed.'); })); $('document-tabs').append(button);
  }
  text('supplier', doc.extracted.supplier || 'Synthetic supplier');
  text('invoice-number', invoiceLabel(doc));
  text('issued-at', doc.extracted.issuedAt || 'Synthetic invoice');
  text('currency', doc.extracted.currency || 'USD');
  text('revision-label', `REV ${doc.revision}`);
  text('document-status', doc.status);
  $('document-status').className = `pill ${doc.status.toLowerCase()}`;
  $('amount').value = (doc.extracted.amountMinor / 100).toFixed(2);
  $('amount').disabled = !review;
  $('save').disabled = !review;
  $('use-correction').hidden = !firstInvoice || !review;
  text('amount-help', review ? (firstInvoice ? 'The source total is $125.80. Correct the extracted amount.' : 'Check the supplier details, then approve or reject this invoice.') : rejected ? `Rejected: ${doc.rejectionReason}` : `Revision ${doc.revision} is frozen for ERP delivery.`);
  text('snapshot-status', doc.approvedSnapshot ? `Revision ${doc.approvedSnapshot.revision} · ${money(doc.approvedSnapshot.extracted.amountMinor, doc.extracted.currency)}` : rejected ? 'Rejected · delivery stays closed' : 'Awaiting review');
  text('approve', `Approve revision ${doc.revision} →`);
  $('approve').disabled = !review;
  $('reject-toggle').disabled = !review;
  $('reject-confirm').disabled = !review;
  $('stale').disabled = doc.revision < 2;
  text('stale-help', doc.revision < 2 ? 'Available after a correction' : `Sends revision ${doc.revision - 1}`);
  const stale = state.stale.get(doc.id);
  $('stale-result').hidden = !stale;
  if (stale) text('stale-result', stale.message);
  text('attempt-count', state.erp.requests.length);
  text('write-count', state.erp.businessWrites);
  text('delivery-key', delivery?.idempotencyKey || (rejected ? 'Rejection creates zero delivery jobs' : 'Created on approval'));
  text('payload', doc.approvedSnapshot ? JSON.stringify(doc.approvedSnapshot, null, 2) : rejected ? 'Rejected invoice. Delivery stays closed.' : 'Approve a revision to freeze its payload.');
  $('receipt-block').hidden = !delivery?.remoteResponse;
  if (delivery?.remoteResponse) text('receipt', JSON.stringify(delivery.remoteResponse.body ?? delivery.remoteResponse, null, 2));
  $('deliver').disabled = !delivery || synced || delivery.status === 'LEASED';
  text('deliver', synced ? '✓ Delivery reconciled' : attempted ? 'Retry same delivery →' : 'Deliver to ERP →');
  text('delivery-status', synced ? `Synced · ${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}` : attempted ? 'Response lost · retry ready' : delivery ? 'Approved · ready to deliver' : rejected ? 'Closed · rejected' : 'Waiting for approval');
  $('delivery-status').className = `signal ${synced ? 'success' : attempted ? 'retry' : ''}`;
  text('delivery-copy', synced ? `Receipt stored for this invoice: ${delivery.attempts} delivery attempt${delivery.attempts === 1 ? '' : 's'}, ${state.erp.requests.filter(req => req.idempotencyKey === delivery.idempotencyKey && !req.duplicate).length} business write. ${delivery.attempts > 1 ? 'The ERP recognized the repeated key and returned the original receipt.' : 'The ERP returned its receipt on the first attempt.'}` : attempted ? 'The ERP accepted the invoice, then its response was lost. The frozen payload and original key are ready to retry.' : rejected ? 'The rejected invoice has zero delivery jobs. Select DEMO-2048 to try approval and retry.' : state.erp.requests.length === 0 ? 'The first delivery deliberately loses its response after the ERP accepts the invoice. Retry to recover the same receipt.' : 'Deliver this approved snapshot to the synthetic ERP and store its receipt. The demo-wide response-loss scenario has already run.');
  const step = rejected ? -1 : synced ? 4 : attempted ? 3 : delivery ? 2 : doc.revision >= 2 ? 1 : 0;
  ['review', 'approve', 'deliver', 'retry'].forEach((name, index) => { $(`step-${name}`).className = index < step ? 'done' : index === step ? 'active' : ''; });
  let next;
  if (rejected) next = 'Rejection recorded. Select DEMO-2048 to try the approval-to-ERP path.';
  else if (synced) next = 'Complete: inspect the matching keys and recovered receipt below. Try rejection on DEMO-2049.';
  else if (attempted) next = 'Click “Retry same delivery”. The ERP will return the receipt for the existing write.';
  else if (delivery) next = state.erp.requests.length === 0 ? 'Click “Deliver to ERP”. The first response will be lost after the ERP accepts the invoice.' : 'Click “Deliver to ERP” to send this frozen invoice and record its receipt.';
  else if (doc.revision >= 2) next = `Approve revision ${doc.revision}, or try a stale approval first to see the 409 guard.`;
  else if (firstInvoice) next = 'Change $128.50 to $125.80, then save the correction as revision 2.';
  else next = 'Review this invoice, or reject it with a reason to keep delivery closed.';
  text('next-step', next);
  renderTimeline();
}
function renderTimeline() {
  const { events, delivery } = state.history;
  const labels = { INTAKE: ['Invoice received', 'Extracted JSON enters the review queue.', ''], REVISED: ['Correction saved', 'The new revision becomes the review target.', 'blue'], APPROVED: ['Approved snapshot frozen', 'The decision and its delivery job are recorded together.', 'blue'], REJECTED: ['Invoice rejected', 'Delivery stays closed.', 'amber'], ERP_RETRY: ['ERP accepted · response lost', 'The worker schedules the same delivery for retry.', 'amber'], ERP_SYNCED: ['Delivery receipt recorded', 'The worker stores the ERP receipt and marks the invoice synced.', 'green'] };
  const items = [...events].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const stale = state.stale.get(state.selectedId);
  if (stale) items.push({ eventType: 'STALE', revision: stale.revision, createdAt: stale.at, details: {} });
  items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  $('timeline').replaceChildren(...items.map(event => {
    const [label, description, color] = event.eventType === 'STALE' ? ['HTTP 409 · stale approval', stale.message, 'blue'] : labels[event.eventType] || [event.eventType, '', ''];
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = `dot ${color}`; dot.setAttribute('aria-hidden', 'true');
    const time = document.createElement('time'); time.dateTime = event.createdAt; time.textContent = new Date(event.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const content = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `${label} · revision ${event.revision}`;
    const detail = document.createElement('p'); detail.textContent = event.eventType === 'REJECTED' ? `Reason: ${event.details.reason}` : description;
    content.append(title, detail);
    if (event.eventType.startsWith('ERP_') && delivery) {
      const request = state.erp.requests.filter(req => req.idempotencyKey === delivery.idempotencyKey)[Number(event.details.attempt) - 1];
      const key = document.createElement('p'); key.textContent = `Attempt ${event.details.attempt} · ${delivery.idempotencyKey}`; content.append(key);
      if (request) { const info = document.createElement('p'); info.textContent = `ERP: ${request.duplicate ? 'existing key · original receipt' : 'new key · accepted'} · cumulative business writes: ${request.remoteBusinessWrites}`; content.append(info); }
    }
    li.append(dot, time, content); return li;
  }));
}
$('use-correction').addEventListener('click', () => { $('amount').value = '125.80'; $('amount').focus(); notice('Amount set to $125.80. Save the correction to create a new revision.'); });
$('save').addEventListener('click', () => perform(async () => {
  const raw = $('amount').value;
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error('Enter a positive amount with up to two decimal places.');
  const doc = state.doc;
  await state.adapter.request(`/documents/${doc.id}/revise`, { method: 'POST', body: { expectedRevision: doc.revision, extracted: { ...doc.extracted, amountMinor: Math.round(value * 100) } } });
  notice(`Correction saved. Revision ${doc.revision + 1} is ready for review.`);
}));
$('approve').addEventListener('click', () => perform(async () => {
  const doc = state.doc;
  if (Math.round(Number($('amount').value) * 100) !== doc.extracted.amountMinor) throw new Error('Save the edited amount to create its revision, then approve.');
  await state.adapter.request(`/documents/${doc.id}/approve`, { method: 'POST', role: 'reviewer', body: { expectedRevision: doc.revision } });
  notice(`Revision ${doc.revision} approved. Its frozen payload and delivery key are ready.`);
}));
$('reject-toggle').addEventListener('click', () => { $('reject-form').hidden = !$('reject-form').hidden; $('reject-toggle').setAttribute('aria-expanded', String(!$('reject-form').hidden)); if (!$('reject-form').hidden) $('reject-reason').focus(); });
$('reject-form').addEventListener('submit', event => { event.preventDefault(); perform(async () => {
  await state.adapter.request(`/documents/${state.doc.id}/reject`, { method: 'POST', role: 'reviewer', body: { expectedRevision: state.doc.revision, reason: $('reject-reason').value.trim() } });
  $('reject-form').hidden = true; $('reject-toggle').setAttribute('aria-expanded', 'false'); notice('Rejection recorded. This invoice has zero delivery jobs.');
}); });
$('stale').addEventListener('click', () => perform(async () => {
  const revision = state.doc.revision - 1;
  const before = state.erp.businessWrites;
  try {
    await state.adapter.request(`/documents/${state.doc.id}/approve`, { method: 'POST', role: 'reviewer', body: { expectedRevision: revision } });
    notice('The server accepted the supplied revision. Refresh to inspect its current state.', 'info');
  } catch (error) {
    if (error.status !== 409) throw error;
    const erp = await state.adapter.request('/demo/erp');
    const delta = erp.businessWrites - before;
    const message = `409 · revision ${revision} is stale. Current revision: ${state.doc.revision}. ${delta} new ERP business writes${erp.businessWrites === 0 ? ' · total stays at 0' : ''}.`;
    state.stale.set(state.doc.id, { message, revision, at: new Date().toISOString() });
    notice(message);
  }
}));
$('deliver').addEventListener('click', () => perform(async () => {
  const result = await state.adapter.request('/demo/deliver', { method: 'POST', body: {} });
  if (result.outcome === 'retry') notice(`Queued delivery attempt ${result.attempts}: the ERP accepted the invoice; its response was lost. The original payload and key remain queued for retry.`, 'info');
  else if (result.outcome === 'synced') notice(`Receipt stored after ${result.attempts} delivery attempt${result.attempts === 1 ? '' : 's'}. Inspect the ERP counters and request log below.`);
  else notice(`Delivery worker: ${result.outcome}. Refresh the invoice state.`, 'info');
}));
$('reset').addEventListener('click', () => perform(async () => {
  await state.adapter.request('/demo/reset', { method: 'POST', body: {} });
  state.selectedId = null; state.stale.clear(); $('reject-form').hidden = true; $('reject-toggle').setAttribute('aria-expanded', 'false'); notice('Demo reset. Fresh synthetic invoices are ready.');
}));

async function start() {
  setBusy(true);
  try {
    const response = await fetch('./config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Configuration returned HTTP ${response.status}.`);
    state.config = await response.json();
    const live = state.config.mode === 'postgres';
    if (!live && state.config.mode !== 'browser') throw new Error('Choose browser or postgres in config.json.');
    state.adapter = live ? localAdapter(state.config) : createBrowserAdapter();
    text('mode-label', live ? 'Live local demo · real PostgreSQL + HTTP · synthetic ERP' : 'Browser simulation · synthetic invoices · state stays in this tab');
    document.querySelector('.mode-bar').classList.toggle('live', live);
    text('audit-mode', live ? 'POSTGRESQL AUDIT + HTTP REQUEST LOG' : 'IN-TAB SIMULATED EVENTS');
    if (live) text('proof-copy', 'You are using real PostgreSQL transactions and HTTP delivery against a synthetic ERP. Inspect the persisted audit events here or read the companion 13-scenario run.');
    await refresh();
  } catch (error) { notice(`Demo startup: ${error.message} Serve this folder over HTTP and reload.`, 'error'); text('mode-label', 'Demo configuration needs attention'); }
  finally { setBusy(false); }
}
start();
