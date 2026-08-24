// يبني حمولة get_data حقيقية من لقطة المتجر — بتستخدمها اختبارات المتصفح
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.SCC_DATA || '/root/work/data';
const tmp = path.join(os.tmpdir(), 'scc-worker-payload.mjs');
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
const W = await import('file://' + tmp);

const j = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const orders = j('orders_all.json');
const catalog = W.buildCatalogIndex(j('catalog_active.json'), { variantsTruncated: [], collectionsTruncated: 0 });

const range = { from: '2026-08-17', to: '2026-08-23' };
const prevRange = W.previousRange(range.from, range.to);
const inRange = (o, r) => { const d = W.cairoDay(o.createdAt); return d >= r.from && d <= r.to; };
const settings = { leadTimeDays: 21, marginFloorPct: 20 };

const cur  = W.buildAnalytics(orders.filter(o => inRange(o, range)), new Map(), catalog, range, settings);
const prevOrders = orders.filter(o => inRange(o, prevRange));
const prev = prevOrders.length ? W.buildAnalytics(prevOrders, new Map(), catalog, prevRange, settings) : null;

const ops = {
  unavailable: false,
  packers: [{ employee: 'Abo_Selim', orders: 640, items: 780, activeDays: 14, ordersPerDay: 45.7 }],
  statusChanges: [{ employee: 'Ahmed_Ibraheem', newStatus: 'Ready', n: 312 }, { employee: 'Ahmed_Ibraheem', newStatus: 'Shipped', n: 240 }],
  cash: [{ type: 'payment', n: 210, total: 512300 }, { type: 'refund', n: 6, total: 9800 }],
  cashByDay: [], packingByDay: [], audit: [], auditChecks: 12, auditAdjustments: 12, auditNetDelta: -4,
  syncMismatch: 17, mismatchSkus: ['GT1 / White / 43 (wp_stock_sync) ×4'], duplicatesFound: 9,
  printing: [], bosta: [],
};
const insights = W.buildInsights(cur, prev, { range, prevRange, ops, ...settings });

const payload = {
  range: { from: range.from, to: range.to, days: W.daysBetweenStr(range.from, range.to), prev: prevRange },
  settings, settingsSig: JSON.stringify(settings),
  rowsIncluded: true, rowsOmittedReason: null,
  boxes: cur.boxes, rows: cur.rows, warnings: cur.warnings,
  orderBoxes: cur.orderBoxes, orderRows: cur.orderRows, orderWarnings: cur.orderWarnings,
  kpi: cur.kpi, prevKpi: prev?.kpi || null,
  prevBoxes: prev?.boxes || null, prevOrderBoxes: prev?.orderBoxes || null,
  series: cur.series, prevSeries: prev?.series || null,
  geo: cur.geo, couriers: cur.couriers, zones: cur.zones, channels: cur.channels,
  packers: cur.packers, byDow: cur.byDow,
  products: cur.products, styles: cur.styles, options: cur.options,
  vendors: cur.vendors, types: cur.types, collections: cur.collections,
  sizeCurve: cur.sizeCurve, coreSizes: cur.coreSizes,
  reasons: cur.reasons, aging: cur.aging, customers: cur.customers,
  inventory: cur.inventory, dataQuality: cur.dataQuality,
  insights, ops,
  catalogMeta: { builtAt: catalog.builtAt, source: 'kv', variants: catalog.variants.length, products: catalog.productCount, vendors: catalog.vendors.length },
  counts: { ordersScanned: orders.length, candidatesFetched: 77, prevOrdersScanned: prev?.orderBoxes.totalOrders ?? null },
  lastUpdated: new Date().toISOString(), source: 'shopify',
};
fs.writeFileSync(path.join(__dirname, 'payload.json'), JSON.stringify(payload));
console.log('payload.json written —', (JSON.stringify(payload).length / 1024).toFixed(0), 'KB ·', insights.length, 'insights');
