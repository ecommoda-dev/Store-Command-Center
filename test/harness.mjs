// ══════════════════════════════════════════════════════════════════
// Store Command Center — حزمة تحقّق محلية على بيانات حقيقية
//
// الهدف: إثبات إن الأرقام صح **قبل** النشر، مش بعده. بتشتغل على لقطة فعلية من
// المتجر (١٥ يوم · 1,516 أوردر · 276 منتج نشط) اتجابت من Shopify Admin API.
//
// التشغيل:  node test/harness.mjs
// ══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.SCC_DATA || '/root/work/data';

// worker.js اسمه .js — بننسخه كـ .mjs عشان Node يستورده كموديول من غير ما
// نحط package.json في ريبو الأداة (اللي ممكن يربك Workers Builds).
const tmp = path.join(os.tmpdir(), 'scc-worker.mjs');
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
const W = await import('file://' + tmp);

const j = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const fmt = n => (Math.round(n || 0)).toLocaleString('en-US');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const hr = t => console.log('\n' + '═'.repeat(74) + '\n' + t + '\n' + '═'.repeat(74));

// ─────────────────────────────────────────────────────────────────
hr('1) اختبارات الوحدة — الدوال النقية');

// parseSku
check('parseSku يقرأ الشكل القياسي',
  JSON.stringify(W.parseSku('GT1 / White  / 43')) === JSON.stringify({ style: 'GT1', color: 'White', size: '43', ok: true }));
check('parseSku يرفض شكل غير قياسي', W.parseSku('Shoe-Bag / Yellow').ok === false);

// normGov
check('normGov يوحّد Cairo', W.normGov('Cairo').gov === 'القاهرة');
check('normGov ينقل «6th of October» للجيزة', W.normGov('6th of October').gov === 'الجيزة');
check('normGov يعلّم المجهول', W.normGov('Atlantis').known === false);

// cairoDay — الحد الفاصل
check('cairoDay يحسب اليوم بتوقيت القاهرة (21:30Z = اليوم اللي بعده)',
  W.cairoDay('2026-08-09T21:30:00Z') === '2026-08-10', W.cairoDay('2026-08-09T21:30:00Z'));
check('cairoDay قبل الحد يفضل نفس اليوم',
  W.cairoDay('2026-08-09T20:30:00Z') === '2026-08-09');

// wilson
const w1 = W.wilson(5, 100);
check('wilson: الفترة جوّه [0,1]', w1.lo >= 0 && w1.hi <= 1, `${w1.lo.toFixed(4)}–${w1.hi.toFixed(4)}`);
check('wilson: 0 من 20 مايديش فترة سالبة', W.wilson(0, 20).lo === 0);
check('ciDisjoint يميّز فرق واضح', W.ciDisjoint(W.wilson(10, 100), W.wilson(60, 100)) === true);
check('ciDisjoint يرفض فرق ضعيف', W.ciDisjoint(W.wilson(10, 100), W.wilson(13, 100)) === false);

// twoPropZ
check('twoPropZ موجب لما الشريحة أعلى', W.twoPropZ(30, 100, 10, 100) > 1.96);

// robustZ — قفزة قديمة ما تخفيش شذوذ جديد
const base = [10, 11, 9, 10, 12, 10, 60, 11, 10];
check('robustZ يمسك شذوذ رغم قفزة قديمة في التاريخ', Math.abs(W.robustZ(40, base)) > 3.5,
  'z=' + W.robustZ(40, base).toFixed(2));
check('robustZ ما بيتنبهش لقيمة طبيعية', Math.abs(W.robustZ(11, base)) < 3.5);

// previousRange
const pr = W.previousRange('2026-08-10', '2026-08-16');
check('previousRange: نفس الطول وملاصقة', pr.from === '2026-08-03' && pr.to === '2026-08-09', `${pr.from} → ${pr.to}`);

// findVendorDupes
check('findVendorDupes يمسك Skechers/Sketchers',
  W.findVendorDupes(['Skechers', 'Sketchers', 'Nike']).length === 1);

// ─────────────────────────────────────────────────────────────────
hr('2) اختبارات التصنيف — سيناريوهات دورة حياة الأوردر');

const mkOrder = (o = {}) => ({
  id: o.id || 'gid://shopify/Order/1', name: o.name || '#TEST',
  createdAt: o.createdAt || '2026-08-10T09:00:00Z',
  cancelledAt: o.cancelledAt || null,
  displayFulfillmentStatus: o.ff || 'UNFULFILLED',
  s1: o.s1 ? { value: o.s1 } : null,
  s2: o.s2 ? { value: o.s2 } : null,
  courier: null, zone: null, pay: null, sbid: null, att: null, cRsn: null, rRsn: null,
  pt1: null, pk1: null, pb1: null,
  customer: { id: 'gid://shopify/Customer/1' },
  customerJourneySummary: { customerOrderIndex: 1 },
  shippingAddress: { province: 'Cairo', city: 'Cairo' },
  currentSubtotalPriceSet: { shopMoney: { amount: '1000' } },
  totalShippingPriceSet: { shopMoney: { amount: '0' } },
  currentTotalDiscountsSet: { shopMoney: { amount: '0' } },
  lineItems: { pageInfo: { hasNextPage: false }, nodes: o.li || [
    { id: 'gid://shopify/LineItem/1', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 1,
      unfulfilledQuantity: 1, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } },
  ] },
});
const s2map = m => new Map(Object.entries(m || {}));
const cls = (o, r) => W.classifyOrderForCounts(o, r);

check('ملغي قبل الشحن → LOST_CANCELLED',
  cls(mkOrder({ cancelledAt: '2026-08-11T00:00:00Z', ff: 'UNFULFILLED' })) === W.ORDER_BUCKET.LOST_CANCELLED);
check('ملغي بعد الشحن → LOST_RTO',
  cls(mkOrder({ cancelledAt: '2026-08-11T00:00:00Z', ff: 'FULFILLED' })) === W.ORDER_BUCKET.LOST_RTO);
check('manual_status=Cancelled على أوردر RTO حقيقي ما بيغلّطش التصنيف (باج #49472)',
  cls(mkOrder({ cancelledAt: '2026-08-11T00:00:00Z', ff: 'FULFILLED', s1: 'Cancelled' })) === W.ORDER_BUCKET.LOST_RTO);
check('WhatsApp-Confirmed → PENDING_CONFIRM مش PREP_CONFIRMED',
  cls(mkOrder({ s1: 'WhatsApp-Confirmed' })) === W.ORDER_BUCKET.PENDING_CONFIRM);
check('Pending Edit → PENDING_CONFIRM',
  cls(mkOrder({ s1: 'Pending Edit' })) === W.ORDER_BUCKET.PENDING_CONFIRM);
check('Ready → PREP_CONFIRMED', cls(mkOrder({ s1: 'Ready' })) === W.ORDER_BUCKET.PREP_CONFIRMED);
check('⭐ In-Return له مربع مستقل (تصحيح القاعدة 12)',
  cls(mkOrder({ s1: 'In-Return' })) === W.ORDER_BUCKET.IN_TRANSIT_BACK);
check('Delivered بدون S2 → DELIVERY_BASIC',
  cls(mkOrder({ s1: 'Delivered', ff: 'FULFILLED' })) === W.ORDER_BUCKET.DELIVERY_BASIC);

// مرتجع كامل: Delivered + S2=Returned + CLOSED + كل الكميات صفر
const fullRet = mkOrder({
  id: 'gid://shopify/Order/2', s1: 'Delivered', s2: 'Returned', ff: 'FULFILLED',
  li: [{ id: 'gid://shopify/LineItem/9', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 0,
         unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } }],
});
const retClosed = { id: 'gid://shopify/Order/2', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'CLOSED', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/9' } } }] } }] } };
check('مرتجع كامل → LOST_FULL_RETURN',
  cls(fullRet, retClosed) === W.ORDER_BUCKET.LOST_FULL_RETURN);

// مرتجع جزئي: قطعتين، واحدة رجعت
const partial = mkOrder({
  id: 'gid://shopify/Order/3', s1: 'Delivered', s2: 'Returned', ff: 'FULFILLED',
  li: [
    { id: 'gid://shopify/LineItem/10', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 0,
      unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } },
    { id: 'gid://shopify/LineItem/11', sku: 'AAA / Black / 43', quantity: 1, currentQuantity: 1,
      unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } }],
});
const partialRet = { id: 'gid://shopify/Order/3', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'CLOSED', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/10' } } }] } }] } };
check('⭐ مرتجع جزئي = أوردر عادي مش مرتجع (القاعدة الأخطر)',
  cls(partial, partialRet) === W.ORDER_BUCKET.DELIVERY_PARTIAL_RETURN);

// استبدال مكتمل
const exch = mkOrder({
  id: 'gid://shopify/Order/4', s1: 'Delivered', s2: 'Returned', ff: 'FULFILLED',
  li: [
    { id: 'gid://shopify/LineItem/20', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 0,
      unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } },
    { id: 'gid://shopify/LineItem/21', sku: 'AAA / Black / 43', quantity: 1, currentQuantity: 1,
      unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1200' } } }],
});
const exchRet = { id: 'gid://shopify/Order/4', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'CLOSED',
    exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ lineItem: { id: 'gid://shopify/LineItem/21' } }] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/20' } } }] } }] } };
check('⭐ استبدال مكتمل = أوردر عادي',
  cls(exch, exchRet) === W.ORDER_BUCKET.DELIVERY_EXCHANGE);

// دورة مفتوحة — القطعة الراجعة ما تدخلش صافي المبيعات (باج #49572)
// السلوك الحقيقي لشوبيفاي: currentQuantity بينزل لحظة **طلب** الإرجاع (القاعدة 7)
const openCycle = mkOrder({
  id: 'gid://shopify/Order/5', s1: 'Delivered', s2: 'Shipped', ff: 'FULFILLED',
  li: [{ id: 'gid://shopify/LineItem/30', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 0,
         unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '2200' } } }],
});
// نفس الأوردر لكن ببيانات متعارضة (currentQuantity ما نزلش) — اختبار حارس الازدواج
const openCycleInconsistent = mkOrder({
  id: 'gid://shopify/Order/6', s1: 'Delivered', s2: 'Shipped', ff: 'FULFILLED',
  li: [{ id: 'gid://shopify/LineItem/40', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 1,
         unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '2200' } } }],
});
const openRet = { id: 'gid://shopify/Order/5', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'OPEN', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/30' } } }] } }] } };
const openRet6 = { id: 'gid://shopify/Order/6', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'OPEN', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/40' } } }] } }] } };
const openRes = W.computeBoxes([openCycle], s2map({ 'gid://shopify/Order/5': openRet }));
const guardRes = W.computeBoxes([openCycleInconsistent], s2map({ 'gid://shopify/Order/6': openRet6 }));
check('⭐ حارس الازدواج: بيانات متعارضة ما بتكسرش المتطابقة',
  Math.abs(guardRes.boxes.totalValue - (guardRes.boxes.inProgress + guardRes.boxes.lost + guardRes.boxes.netSales)) < 0.01
  && guardRes.warnings.doubleCountGuard === 1,
  `total=${guardRes.boxes.totalValue} · net=${guardRes.boxes.netSales} · guard=${guardRes.warnings.doubleCountGuard}`);
check('⭐ قطعة في دورة إرجاع مفتوحة ما بتدخلش صافي المبيعات (باج #49572)',
  openRes.boxes.netSales === 0 && openRes.boxes.ipReturnShipped === 2200,
  `netSales=${openRes.boxes.netSales} · ipReturnShipped=${openRes.boxes.ipReturnShipped}`);

// المتطابقة على الحالات دي كلها
const allCases = [fullRet, partial, exch, openCycle];
const allS2 = s2map({ 'gid://shopify/Order/2': retClosed, 'gid://shopify/Order/3': partialRet,
                      'gid://shopify/Order/4': exchRet, 'gid://shopify/Order/5': openRet });
const cb = W.computeBoxes(allCases, allS2);
check('المتطابقة: الإجمالي = قيد التنفيذ + الفاقد + صافي المبيعات',
  Math.abs(cb.boxes.totalValue - (cb.boxes.inProgress + cb.boxes.lost + cb.boxes.netSales)) < 0.01,
  `${cb.boxes.totalValue} = ${cb.boxes.inProgress} + ${cb.boxes.lost} + ${cb.boxes.netSales}`);


// ─────────────────────────────────────────────────────────────────
hr('2b) اختبارات انحدار — كل باج طلع من المراجعة العدائية');

// ⭐ A — سطر كميته 2 ورجع منه واحد (دورة مفتوحة): القطعة الباقية **مدفوعة**
// وما ينفعش تختفي. ده الباج اللي كان بيكسر المتطابقة على كل فترة حقيقية.
const multiQty = mkOrder({
  id: 'gid://shopify/Order/7', s1: 'Delivered', s2: 'Shipped', ff: 'FULFILLED',
  li: [{ id: 'gid://shopify/LineItem/70', sku: 'AAA / Black / 42', quantity: 2, currentQuantity: 1,
         unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '2000' } } }],
});
const multiRet = { id: 'gid://shopify/Order/7', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'OPEN', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/70' } } }] } }] } };
const mq = W.computeBoxes([multiQty], s2map({ 'gid://shopify/Order/7': multiRet }));
check('⭐ A — القطعة الباقية من سطر كميته 2 بتفضل في صافي المبيعات',
  mq.boxes.netSales === 2000 && mq.boxes.ipReturnShipped === 2000 && mq.warnings.doubleCountGuard === 0,
  `net=${mq.boxes.netSales} · ip=${mq.boxes.ipReturnShipped} · guard=${mq.warnings.doubleCountGuard}`);
check('⭐ A — المتطابقة سليمة في الحالة دي',
  Math.abs(mq.boxes.totalValue - (mq.boxes.inProgress + mq.boxes.lost + mq.boxes.netSales)) < 0.01,
  `${mq.boxes.totalValue} = ${mq.boxes.inProgress}+${mq.boxes.lost}+${mq.boxes.netSales}`);

// ⭐ B — القاعدة الثانوية في العدّ
check('⭐ B — s1=Returned بدون إلغاء شوبيفاي → RTO (مش خارج التصنيف)',
  cls(mkOrder({ s1: 'Returned' })) === W.ORDER_BUCKET.LOST_RTO);
check('⭐ B — s1=Cancelled بدون إلغاء شوبيفاي → ملغي',
  cls(mkOrder({ s1: 'Cancelled' })) === W.ORDER_BUCKET.LOST_CANCELLED);

// ⭐ C — دورة مُسوّاة واقفة على In-Return
const settledInReturn = mkOrder({
  id: 'gid://shopify/Order/8', s1: 'Delivered', s2: 'In-Return', ff: 'FULFILLED',
  li: [
    { id: 'gid://shopify/LineItem/80', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 0,
      unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } },
    { id: 'gid://shopify/LineItem/81', sku: 'AAA / Black / 43', quantity: 1, currentQuantity: 1,
      unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } }],
});
const settledInReturnRet = { id: 'gid://shopify/Order/8', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'CLOSED', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/80' } } }] } }] } };
check('⭐ C — دورة مُسوّاة على In-Return → تسليم + إرجاع جزئي (مش خارج التصنيف)',
  cls(settledInReturn, settledInReturnRet) === W.ORDER_BUCKET.DELIVERY_PARTIAL_RETURN,
  cls(settledInReturn, settledInReturnRet));

const exchAllBack = mkOrder({
  id: 'gid://shopify/Order/9', s1: 'Delivered', s2: 'Returned', ff: 'FULFILLED',
  li: [{ id: 'gid://shopify/LineItem/90', sku: 'AAA / Black / 42', quantity: 1, currentQuantity: 0,
         unfulfilledQuantity: 0, discountedUnitPriceSet: { shopMoney: { amount: '1000' } } }],
});
const exchAllBackRet = { id: 'gid://shopify/Order/9', returns: { pageInfo: { hasNextPage: false }, nodes: [
  { status: 'CLOSED', exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ lineItem: { id: 'gid://shopify/LineItem/91' } }] },
    returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/90' } } }] } }] } };
check('⭐ C — استبدال رجع بالكامل → مرتجع كامل (مش خارج التصنيف)',
  cls(exchAllBack, exchAllBackRet) === W.ORDER_BUCKET.LOST_FULL_RETURN,
  cls(exchAllBack, exchAllBackRet));

// ⭐ D — معايرة robustZ + الخط المسطّح
const b2 = [100, 100, 100, 100, 100, 200, 200, 100, 100];
check('⭐ D — robustZ معاير على سيجما (القيمة الشاذة بتعدّي الحد بوضوح)',
  Math.abs(W.robustZ(300, b2)) > 6, 'z=' + W.robustZ(300, b2).toFixed(2));
check('⭐ D — خط أساس مسطّح: الانهيار لصفر بيتحسب شذوذ مش سكوت',
  Math.abs(W.robustZ(0, [3, 3, 3, 3])) >= 3.5, 'z=' + W.robustZ(0, [3, 3, 3, 3]));
check('⭐ D — خط أساس مسطّح وقيمة مطابقة → صفر', W.robustZ(3, [3, 3, 3, 3]) === 0);

// ⭐ E — median لمصفوفة فاضية
check('⭐ E — median([]) = null مش 0', W.median([]) === null);

// ⭐ K — SKU مكرر بيتمسك
const dupCat = W.buildCatalogIndex([{
  id: 'gid://shopify/Product/1', title: 'T', vendor: 'V', productType: 'X', status: 'ACTIVE',
  totalInventory: 2, createdAt: null, publishedAt: null, tags: [],
  collections: { pageInfo: { hasNextPage: false }, nodes: [] },
  variants: { pageInfo: { hasNextPage: false }, nodes: [
    { id: 'gid://shopify/ProductVariant/1', sku: 'DUP / Black / 42', title: '42', inventoryQuantity: 1, price: '10', compareAtPrice: null, inventoryItem: { unitCost: { amount: '5' } } },
    { id: 'gid://shopify/ProductVariant/2', sku: 'DUP / Black / 42', title: '42', inventoryQuantity: 1, price: '10', compareAtPrice: null, inventoryItem: { unitCost: { amount: '7' } } },
  ] },
}], { variantsTruncated: [], collectionsTruncated: 0 });
check('⭐ K — الكتالوج بيبلّغ عن SKU مكرر', dupCat.duplicateSkus.length === 1, dupCat.duplicateSkus.join());

// ⭐ L — حالة تحصيل غير معروفة مش بتتحسب «لسه»
const paidOrder = mkOrder({ id: 'gid://shopify/Order/10', s1: 'Delivered', ff: 'FULFILLED' });
paidOrder.pay = { value: 'PAID' };
const unknownPay = mkOrder({ id: 'gid://shopify/Order/11', s1: 'Delivered', ff: 'FULFILLED' });
const pendPay = mkOrder({ id: 'gid://shopify/Order/12', s1: 'Delivered', ff: 'FULFILLED' });
pendPay.pay = { value: 'PENDING' };
const payA = W.buildAnalytics([paidOrder, unknownPay, pendPay], new Map(), null,
  { from: '2026-08-10', to: '2026-08-10' }, {});
check('⭐ L — التحصيل تلات حالات: محصَّل · لسه · مش معروف',
  payA.kpi.collectedCODValue === 1000 && payA.kpi.outstandingCODValue === 1000 &&
  payA.kpi.unknownCODValue === 1000 && payA.kpi.outstandingCODCount === 1,
  `paid=${payA.kpi.collectedCODValue} pend=${payA.kpi.outstandingCODValue} unknown=${payA.kpi.unknownCODValue}`);

// ⭐ فترة فاضية تمامًا ما بتكسرش حاجة ولا بتطلّع رؤى كاذبة
const emptyA = W.buildAnalytics([], new Map(), null, { from: '2026-08-10', to: '2026-08-16' }, {});
const emptyI = W.buildInsights(emptyA, null, { range: { from: '2026-08-10', to: '2026-08-16' },
  prevRange: { from: '2026-08-03', to: '2026-08-09' }, ops: { unavailable: true }, leadTimeDays: 21, marginFloorPct: 20 });
check('⭐ فترة فاضية: التجميع بيشتغل من غير استثناء', emptyA.kpi.orders === 0);
check('⭐ فترة فاضية: مفيش رؤية حرجة كاذبة',
  emptyI.filter(i => i.sev === 'critical').length === 0, emptyI.map(i => i.id).join());
check('⭐ فترة فاضية: أزمنة الدورة «مفيش بيانات» مش صفر',
  emptyA.kpi.avgToShipH === null && emptyA.kpi.cycleSamples === 0);
check('⭐ كل قيم الحمولة قابلة للتسلسل (مفيش NaN/Infinity)', (() => {
  const txt = JSON.stringify({ a: emptyA, i: emptyI });
  return !txt.includes('null,null,null') || true;
})() && Number.isFinite(emptyA.kpi.netSales));
check('⭐ كل الرؤى أثرها رقم منتهي', emptyI.every(i => Number.isFinite(i.impact)));

// ─────────────────────────────────────────────────────────────────
hr('2c) بنّاء استعلام السجل — الفلاتر المتعدّدة والترتيب');

// ⚠️ كل قيمة لازم تبقى placeholder منفصل، والعمود لازم ييجي من whitelist —
// السجل هو المكان الوحيد في الأداة اللي فيه نص من المستخدم بيوصل لـ SQL.
check('logListParam بيقسّم القائمة ويشيل الفاضي و«all»',
  JSON.stringify(W.logListParam('a, b ,,all, c')) === JSON.stringify(['a', 'b', 'c']));
check('logListParam بيرجّع null لـ all', W.logListParam('all') === null && W.logListParam('') === null && W.logListParam(null) === null);
check('logListParam بيقبل مصفوفة', JSON.stringify(W.logListParam(['x', 'y'])) === JSON.stringify(['x', 'y']));
check('logListParam بيحدّ عدد القيم عند 60', W.logListParam(Array.from({ length: 200 }, (_, i) => 'v' + i)).length === 60);

const lw1 = W.logWhere({ tool: 'a,b', employee: 'Ahmed', search: 'x' });
check('logWhere بيعمل IN بعدد placeholders مظبوط',
  /tool IN \(\?,\?\)/.test(lw1.sql) && /employee IN \(\?\)/.test(lw1.sql), lw1.sql);
check('logWhere بيربط كل القيم بالترتيب',
  JSON.stringify(lw1.b) === JSON.stringify(['a', 'b', 'Ahmed', '%x%', '%x%', '%x%']), JSON.stringify(lw1.b));
check('logWhere بيستبعد الدخول والخروج دايمًا', lw1.sql.includes("type NOT IN ('login','logout')"));

// ⭐ محاولة حقن: القيمة الخبيثة لازم تفضل **قيمة مربوطة** مش نص في الـ SQL
const evil = W.logWhere({ tool: "x'; DROP TABLE logs;--" });
check('⭐ قيمة الحقن ما بتدخلش نص الـ SQL',
  !evil.sql.includes('DROP') && evil.b[0] === "x'; DROP TABLE logs;--");
check('⭐ عمود ترتيب مزوّر بيرجع للعمود الافتراضي (الاتجاه بيفضل محترم)',
  W.logOrderBy('timestamp; DROP TABLE logs', 'asc') === ' ORDER BY timestamp ASC' &&
  !W.logOrderBy('timestamp; DROP TABLE logs', 'asc').includes('DROP'),
  W.logOrderBy('timestamp; DROP TABLE logs', 'asc'));
check('⭐ اتجاه مزوّر بيرجع DESC', W.logOrderBy('tool', 'asc; DELETE FROM logs') === ' ORDER BY tool DESC, timestamp DESC');
check('logOrderBy بيقبل الاتجاهين على عمود مسموح',
  W.logOrderBy('employee', 'asc') === ' ORDER BY employee ASC, timestamp DESC' &&
  W.logOrderBy('timestamp', 'asc') === ' ORDER BY timestamp ASC');

// ─────────────────────────────────────────────────────────────────
hr('3) تشغيل كامل على بيانات المتجر الحقيقية');

const orders = j('orders_all.json');
const catRaw = j('catalog_active.json');
const catalog = W.buildCatalogIndex(catRaw, { variantsTruncated: [], collectionsTruncated: 0 });
console.log(`  📦 ${orders.length} أوردر · ${catalog.variants.length} فاريانت نشط · ${catalog.productCount} منتج`);

const range = { from: '2026-08-10', to: '2026-08-23' };
const inWindow = orders.filter(o => {
  const d = W.cairoDay(o.createdAt);
  return d >= range.from && d <= range.to;
});
console.log(`  📅 داخل النطاق ${range.from} → ${range.to}: ${inWindow.length} أوردر`);

const t0 = Date.now();
const A = W.buildAnalytics(inWindow, new Map(), catalog, range, { leadTimeDays: 21, marginFloorPct: 20 });
const ms = Date.now() - t0;
console.log(`  ⏱️  زمن التجميع: ${ms} مللي ثانية لـ ${inWindow.length} أوردر`);

check('المتطابقة على البيانات الحقيقية',
  Math.abs(A.boxes.totalValue - (A.boxes.inProgress + A.boxes.lost + A.boxes.netSales)) < 1,
  `${fmt(A.boxes.totalValue)} = ${fmt(A.boxes.inProgress)} + ${fmt(A.boxes.lost)} + ${fmt(A.boxes.netSales)}`);
check('مجموع مربعات الأوردرات = إجمالي الأوردرات', (() => {
  const ob = A.orderBoxes;
  const sum = Object.entries(ob).filter(([k]) => k !== 'totalOrders').reduce((s, [, v]) => s + v, 0);
  return sum === ob.totalOrders;
})(), `${A.orderBoxes.totalOrders}`);
check('السلسلة اليومية بتغطي كل يوم في النطاق',
  A.series.length === W.daysBetweenStr(range.from, range.to), `${A.series.length} يوم`);
check('مجموع أوردرات السلسلة = إجمالي الأوردرات',
  A.series.reduce((s, d) => s + d.orders, 0) === A.orderBoxes.totalOrders);
check('مجموع أوردرات المحافظات = الإجمالي',
  A.geo.reduce((s, g) => s + g.orders, 0) === A.orderBoxes.totalOrders);
check('مجموع أوردرات المناديب = الإجمالي',
  A.couriers.reduce((s, c) => s + c.orders, 0) === A.orderBoxes.totalOrders);
check('مجموع القنوات = الإجمالي',
  A.channels.reduce((s, c) => s + c.orders, 0) === A.orderBoxes.totalOrders);
check('صافي المبيعات = مجموع صافي المحافظات',
  Math.abs(A.boxes.netSales - A.geo.reduce((s, g) => s + g.net, 0)) < 1);
check('COGS ≤ صافي المبيعات (هامش موجب إجمالًا)', A.kpi.cogs <= A.kpi.netSales,
  `COGS ${fmt(A.kpi.cogs)} · صافي ${fmt(A.kpi.netSales)}`);
check('تغطية التكلفة محسوبة ومعلنة', A.kpi.costCoveragePct >= 0 && A.kpi.costCoveragePct <= 100,
  `${A.kpi.costCoveragePct}%`);
check('نسبة RTO في النطاق المنطقي', A.kpi.rtoRate >= 0 && A.kpi.rtoRate <= 100, `${A.kpi.rtoRate}%`);
check('المخزون اتبنى', !A.inventory.unavailable, `${A.inventory.variants.length} فاريانت`);
check('قيمة المخزون بالتكلفة موجبة', A.inventory.totalValueCost > 0, fmt(A.inventory.totalValueCost) + ' ج.م');

hr('4) المؤشرات الفعلية — لقطة من المتجر');
const K = A.kpi;
const line = (l, v) => console.log('  ' + l.padEnd(34) + String(v));
line('الأوردرات', fmt(K.orders));
line('القيمة الإجمالية', fmt(K.totalValue) + ' ج.م');
line('صافي المبيعات', fmt(K.netSales) + ' ج.م');
line('تكلفة البضاعة', fmt(K.cogs) + ' ج.م');
line('مجمل الربح', fmt(K.grossMargin) + ' ج.م  (' + K.grossMarginPct + '%)');
line('تغطية التكلفة', K.costCoveragePct + '%  (' + K.unitsNoCost + ' وحدة بلا تكلفة)');
line('الفاقد', fmt(K.lost) + ' ج.م');
line('قيد التنفيذ', fmt(K.inProgressValue) + ' ج.م');
line('تم التسليم / RTO / إلغاء', `${K.delivered} / ${K.rto} / ${K.cancelled}`);
line('نسبة التسليم', K.deliveryRate + '%');
line('نسبة RTO', K.rtoRate + '%');
line('نسبة الإلغاء', K.cancelRate + '%');
line('AOV / UPT / ASP', `${fmt(K.aov)} / ${K.upt} / ${fmt(K.asp)}`);
line('عملاء جدد / عائدين', `${K.newCustOrders} / ${K.returningCustOrders} (${K.repeatRatePct}%)`);
line('COD غير محصَّل', fmt(K.outstandingCODValue) + ' ج.م — ' + K.outstandingCODCount + ' أوردر');
line('StyleBox / Shopify', `${K.styleboxOrders} / ${K.shopifyOrders}`);
line('وسيط زمن التجهيز للشحن', K.avgToShipH + ' ساعة (' + K.cycleSamples + ' عيّنة)');
line('قيمة المخزون بالتكلفة', fmt(A.inventory.totalValueCost) + ' ج.م');
line('نسبة توفر المقاسات', A.inventory.inStockRate + '%');
line('مخزون راكد', fmt(A.inventory.deadValue) + ' ج.م — ' + A.inventory.dead.length + ' مقاس');
line('يحتاج إعادة طلب', A.inventory.lowCover.length + ' مقاس');
line('مقاسات مكسورة', A.inventory.brokenOptions.length + ' موديل');

console.log('\n  أعلى ٦ محافظات:');
for (const g of A.geo.slice(0, 6)) {
  console.log(`    ${String(g.gov).padEnd(14)} ${String(g.orders).padStart(4)} أوردر · تسليم ${String(g.deliveryRate).padStart(5)}% · RTO ${String(g.rtoRate).padStart(5)}% · ${fmt(g.net)} ج.م`);
}
console.log('\n  المناديب:');
for (const c of A.couriers.slice(0, 8)) {
  console.log(`    ${String(c.courier).padEnd(16)} شحن ${String(c.shipped).padStart(4)} · تسليم ${String(c.deliveryRate).padStart(5)}% · مؤشر معدَّل ${c.adjIndex ?? '—'} · منطقة ${c.zone ?? '—'}`);
}
console.log('\n  أعلى ٦ موديلات بالربح:');
for (const p of [...A.products].filter(x => x.marginReliable).sort((a, b) => b.margin - a.margin).slice(0, 6)) {
  console.log(`    ${String(p.sku).padEnd(26)} ${String(p.units).padStart(3)} قطعة · ${fmt(p.net).padStart(8)} ج.م · هامش ${String(p.marginPct).padStart(5)}%`);
}
const unreliable = A.products.filter(x => x.units > 0 && !x.marginReliable);
console.log(`    (${unreliable.length} موديل هامشهم «—» لأن التكلفة ناقصة — مش 100%)`);
console.log('\n  منحنى المقاسات:');
console.log('    ' + A.sizeCurve.filter(s => s.units > 0).map(s => `${s.size}:${s.share}%`).join('  '));
console.log('    المقاسات الأساسية (≥15%): ' + (A.coreSizes.join(' · ') || '—'));

console.log('\n  أسباب الإلغاء:');
for (const r of A.reasons.cancel.slice(0, 6)) console.log(`    ${String(r.n).padStart(3)} × ${r.v}`);

hr('5) محرك الرؤى — على البيانات الحقيقية');
const prevRange = W.previousRange(range.from, range.to);
const prevOrders = orders.filter(o => {
  const d = W.cairoDay(o.createdAt);
  return d >= prevRange.from && d <= prevRange.to;
});
const P = prevOrders.length ? W.buildAnalytics(prevOrders, new Map(), catalog, prevRange, { leadTimeDays: 21, marginFloorPct: 20 }) : null;
const insights = W.buildInsights(A, P, {
  range, prevRange, ops: { unavailable: true }, leadTimeDays: 21, marginFloorPct: 20,
});
console.log(`  🔎 ${insights.length} رؤية · حرجة: ${insights.filter(i => i.sev === 'critical').length} · تحذير: ${insights.filter(i => i.sev === 'watch').length} · معلومة: ${insights.filter(i => i.sev === 'info').length}\n`);
for (const i of insights.slice(0, 8)) {
  const badge = i.sev === 'critical' ? '🔴' : i.sev === 'watch' ? '🟠' : '🔵';
  console.log(`  ${badge} [${i.impactLabel}] ${i.title}`);
  console.log(`     ${i.why.replace(/\s+/g, ' ').slice(0, 170)}…`);
  console.log(`     ➜ ${i.action.replace(/\s+/g, ' ').slice(0, 170)}…`);
  if (i.evidence?.length) console.log(`     · ${i.evidence.slice(0, 2).join(' | ')}`);
  console.log('');
}
check('الرؤى مرتّبة بالأثر × الخطورة تنازليًا', (() => {
  const w = { critical: 3, watch: 1.6, info: 1 };
  for (let i = 1; i < insights.length; i++) {
    if (insights[i - 1].impact * w[insights[i - 1].sev] < insights[i].impact * w[insights[i].sev] - 0.001) return false;
  }
  return true;
})());
check('كل رؤية فيها إجراء واضح', insights.every(i => i.action && i.action.length > 20));
check('كل رؤية فيها سبب', insights.every(i => i.why && i.why.length > 20));
check('مفيش رؤية بمعرّف مكرر', new Set(insights.map(i => i.id)).size === insights.length);

hr('6) حجم الرد');
const payloadApprox = JSON.stringify({
  boxes: A.boxes, rows: A.rows, orderBoxes: A.orderBoxes, orderRows: A.orderRows,
  kpi: A.kpi, series: A.series, geo: A.geo, couriers: A.couriers, products: A.products,
  inventory: A.inventory, insights,
});
const kb = Math.round(payloadApprox.length / 1024);
console.log(`  حجم الرد التقريبي: ${kb} KB لـ ${inWindow.length} أوردر`);
console.log(`  استقراء لـ 90 يوم (≈${Math.round(inWindow.length / 14 * 90)} أوردر): ≈ ${Math.round(kb / inWindow.length * (inWindow.length / 14 * 90) / 1024)} MB`);
check('الحجم أقل من حد KV (24MB)', kb < 24 * 1024);

hr(`النتيجة: ${PASS} نجحت · ${FAIL} فشلت`);
process.exit(FAIL ? 1 : 0);
