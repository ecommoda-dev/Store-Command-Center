// ══════════════════════════════════════════════════════════════════
// Store Command Center Worker — مركز قيادة المتجر (v1.0.0)
//
// المراجع الملزِمة:
//   docs/DATA-CONTRACT.md                        (عقد البيانات — v1.0.0)
//   ecommoda-dashboard-builder                   (الكاش · التكلفة · القواعد الـ9)
//   ecommoda-order-lifecycle                     (S1/S2 · التصنيف · القواعد الـ12)
//   ecommoda-order-lifecycle/piece-level-valuation.md  (نموذج Q/C/P)
//   ecommoda-worker-builder                      (المعمارية · §SHARED · CORS)
//   ecommoda-constants                           (كل معرّف ورابط)
//
// المعمارية — ثلاث مصادر مستقلة تمامًا فوق نفس الأداة:
//   1. أوردرات الفترة (Shopify، مرحلتان)  → الفلوس + العدّ + الجغرافيا + العملاء
//   2. الكتالوج (Shopify، مستقل عن الفترة) → التكلفة + البراند + الفئة + المخزون
//   3. سجل D1 (تكلفة صفر)                  → التغليف + التحصيل + الجرد + المزامنة
//
// الأداة **read-only على شوبيفاي** — صفر ميوتيشن. الكتابة الوحيدة: دخول/خروج في D1.
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME      = 'store_command_center';
const WORKER_VERSION = 'v1.0.0';
const CACHE_VERSION  = 'v1';   // ⬆️ يزيد مع أي تغيير في قائمة حقول GraphQL

// حدود منسوخة حرفيًا من عقد البيانات §3/§4/§5 — ممنوع تتغيّر من غير عقد جديد
const LINE_ITEMS_PAGE     = 25;   // lineItems(first: 25) — السقف المطلق للداشبورد
const RETURNS_PAGE        = 5;
const RETURN_LINES_PAGE   = 25;
const EXCHANGE_LINES_PAGE = 10;
const STAGE1_PAGE_SIZE    = 250;
const STAGE2_BATCH_SIZE   = 10;
const CATALOG_PAGE_SIZE   = 100;  // products(first: 100)
const CATALOG_VARIANTS    = 50;   // variants(first: 50) — أقصى منتج فعلي فيه 7
const CATALOG_COLLECTIONS = 25;

const CATALOG_TTL   = 21600;      // 6 ساعات
const OPEN_RANGE_TTL = 900;       // 15 دقيقة
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
// أقصى فترة بترجع معاها صفوف الـ drill-down (فوقها التجميعات بس — بإعلان صريح)
const ROWS_MAX_DAYS = 45;

// §CONSTANTS::S1 — حرفيًا من ecommoda-order-lifecycle §2 (الكابيتال والمسافات مقصودة)
const S1 = {
  NEW_ORDER:          'New Order',
  PENDING_EDIT:       'Pending Edit',
  WHATSAPP_CONFIRMED: 'WhatsApp-Confirmed',
  WHATSAPP_CANCELLED: 'WhatsApp-CANCELLED',
  CONFIRMED:          'Confirmed',
  CONFIRMED_EDIT:     'Confirmed + Edit',
  READY:              'Ready',
  SHIPPED:            'Shipped',
  IN_RETURN:          'In-Return',
  DELIVERED:          'Delivered',
  RETURNED:           'Returned',
  CANCELLED:          'Cancelled',
};

// الحالات المؤقتة — أي عرض ليها لازم يبيّن **العمر** مش العدد بس (القاعدة 11)
const TEMP_STATES = [S1.NEW_ORDER, S1.WHATSAPP_CONFIRMED, S1.WHATSAPP_CANCELLED, S1.PENDING_EDIT, S1.CONFIRMED_EDIT];

// §CONSTANTS::S2
const S2_PREP    = ['Confirmed + RETURN', 'Confirmed + EXCHANGE', 'Ready'];
const S2_SHIPPED = ['Shipped', 'In-Return', 'Returned'];

// §CONSTANTS::RETURN_STATUS — الدورات المتجاهلة بالكامل (piece-level-valuation §4)
const RETURN_IGNORED = ['CANCELED', 'DECLINED'];
// "مفتوحة" معرّفة **عكسيًا** — الأدمن بيعرض نص "Return in progress" وده نص واجهة
// مش قيمة enum. اتأكد على المتجر 23-08-2026 إن القيم الفعلية OPEN / CLOSED.
const isOpenReturn = status => status !== 'CLOSED';

// §CONSTANTS::BUCKETS — مستوى القطعة (الفلوس). أي إضافة هنا لازم تتضاف في HTML BUCKET_LABELS
const BUCKET = {
  RTO: 'RTO', CANCELLED: 'CANCELLED', REMOVED: 'REMOVED',
  FINAL_RETURN: 'FINAL_RETURN', EXCHANGE_RETURN: 'EXCHANGE_RETURN',
  NET_SALES_NORMAL: 'NET_SALES_NORMAL', NET_SALES_REPLACEMENT: 'NET_SALES_REPLACEMENT',
  IP_PENDING_CONFIRM: 'IP_PENDING_CONFIRM',
  IP_CONFIRMED_PREP: 'IP_CONFIRMED_PREP',
  IP_EXCHANGE_PREP: 'IP_EXCHANGE_PREP',
  IP_RETURN_PREP: 'IP_RETURN_PREP',
  IP_CONFIRMED_SHIPPED: 'IP_CONFIRMED_SHIPPED',
  IP_EXCHANGE_SHIPPED: 'IP_EXCHANGE_SHIPPED',
  IP_RETURN_SHIPPED: 'IP_RETURN_SHIPPED',
  IP_UNCLASSIFIED: 'IP_UNCLASSIFIED',
};

// §CONSTANTS::ORDER_BUCKET — مستوى الأوردر بالكامل (عدّ). مستقل تمامًا عن BUCKET
// ⚠️ v1.0.0: IN_TRANSIT_BACK مربع **مستقل** — تصحيح لمخالفة القاعدة 12 في لوحة الأداء v3
const ORDER_BUCKET = {
  PENDING_CONFIRM: 'PENDING_CONFIRM',
  PREP_CONFIRMED: 'PREP_CONFIRMED',
  PREP_EXCHANGE: 'PREP_EXCHANGE',
  PREP_RETURN: 'PREP_RETURN',
  SHIPPED_CONFIRMED: 'SHIPPED_CONFIRMED',
  SHIPPED_EXCHANGE: 'SHIPPED_EXCHANGE',
  SHIPPED_RETURN: 'SHIPPED_RETURN',
  IN_TRANSIT_BACK: 'IN_TRANSIT_BACK',
  LOST_CANCELLED: 'LOST_CANCELLED',
  LOST_RTO: 'LOST_RTO',
  LOST_FULL_RETURN: 'LOST_FULL_RETURN',
  DELIVERY_BASIC: 'DELIVERY_BASIC',
  DELIVERY_EXCHANGE: 'DELIVERY_EXCHANGE',
  DELIVERY_PARTIAL_RETURN: 'DELIVERY_PARTIAL_RETURN',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

const NOTE = { REDELIVERY: 'REDELIVERY', FULFIL_MISM: 'FULFIL_MISM' };

// §CONSTANTS::NOISE_COLLECTIONS — كوليكشن إدارية/آلية، بتتشال من تحليل الكوليكشن
const NOISE_COLLECTION_RE = /^(all|all-products|frontpage|globofilter-|size-\d+-instock|master-discounted-collection)/i;

// §CONSTANTS::GOVERNORATES — تطبيع أسماء المحافظات المصرية
// السبب: نفس المحافظة بتيجي بأكتر من هجاء من شوبيفاي ومن مصادر الاستيراد،
// و«6th of October» و«Helwan» محافظات ملغية إداريًا وبتتبع الجيزة/القاهرة.
const GOV_MAP = {
  'cairo': 'القاهرة', 'al qahirah': 'القاهرة', 'qahirah': 'القاهرة', 'helwan': 'القاهرة',
  'giza': 'الجيزة', 'al jizah': 'الجيزة', '6th of october': 'الجيزة', '6 october': 'الجيزة',
  'sixth of october': 'الجيزة', 'al-jizah': 'الجيزة',
  'alexandria': 'الإسكندرية', 'al iskandariyah': 'الإسكندرية',
  'qalyubia': 'القليوبية', 'al qalyubiyah': 'القليوبية', 'qaliobiya': 'القليوبية',
  'sharqia': 'الشرقية', 'al sharqia': 'الشرقية', 'ash sharqia': 'الشرقية', 'al sharkia': 'الشرقية',
  'dakahlia': 'الدقهلية', 'ad daqahliyah': 'الدقهلية',
  'beheira': 'البحيرة', 'al buhayrah': 'البحيرة',
  'gharbia': 'الغربية', 'al gharbiyah': 'الغربية',
  'monufia': 'المنوفية', 'al minufiyah': 'المنوفية', 'menoufia': 'المنوفية',
  'kafr el sheikh': 'كفر الشيخ', 'kafr al shaykh': 'كفر الشيخ', 'kafr el-sheikh': 'كفر الشيخ',
  'damietta': 'دمياط', 'dumyat': 'دمياط',
  'port said': 'بورسعيد', 'bur said': 'بورسعيد',
  'ismailia': 'الإسماعيلية', 'al ismailiyah': 'الإسماعيلية',
  'suez': 'السويس', 'as suways': 'السويس',
  'north sinai': 'شمال سيناء', 'south sinai': 'جنوب سيناء',
  'red sea': 'البحر الأحمر', 'al bahr al ahmar': 'البحر الأحمر',
  'beni suef': 'بني سويف', 'bani suwayf': 'بني سويف',
  'faiyum': 'الفيوم', 'fayoum': 'الفيوم', 'al fayyum': 'الفيوم',
  'minya': 'المنيا', 'al minya': 'المنيا', 'menia': 'المنيا',
  'asyut': 'أسيوط', 'assiut': 'أسيوط',
  'sohag': 'سوهاج', 'suhaj': 'سوهاج',
  'qena': 'قنا', 'qina': 'قنا',
  'luxor': 'الأقصر', 'al uqsur': 'الأقصر',
  'aswan': 'أسوان',
  'new valley': 'الوادي الجديد', 'al wadi al jadid': 'الوادي الجديد',
  'matrouh': 'مطروح', 'matruh': 'مطروح',
};

// ══════════════════════════════════════════════════════
// §CORS — Option A (wildcard) — أداة read-only بالكامل
// ══════════════════════════════════════════════════════
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function corsPreflight() { return new Response(null, { status: 204, headers: CORS_HEADERS }); }

// ══════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// خطأ بيسمّي الخطوة اللي فشلت فيها — إلزامي (dashboard-builder Step 6)
function fail(step, arMessage, technical) {
  const err = new Error(arMessage);
  err.step = step;
  err.technical = technical;
  return err;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num   = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int   = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const round2 = v => Math.round(v * 100) / 100;
const safeDiv = (a, b) => (b ? a / b : 0);
const pct = (a, b) => (b ? (a / b) * 100 : 0);

// §HELPERS::toCairo — كل تجميع يومي بيتم بتوقيت القاهرة، مش UTC.
// السبب مش تجميلي: فلتر created_at في شوبيفاي بيتفسّر بتوقيت المتجر (UTC+3)،
// فلو التجميع اليومي اتعمل على UTC هيبان في السلسلة يوم زيادة بأوردرات ناقصة.
// اتأكد فعليًا: طلب created_at:>=2026-08-10 رجّع أوردرات createdAt = 2026-08-09T21:xxZ
function cairoDay(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function cairoTodayStr() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function hoursBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3600000;
}
function daysBetweenStr(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// الفترة السابقة = نفس الطول، ملاصقة من قبل
function previousRange(from, to) {
  const len = daysBetweenStr(from, to);
  const prevTo = addDaysStr(from, -1);
  return { from: addDaysStr(prevTo, -(len - 1)), to: prevTo };
}
function dowOf(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); }

// §HELPERS::normGov — تطبيع المحافظة (بيرجع الاسم العربي الموحّد + علامة ثقة)
function normGov(province) {
  const raw = (province || '').trim();
  if (!raw) return { gov: 'غير محدد', known: false };
  const key = raw.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (GOV_MAP[key]) return { gov: GOV_MAP[key], known: true };
  // لو جه بالعربي أصلاً وموجود في القيم
  const arVals = Object.values(GOV_MAP);
  if (arVals.includes(raw)) return { gov: raw, known: true };
  return { gov: raw, known: false };
}

// §HELPERS::parseSku — "GT1 / White  / 43" → { style:'GT1', color:'White', size:'43' }
// 1,355 من 1,357 فاريانت نشط بالشكل ده (اتفحص 23-08-2026). الباقي بيترجع ok:false
function parseSku(sku) {
  const s = (sku || '').trim();
  if (!s) return { style: null, color: null, size: null, ok: false };
  const parts = s.split('/').map(x => x.trim()).filter(x => x.length);
  if (parts.length !== 3) return { style: parts[0] || null, color: null, size: null, ok: false };
  return { style: parts[0], color: parts[1], size: parts[2], ok: true };
}
function styleColorKey(sku) {
  const p = parseSku(sku);
  return p.ok ? `${p.style} / ${p.color}` : (sku || '—');
}

// ══════════════════════════════════════════════════════
// §STATS — الإحصاء المستخدم في محرك الرؤى (كله خالص، بدون أي اعتماد خارجي)
// ══════════════════════════════════════════════════════

// §STATS::wilson — فترة ثقة Wilson لنسبة. بتفضل جوّه [0,1] وبتتصرف صح عند n صغيرة
// أو p قريبة من الصفر — وده بالظبط وضع نسب الـ RTO والمرتجع في متجر بحجمنا.
function wilson(k, n, z = 1.96) {
  if (!n) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (c - h) / d), hi: Math.min(1, (c + h) / d), n };
}
// تنبيه بس لو الفترتين **مش متداخلتين** — ده الفرق بين إشارة وضوضاء
function ciDisjoint(a, b) { return a.hi < b.lo || b.hi < a.lo; }

// §STATS::twoPropZ — مقارنة شريحة بالمتوسط العام (محافظة/مندوب/SKU)
function twoPropZ(k1, n1, k2, n2) {
  if (!n1 || !n2) return 0;
  const p1 = k1 / n1, p2 = k2 / n2;
  const p  = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (p1 - p2) / se : 0;
}

// §STATS::median / mad / robustZ — كشف الشذوذ في السلسلة اليومية.
// اخترنا MAD مش الانحراف المعياري: قفزة واحدة قديمة بتضخّم σ وتخفي كل شذوذ بعدها،
// بينما الوسيط بيتجاهلها. 0.6745 بتعاير MAD لتكافئ σ في التوزيع الطبيعي، والحد 3.5
// هو حد Iglewicz & Hoaglin القياسي.
// ⚠️ بترجع null لو مفيش عيّنة — مش 0. «وسيط زمن التجهيز = 0 ساعة» بيتقرا
// «التجهيز فوري»، وهو فعليًا «مفيش بيانات».
function median(arr) {
  const a = (arr || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mad(arr) {
  const m = median(arr);
  if (m == null) return 0;
  return median(arr.map(v => Math.abs(v - m))) || 0;
}
// الحساب كله على **سيجما** مش على MAD مباشرةً — كده المساران (MAD والبديل) على
// نفس المقياس. النسخة الأولى كانت بتقسم على تقدير سيجما وبتضرب 0.6745 كمان،
// فالحد 3.5 كان بيبقى فعليًا 5.2 سيجما وبيبلع شذوذ حقيقي.
function robustZ(value, baseline) {
  const m = median(baseline);
  if (m == null) return 0;
  const M = mad(baseline);
  let sigma = M / 0.6745;
  if (!sigma) {
    const meanAbs = baseline.length
      ? baseline.reduce((s, v) => s + Math.abs(v - m), 0) / baseline.length : 0;
    sigma = meanAbs * 1.2533;   // متوسط الانحراف المطلق × 1.2533 ≈ σ
  }
  if (!sigma) {
    // خط أساس مسطّح تمامًا. إرجاع 0 معناه «مفيش شذوذ» وهو غلط — انهيار من 100
    // لصفر على خط مسطّح هو أوضح شذوذ ممكن. بنرجّع قيمة كبيرة محدودة بالإشارة.
    return value === m ? 0 : (value > m ? 99 : -99);
  }
  return (value - m) / sigma;
}

// §STATS::cusum — بيرجع أول يوم حصل فيه تغيّر مستوى دائم (مش قفزة يوم واحد)
function cusumChangePoint(series, k = 0.5, h = 4) {
  if (series.length < 8) return null;
  const vals = series.map(s => s.v);
  const mu = median(vals);
  if (mu == null) return null;
  const sd = mad(vals) / 0.6745;
  if (!sd) return null;
  let hi = 0, lo = 0;
  for (let i = 0; i < series.length; i++) {
    const x = (vals[i] - mu) / sd;
    hi = Math.max(0, hi + x - k);
    lo = Math.max(0, lo - x - k);
    if (hi > h || lo > h) return series[i].d;
  }
  return null;
}

// ══════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════
async function getAccessToken(env) {
  const resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, grant_type: 'client_credentials',
    }),
  });
  if (!resp.ok) throw fail('oauth', 'فشل تسجيل الدخول لـ Shopify', `OAuth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw fail('oauth', 'فشل تسجيل الدخول لـ Shopify', 'No access_token in OAuth response');
  return data.access_token;
}

// ⚠️ الحارس إلزامي (worker-builder Step 5A ①). `return resp.json()` المجرّدة بتحوّل
// أي 401/429/5xx أو رد HTML لـ "نجاح صامت ببيانات فاضية" — وفي داشبورد ده بينتج
// **رقم ناقص شكله سليم**، وهو بالظبط أسوأ حاجة ممكنة هنا.
async function shopifyGQL(env, token, query, variables = {}) {
  const resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  let data;
  try { data = await resp.json(); }
  catch (e) { throw new Error('Shopify GraphQL رجّع رد مش JSON صالح: ' + e.message); }
  if (!data || (data.data === undefined && data.errors === undefined)) {
    throw new Error('Shopify GraphQL رجّع رد فاضي (لا data ولا errors)');
  }
  return data;
}

// §SHOPIFY::shopifyWithRetry — إعادة المحاولة على THROTTLED فقط.
// أي خطأ GraphQL تاني (اسم حقل غلط، صلاحية ناقصة) بيفشل **فورًا** — إعادة المحاولة
// عليه انتظار خالص، وبتحوّل فشل فوري مقروء لفشل بطيء بنفس الرسالة.
async function shopifyWithRetry(env, token, query, variables = {}, maxRetries = 3) {
  for (let i = 0; i <= maxRetries; i++) {
    const data = await shopifyGQL(env, token, query, variables);
    const throttled = data.errors?.some(e => e.extensions?.code === 'THROTTLED');
    if (data.errors && !throttled) {
      throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors));
    }
    if (!throttled) return data;
    if (i === maxRetries) throw new Error('Shopify throttled — استُنفدت المحاولات');
    const restore = data.extensions?.cost?.throttleStatus?.restoreRate;
    const wait = restore
      ? Math.ceil(data.extensions.cost.throttleStatus.maximumAvailable / restore) * 1000
      : 2000 * (i + 1);
    await sleep(wait);
  }
}

// ─── §SHOPIFY::fetchStage1 ───────────────────────────────────────
const STAGE1_QUERY = `
  query Stage1($cursor: String, $q: String) {
    orders(first: ${STAGE1_PAGE_SIZE}, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        cancelledAt
        displayFulfillmentStatus
        displayFinancialStatus
        currentSubtotalPriceSet  { shopMoney { amount } }
        totalShippingPriceSet    { shopMoney { amount } }
        currentTotalDiscountsSet { shopMoney { amount } }
        customer { id displayName numberOfOrders }
        customerJourneySummary { customerOrderIndex }
        shippingAddress { province city }
        s1:      metafield(namespace: "custom", key: "manual_status")            { value }
        s2:      metafield(namespace: "custom", key: "status_2_r_e")             { value }
        courier: metafield(namespace: "custom", key: "courier")                  { value }
        zone:    metafield(namespace: "custom", key: "zone")                     { value }
        pay:     metafield(namespace: "custom", key: "payment")                  { value }
        sbid:    metafield(namespace: "custom", key: "stylebox_order_id")        { value }
        att:     metafield(namespace: "custom", key: "bosta_number_of_attempts") { value }
        cRsn:    metafield(namespace: "custom", key: "cancel_manual_reason")     { value }
        rRsn:    metafield(namespace: "custom", key: "return_manual_reason")     { value }
        pt1:     metafield(namespace: "custom", key: "printing_time_s1")         { value }
        pk1:     metafield(namespace: "custom", key: "s1_packing_date_time")     { value }
        pb1:     metafield(namespace: "custom", key: "s1_packed_by")             { value }
        lineItems(first: ${LINE_ITEMS_PAGE}) {
          pageInfo { hasNextPage }
          nodes {
            id sku quantity currentQuantity unfulfilledQuantity
            discountedUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

async function fetchStage1(env, token, dateFrom, dateTo) {
  // ⚠️ مسافة بين الشرطين = AND ضمني. اتأكد على المتجر إن `<=DATE` بيشمل اليوم كله
  // (created_at:>=2026-08-22 created_at:<=2026-08-23 رجّع 198 = 102 + 96).
  const searchQuery = `created_at:>=${dateFrom} created_at:<=${dateTo}`;
  let cursor = null, hasNext = true, page = 0;
  const orders = [];

  while (hasNext) {
    page++;
    let result;
    try {
      result = await shopifyWithRetry(env, token, STAGE1_QUERY, { cursor, q: searchQuery });
    } catch (e) {
      throw fail(`stage1_page_${page}`, `فشل جلب صفحة الأوردرات رقم ${page}`, e.message);
    }
    const conn = result?.data?.orders;
    if (!conn) throw fail(`stage1_page_${page}`, 'Shopify لم يرجع بيانات أوردرات', JSON.stringify(result).slice(0, 400));

    // حارس الـ cursor العالق — الحماية الوحيدة الحقيقية من الحلقة اللانهائية.
    // سقف رقمي (MAX_PAGES) مابيمنعش الحلقة وبيقص نطاق مشروع بصمت — ممنوع.
    if (conn.pageInfo.endCursor === cursor && conn.pageInfo.hasNextPage) {
      throw fail(`stage1_page_${page}`, 'توقفت صفحات الأوردرات عن التقدم (cursor عالق)', 'endCursor did not advance');
    }

    for (const node of conn.nodes) {
      if (node.lineItems?.pageInfo?.hasNextPage) {
        throw fail(
          `stage1_page_${page}`,
          `الأوردر ${node.name || node.id} فيه أكتر من ${LINE_ITEMS_PAGE} سطر — الطلب اتوقف بدل ما يرجّع رقم ناقص`,
          `lineItems.pageInfo.hasNextPage = true on order ${node.id}`
        );
      }
      orders.push(node);
    }
    hasNext = conn.pageInfo.hasNextPage;
    cursor  = conn.pageInfo.endCursor;
    if (hasNext) await sleep(700);
  }
  return orders;
}

// ─── §SHOPIFY::fetchStage2 ───────────────────────────────────────
const STAGE2_QUERY = `
  query Stage2($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        returns(first: ${RETURNS_PAGE}) {
          pageInfo { hasNextPage }
          nodes {
            status
            returnLineItems(first: ${RETURN_LINES_PAGE}) {
              pageInfo { hasNextPage }
              nodes { quantity ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } } }
            }
            exchangeLineItems(first: ${EXCHANGE_LINES_PAGE}) {
              pageInfo { hasNextPage }
              nodes { lineItem { id } }
            }
          }
        }
      }
    }
  }
`;

async function fetchStage2(env, token, candidateIds) {
  const stage2Map = new Map();
  for (let i = 0; i < candidateIds.length; i += STAGE2_BATCH_SIZE) {
    const batch = candidateIds.slice(i, i + STAGE2_BATCH_SIZE);
    const batchNum = Math.floor(i / STAGE2_BATCH_SIZE) + 1;
    let result;
    try {
      result = await shopifyWithRetry(env, token, STAGE2_QUERY, { ids: batch });
    } catch (e) {
      throw fail(`stage2_batch_${batchNum}`, `فشل جلب بيانات المرتجعات — دفعة ${batchNum}`, e.message);
    }
    const nodes = result?.data?.nodes;
    if (!nodes) throw fail(`stage2_batch_${batchNum}`, 'Shopify لم يرجع بيانات مرتجعات', JSON.stringify(result).slice(0, 400));

    // ⚠️ عقدة null معناها إن شوبيفاي ما رجّعش أوردر مرشّح (صلاحية/حذف/ID غلط).
    // تجاهلها بصمت بيخلي computeBoxes يشوف returns = [] فيحجز كل القطع الباقية
    // كـ«صافي مبيعات» — يعني مرتجع بيتحوّل لمبيعات من غير أي خطأ. نفس منطق
    // «الصفحة الفاشلة تفشل الطلب كله».
    const missingIds = [];
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n];
      if (!node) { missingIds.push(batch[n]); continue; }
      const rc = node.returns;
      if (rc?.pageInfo?.hasNextPage) {
        throw fail(`stage2_batch_${batchNum}`,
          `الأوردر ${node.id} فيه أكتر من ${RETURNS_PAGE} دورة إرجاع — الطلب اتوقف بدل رقم ناقص`,
          `returns.pageInfo.hasNextPage on ${node.id}`);
      }
      for (const ret of rc?.nodes || []) {
        if (ret.returnLineItems?.pageInfo?.hasNextPage) {
          throw fail(`stage2_batch_${batchNum}`,
            `الأوردر ${node.id} فيه دورة بأكتر من ${RETURN_LINES_PAGE} سطر مرتجع`,
            `returnLineItems truncated on ${node.id}`);
        }
        if (ret.exchangeLineItems?.pageInfo?.hasNextPage) {
          throw fail(`stage2_batch_${batchNum}`,
            `الأوردر ${node.id} فيه دورة بأكتر من ${EXCHANGE_LINES_PAGE} سطر بديل`,
            `exchangeLineItems truncated on ${node.id}`);
        }
      }
      stage2Map.set(node.id, node);
    }
    if (missingIds.length) {
      throw fail(`stage2_batch_${batchNum}`,
        `شوبيفاي ما رجّعش بيانات المرتجعات لـ ${missingIds.length} أوردر — الطلب اتوقف بدل ما يحسبهم مبيعات`,
        'null nodes: ' + missingIds.join(', ').slice(0, 300));
    }
    if (i + STAGE2_BATCH_SIZE < candidateIds.length) await sleep(400);
  }
  return stage2Map;
}

// ─── §SHOPIFY::fetchCatalog ──────────────────────────────────────
// ⚠️ ممنوع نهائيًا `productVariants(query: ...)` — الفلتر بيتجاهل **بصمت**.
// دليل مقاس على المتجر 23-08-2026:
//   productVariantsCount                                 → 6180
//   productVariantsCount(query:"inventory_quantity:>0")  → 6180  (نفس الرقم)
//   productVariantsCount(query:"inventory_quantity:<=0") → 6180  (نفس الرقم)
// بينما products(query:"status:active") بيفلتر فعليًا (276 / 227 / 694).
const CATALOG_QUERY = `
  query Catalog($cursor: String, $q: String) {
    products(first: ${CATALOG_PAGE_SIZE}, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title vendor productType status totalInventory createdAt publishedAt tags
        wpid:     metafield(namespace: "custom", key: "wordpress_id")  { value }
        supplier: metafield(namespace: "custom", key: "supplier")      { value }
        purchaseDate: metafield(namespace: "custom", key: "purchase_date") { value }
        collections(first: ${CATALOG_COLLECTIONS}) { pageInfo { hasNextPage } nodes { handle title } }
        variants(first: ${CATALOG_VARIANTS}) {
          pageInfo { hasNextPage }
          nodes { id sku title inventoryQuantity price compareAtPrice createdAt
                  inventoryItem { unitCost { amount } } }
        }
      }
    }
  }
`;

async function fetchCatalog(env, token) {
  const products = [];
  const warnings = { variantsTruncated: [], collectionsTruncated: 0 };
  let cursor = null, hasNext = true, page = 0;

  while (hasNext) {
    page++;
    let result;
    try {
      result = await shopifyWithRetry(env, token, CATALOG_QUERY, { cursor, q: 'status:active' });
    } catch (e) {
      throw fail(`catalog_page_${page}`, `فشل جلب صفحة الكتالوج رقم ${page}`, e.message);
    }
    const conn = result?.data?.products;
    if (!conn) throw fail(`catalog_page_${page}`, 'Shopify لم يرجع بيانات منتجات', JSON.stringify(result).slice(0, 400));
    if (conn.pageInfo.endCursor === cursor && conn.pageInfo.hasNextPage) {
      throw fail(`catalog_page_${page}`, 'توقفت صفحات الكتالوج عن التقدم (cursor عالق)', 'endCursor did not advance');
    }
    for (const p of conn.nodes) {
      // القص هنا بيقلّل دقة تحليل المقاسات — بيتبلّغ للواجهة، ما بيوقّفش الطلب،
      // لأن الكتالوج مش مصدر رقم مالي مباشر (بخلاف الأوردرات).
      if (p.variants?.pageInfo?.hasNextPage) warnings.variantsTruncated.push(p.title || p.id);
      if (p.collections?.pageInfo?.hasNextPage) warnings.collectionsTruncated++;
      products.push(p);
    }
    hasNext = conn.pageInfo.hasNextPage;
    cursor  = conn.pageInfo.endCursor;
    if (hasNext) await sleep(400);
  }
  return { products, warnings };
}

// §SHOPIFY::buildCatalogIndex — تحويل الكتالوج لشكل مضغوط + فهرس SKU
function buildCatalogIndex(products, warnings) {
  const variants = [];
  const bySku = {};
  const dupSkus = new Set();
  const vendorSet = new Set();

  for (const p of products) {
    const colls = (p.collections?.nodes || [])
      .filter(c => !NOISE_COLLECTION_RE.test(c.handle || ''))
      .map(c => c.handle);
    const isStylebox = (p.tags || []).includes('stylebox') || !!p.wpid?.value;
    vendorSet.add(p.vendor || '—');

    for (const v of (p.variants?.nodes || [])) {
      const sk = parseSku(v.sku);
      const cost  = v.inventoryItem?.unitCost?.amount != null ? num(v.inventoryItem.unitCost.amount) : null;
      const price = num(v.price);
      const cmp   = v.compareAtPrice != null ? num(v.compareAtPrice) : null;
      const row = {
        vid: (v.id || '').split('/').pop(),
        pid: (p.id || '').split('/').pop(),
        sku: v.sku || null,
        style: sk.style, color: sk.color, size: sk.size, skuOk: sk.ok,
        title: p.title, vendor: p.vendor || '—', type: p.productType || '—',
        qty: int(v.inventoryQuantity), price, cmp, cost,
        colls, stylebox: isStylebox, wpid: p.wpid?.value || null,
        supplier: p.supplier?.value || null,
        createdAt: p.createdAt, publishedAt: p.publishedAt,
      };
      variants.push(row);
      if (v.sku) {
        // ⚠️ SKU مكرر على أكتر من فاريانت نشط = تكلفة عشوائية (آخر واحد بيكسب)
        // و**كل** فاريانت بياخد مبيعات الـ SKU كلها في حساب السرعة والتغطية.
        // بنسيب الأول ونسجّل التكرار بدل ما نبلعه.
        if (bySku[v.sku]) dupSkus.add(v.sku); else bySku[v.sku] = row;
      }
    }
  }
  return {
    variants, bySku,
    duplicateSkus: Array.from(dupSkus),
    productCount: products.length,
    vendors: Array.from(vendorSet).sort(),
    warnings,
    builtAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════
// §AGGREGATE — مستوى القطعة (الفلوس)
// تطبيق حرفي لـ piece-level-valuation.md — منقول من لوحة الأداء v3.0.0 بعد
// ما اتأكد إنتاجيًا، مع تصحيح واحد موثّق في §AGGREGATE-ORDERS تحت.
// ══════════════════════════════════════════════════════

// §AGGREGATE::isCancelledOrRTO — §4.1، يسبق أي فحص تاني.
// ⚠️ manual_status **مش** مستخدم هنا نهائيًا: اتأكد على #49472 إن Flow معطّل كتب
// "Cancelled" على أوردر RTO حقيقي. حدث شوبيفاي مايتكتبش غلط، البني آدم أيوه.
function isCancelledOrRTO(order) {
  if (!order.cancelledAt) return null;
  return order.displayFulfillmentStatus === 'FULFILLED' ? 'RTO' : 'CANCELLED';
}

// §AGGREGATE::isCandidateForStage2 — Σ(Q) ≠ Σ(C) أو s2 ≠ null
function isCandidateForStage2(order) {
  if (order.cancelledAt) return false;
  const li = order.lineItems?.nodes || [];
  const sumQ = li.reduce((s, l) => s + (l.quantity || 0), 0);
  const sumC = li.reduce((s, l) => s + (l.currentQuantity || 0), 0);
  return sumQ !== sumC || (order.s2?.value || null) !== null;
}

// §AGGREGATE::stageFromS2 — 'PREP' | 'SHIPPED' | null
function stageFromS2(s2) {
  if (S2_PREP.includes(s2))    return 'PREP';
  if (S2_SHIPPED.includes(s2)) return 'SHIPPED';
  return null;
}

// §AGGREGATE::normalBucket — القطع الحيّة غير المرتبطة بأي دورة إرجاع/استبدال.
// ⚠️ الحالات المؤقتة متعدّدة **صراحةً** — الاعتماد على fallback عام هنا هو بالظبط
// الباج اللي خلّى WhatsApp-Confirmed تتحسب "مؤكد/تحت التجهيز" في نسخة سابقة.
function normalBucket(s1) {
  if (s1 === S1.NEW_ORDER || s1 === S1.PENDING_EDIT ||
      s1 === S1.WHATSAPP_CONFIRMED || s1 === S1.WHATSAPP_CANCELLED) {
    return BUCKET.IP_PENDING_CONFIRM;
  }
  if (s1 === S1.SHIPPED || s1 === S1.IN_RETURN) return BUCKET.IP_CONFIRMED_SHIPPED;
  if (s1 === S1.RETURNED || s1 === S1.CANCELLED) return BUCKET.IP_UNCLASSIFIED;
  return BUCKET.IP_CONFIRMED_PREP;   // Confirmed · Confirmed + Edit · Ready · null
}

// §AGGREGATE::EXPECT_FULFILLED — assertion فقط، **أبداً** مش بوابة تصنيف.
// مربعات المرتجع (4 و 7) مش هنا عن قصد: القطعة الراجعة اتشحنت بالضرورة قبل ما ترجع.
const EXPECT_FULFILLED = {
  [BUCKET.IP_PENDING_CONFIRM]:   false,
  [BUCKET.IP_CONFIRMED_PREP]:    false,
  [BUCKET.IP_EXCHANGE_PREP]:     false,
  [BUCKET.IP_CONFIRMED_SHIPPED]: true,
  [BUCKET.IP_EXCHANGE_SHIPPED]:  true,
};

const unitPrice = li => num(li.discountedUnitPriceSet?.shopMoney?.amount);
const numericIdFromGid = gid => (gid || '').split('/').pop();
const isLineFulfilled = li => (li.unfulfilledQuantity || 0) === 0;

function pushRow(rows, ctx, li, qty, value, bucket, note = null) {
  if (!qty) return;
  rows.push({
    orderId: ctx.orderId, orderName: ctx.orderName, day: ctx.day,
    sku: li.sku || null, qty, value: round2(value), bucket,
    s1: ctx.s1, s2: ctx.s2, note,
  });
}

// §AGGREGATE::computeBoxes — { boxes, rows, warnings }
function computeBoxes(stage1Orders, stage2Map) {
  const b = {
    totalValue: 0,
    inProgress: 0,
    ipPendingConfirm: 0, ipConfirmedPrep: 0, ipExchangePrep: 0, ipReturnPrep: 0,
    ipConfirmedShipped: 0, ipExchangeShipped: 0, ipReturnShipped: 0, ipUnclassified: 0,
    lost: 0, lostCancelled: 0, lostRTO: 0, lostRemoved: 0, lostFinalReturn: 0, lostExchangeReturn: 0,
    netSales: 0, netSalesReplacement: 0,
  };
  const rows = [];
  const warnings = { fulfilmentMismatch: 0, redelivery: 0, unclassified: 0, doubleCountGuard: 0 };

  const IP_FIELD = {
    [BUCKET.IP_PENDING_CONFIRM]:   'ipPendingConfirm',
    [BUCKET.IP_CONFIRMED_PREP]:    'ipConfirmedPrep',
    [BUCKET.IP_EXCHANGE_PREP]:     'ipExchangePrep',
    [BUCKET.IP_RETURN_PREP]:       'ipReturnPrep',
    [BUCKET.IP_CONFIRMED_SHIPPED]: 'ipConfirmedShipped',
    [BUCKET.IP_EXCHANGE_SHIPPED]:  'ipExchangeShipped',
    [BUCKET.IP_RETURN_SHIPPED]:    'ipReturnShipped',
    [BUCKET.IP_UNCLASSIFIED]:      'ipUnclassified',
  };

  for (const order of stage1Orders) {
    const lineItems = order.lineItems?.nodes || [];
    const s1Val = order.s1?.value || null;
    const s2Val = order.s2?.value || null;
    const ctx = {
      orderId: numericIdFromGid(order.id),
      orderName: order.name || null,
      createdAt: order.createdAt || null,
      day: cairoDay(order.createdAt),
      s1: s1Val, s2: s2Val,
    };

    // §4.1 — ملغي/RTO: قيمة السطر كاملة (Q×P) للفاقد، مش الفرق بس
    const shortCircuit = isCancelledOrRTO(order);
    if (shortCircuit) {
      for (const li of lineItems) {
        const P = unitPrice(li), Q = li.quantity || 0, lineTotal = Q * P;
        b.totalValue += lineTotal;
        b.lost       += lineTotal;
        if (shortCircuit === 'RTO') { b.lostRTO += lineTotal; pushRow(rows, ctx, li, Q, lineTotal, BUCKET.RTO); }
        else { b.lostCancelled += lineTotal; pushRow(rows, ctx, li, Q, lineTotal, BUCKET.CANCELLED); }
      }
      continue;
    }

    const stage2Order = stage2Map.get(order.id);
    const returns = stage2Order?.returns?.nodes || [];

    const settledByLineId     = new Map();
    const unsettledByLineId   = new Map();
    const replacementByLineId = new Map();

    for (const ret of returns) {
      if (RETURN_IGNORED.includes(ret.status)) continue;
      // §4.2 — الشرطان لازمين مع بعض: status بيقول أنهي دورة قفلت، s2 بيقول
      // الدورة المفتوحة حاليًا وصلت فين فيزيائيًا.
      const isSettled = ret.status === 'CLOSED' && (s2Val === 'In-Return' || s2Val === 'Returned');
      const exchangeLines = ret.exchangeLineItems?.nodes || [];
      const isExchange = exchangeLines.length > 0;

      for (const el of exchangeLines) {
        const lid = el.lineItem?.id;
        if (!lid) continue;
        const prev = replacementByLineId.get(lid);
        if (!prev || (isSettled && prev !== 'settled')) {
          replacementByLineId.set(lid, isSettled ? 'settled' : 'unsettled');
        }
      }

      for (const rl of (ret.returnLineItems?.nodes || [])) {
        const lid = rl.fulfillmentLineItem?.lineItem?.id;
        const qty = rl.quantity || 0;
        if (!lid || !qty) continue;
        if (isSettled) {
          const e = settledByLineId.get(lid) || { finalQty: 0, exchangeQty: 0 };
          if (isExchange) e.exchangeQty += qty; else e.finalQty += qty;
          settledByLineId.set(lid, e);
        } else {
          // مفتوحة، أو CLOSED من غير ما S2 يوصل — الحالتين بيتعاملوا بالأكثر تحفّظًا
          unsettledByLineId.set(lid, (unsettledByLineId.get(lid) || 0) + qty);
        }
      }
    }

    const addIP = (bucket, value) => {
      b.inProgress += value;
      b[IP_FIELD[bucket]] += value;
      if (bucket === BUCKET.IP_UNCLASSIFIED) warnings.unclassified++;
    };

    for (const li of lineItems) {
      const P = unitPrice(li), Q = li.quantity || 0, C = li.currentQuantity || 0;
      b.totalValue += Q * P;

      const goneTotal    = Math.max(Q - C, 0);
      const settled      = settledByLineId.get(li.id) || { finalQty: 0, exchangeQty: 0 };
      const unsettledQty = unsettledByLineId.get(li.id) || 0;
      const settledQty   = settled.finalQty + settled.exchangeQty;
      const removedQty   = Math.max(goneTotal - settledQty - unsettledQty, 0);

      b.lost               += (removedQty + settledQty) * P;
      b.lostRemoved        += removedQty * P;
      b.lostFinalReturn    += settled.finalQty * P;
      b.lostExchangeReturn += settled.exchangeQty * P;

      pushRow(rows, ctx, li, removedQty,          removedQty * P,          BUCKET.REMOVED);
      pushRow(rows, ctx, li, settled.finalQty,    settled.finalQty * P,    BUCKET.FINAL_RETURN);
      pushRow(rows, ctx, li, settled.exchangeQty, settled.exchangeQty * P, BUCKET.EXCHANGE_RETURN);

      const stage = stageFromS2(s2Val);
      const fulfilled = isLineFulfilled(li);

      // (أ) القطع اللي جوّه دورة إرجاع مفتوحة — لا مبيعات ولا فاقد
      if (unsettledQty > 0) {
        const bucket = stage === 'PREP' ? BUCKET.IP_RETURN_PREP
                     : stage === 'SHIPPED' ? BUCKET.IP_RETURN_SHIPPED
                     : BUCKET.IP_UNCLASSIFIED;
        const value = unsettledQty * P;
        addIP(bucket, value);
        let note = null;
        if (bucket in EXPECT_FULFILLED && EXPECT_FULFILLED[bucket] !== fulfilled) {
          note = NOTE.FULFIL_MISM; warnings.fulfilmentMismatch++;
        }
        pushRow(rows, ctx, li, unsettledQty, value, bucket, note);
      }

      // (ب) القطع الباقية فعلًا.
      // ⚠️ حارس اتساق مضاف في v1.0.0: شوبيفاي بينزّل currentQuantity لحظة **طلب**
      // الإرجاع (القاعدة 7)، فالمفروض القطعة اللي جوّه دورة مفتوحة تكون خرجت من C
      // أصلاً. لو ما خرجتش (تعارض بيانات نادر)، الكود القديم كان بيعدّها **مرتين**:
      // مرة في «قيد التنفيذ» ومرة في «صافي المبيعات» — والمتطابقة بتتكسر بصمت.
      // aliveQty بيمنع ده، وبيسجّل التعارض بدل ما يبلعه.
      // ⚠️ الطرح الكامل (C − unsettledQty) غلط: على سطر كميته 2 ورجع منه واحد،
      // شوبيفاي بيخلي C = 1 و unsettledQty = 1، فالطرح الكامل بيلغي القطعة
      // المدفوعة الباقية ويخفي قيمتها من كل الأرقام. التعارض الحقيقي الوحيد هو
      // unsettledQty > goneTotal — يعني قطع محسوبة في «قيد التنفيذ» ولسه في C.
      const overlap  = Math.max(unsettledQty - goneTotal, 0);
      const aliveQty = Math.max(C - overlap, 0);
      if (overlap > 0 && C > 0) warnings.doubleCountGuard = (warnings.doubleCountGuard || 0) + Math.min(overlap, C);
      if (aliveQty > 0) {
        const value = aliveQty * P;
        const replState = replacementByLineId.get(li.id);
        if (replState === 'settled') {
          b.netSales += value; b.netSalesReplacement += value;
          pushRow(rows, ctx, li, aliveQty, value, BUCKET.NET_SALES_REPLACEMENT);
        } else if (replState === 'unsettled') {
          const bucket = stage === 'PREP' ? BUCKET.IP_EXCHANGE_PREP
                       : stage === 'SHIPPED' ? BUCKET.IP_EXCHANGE_SHIPPED
                       : BUCKET.IP_UNCLASSIFIED;
          addIP(bucket, value);
          let note = null;
          if (bucket in EXPECT_FULFILLED && EXPECT_FULFILLED[bucket] !== fulfilled) {
            note = NOTE.FULFIL_MISM; warnings.fulfilmentMismatch++;
          }
          pushRow(rows, ctx, li, aliveQty, value, bucket, note);
        } else if (s1Val === S1.DELIVERED) {
          b.netSales += value;
          pushRow(rows, ctx, li, aliveQty, value, BUCKET.NET_SALES_NORMAL);
        } else {
          const bucket = normalBucket(s1Val);
          addIP(bucket, value);
          let note = null;
          if (bucket === BUCKET.IP_CONFIRMED_PREP && s1Val === S1.READY && fulfilled) {
            note = NOTE.REDELIVERY; warnings.redelivery++;   // القاعدة 5 — محاولة مكررة
          } else if (bucket in EXPECT_FULFILLED && EXPECT_FULFILLED[bucket] !== fulfilled) {
            note = NOTE.FULFIL_MISM; warnings.fulfilmentMismatch++;
          }
          pushRow(rows, ctx, li, aliveQty, value, bucket, note);
        }
      }
    }
  }
  return { boxes: b, rows, warnings };
}

// ══════════════════════════════════════════════════════
// §AGGREGATE-ORDERS — مستوى الأوردر بالكامل (عدّ، مش فلوس)
// ══════════════════════════════════════════════════════

// §AGGREGATE-ORDERS::classifyOrderForCounts
// ⚠️ **تصحيح v1.0.0:** `s1 = In-Return` بقى مربع مستقل `IN_TRANSIT_BACK` بدل ما
// يتحسب "مؤكد خرج للشحن". طي In-Return في Shipped مسموح **للفلوس فقط** (القاعدة 12
// في ecommoda-order-lifecycle) — تطبيقه على عدّ الأوردرات بيمحي فرق تشغيلي حقيقي:
// شحنة راجعة للمخزن مش زي شحنة رايحة للعميل.
function classifyOrderForCounts(order, stage2Order) {
  const sc = isCancelledOrRTO(order);
  if (sc === 'RTO')       return ORDER_BUCKET.LOST_RTO;
  if (sc === 'CANCELLED') return ORDER_BUCKET.LOST_CANCELLED;

  const s1 = order.s1?.value || null;
  const s2 = order.s2?.value || null;
  const sumC = (order.lineItems?.nodes || []).reduce((s, l) => s + (l.currentQuantity || 0), 0);

  const returns = (stage2Order?.returns?.nodes || []).filter(r => !RETURN_IGNORED.includes(r.status));
  const hasExchange      = returns.some(r => (r.exchangeLineItems?.nodes || []).length > 0);
  const hasSettledClosed = returns.some(r => r.status === 'CLOSED' && (s2 === 'In-Return' || s2 === 'Returned'));

  if (s1 === S1.DELIVERED) {
    if (!s2) return ORDER_BUCKET.DELIVERY_BASIC;
    const stage = stageFromS2(s2);
    if (stage && !hasSettledClosed) {
      if (stage === 'PREP') return hasExchange ? ORDER_BUCKET.PREP_EXCHANGE : ORDER_BUCKET.PREP_RETURN;
      return hasExchange ? ORDER_BUCKET.SHIPPED_EXCHANGE : ORDER_BUCKET.SHIPPED_RETURN;
    }
    // ⚠️ الشرط `hasSettledClosed` لوحده — مش `s2 === 'Returned'`. التسوية معرّفة
    // (piece-level-valuation §4) بـ status = CLOSED **و** s2 ∈ { In-Return, Returned }.
    // اشتراط 'Returned' بس كان بيسيب دورة مُسوّاة واقفة على 'In-Return' تقع في
    // «خارج التصنيف» — ووقتها قطعها بتدخل صافي المبيعات (مستوى القطعة) والأوردر
    // مش داخل المُسلَّم، فمتوسط قيمة الأوردر بيطلع **أعلى من الحقيقة**.
    if (hasSettledClosed) {
      if (sumC === 0)  return ORDER_BUCKET.LOST_FULL_RETURN;   // شامل رجوع البديل نفسه
      if (hasExchange) return ORDER_BUCKET.DELIVERY_EXCHANGE;
      return ORDER_BUCKET.DELIVERY_PARTIAL_RETURN;
    }
    return ORDER_BUCKET.UNCLASSIFIED;
  }

  if (s1 === S1.NEW_ORDER || s1 === S1.PENDING_EDIT ||
      s1 === S1.WHATSAPP_CANCELLED || s1 === S1.WHATSAPP_CONFIRMED) {
    return ORDER_BUCKET.PENDING_CONFIRM;
  }
  if (s1 === S1.IN_RETURN) return ORDER_BUCKET.IN_TRANSIT_BACK;   // ← التصحيح
  if (s1 === S1.SHIPPED)   return ORDER_BUCKET.SHIPPED_CONFIRMED;
  // ⚠️ القاعدة الثانوية (classification-rules.md §2) — بتنطبق على **العدّ** بس:
  //    s1 = Returned → RTO · s1 = Cancelled → CANCELLED
  // الأوردر ده رجع/اتلغى فعلًا لكن شوبيفاي ما سجّلش حدث إلغاء. لو سبناه «خارج
  // التصنيف» هيختفي من بسط **ومقام** نسبة الـ RTO الاتنين، فالنسبة تطلع أقل من
  // الحقيقة — وده أسوأ من عدم عرضها.
  // ⚠️ الفرق عن مستوى القطعة مقصود: هناك (piece-level-valuation §3.1) الفاقد لازم
  // ييجي من حدث شوبيفاي، فالحالة دي بتفضل IP_UNCLASSIFIED. عدّ الأوردرات وتقييم
  // الفلوس شغلانتين مختلفتين — والاختلاف موثّق مقصود مش سهو.
  if (s1 === S1.RETURNED)  return ORDER_BUCKET.LOST_RTO;
  if (s1 === S1.CANCELLED) return ORDER_BUCKET.LOST_CANCELLED;
  return ORDER_BUCKET.PREP_CONFIRMED;
}

const OB_FIELD = {
  [ORDER_BUCKET.PENDING_CONFIRM]:         'pendingConfirm',
  [ORDER_BUCKET.PREP_CONFIRMED]:          'prepConfirmed',
  [ORDER_BUCKET.PREP_EXCHANGE]:           'prepExchange',
  [ORDER_BUCKET.PREP_RETURN]:             'prepReturn',
  [ORDER_BUCKET.SHIPPED_CONFIRMED]:       'shippedConfirmed',
  [ORDER_BUCKET.SHIPPED_EXCHANGE]:        'shippedExchange',
  [ORDER_BUCKET.SHIPPED_RETURN]:          'shippedReturn',
  [ORDER_BUCKET.IN_TRANSIT_BACK]:         'inTransitBack',
  [ORDER_BUCKET.LOST_CANCELLED]:          'lostCancelled',
  [ORDER_BUCKET.LOST_RTO]:                'lostRTO',
  [ORDER_BUCKET.LOST_FULL_RETURN]:        'lostFullReturn',
  [ORDER_BUCKET.DELIVERY_BASIC]:          'deliveryBasic',
  [ORDER_BUCKET.DELIVERY_EXCHANGE]:       'deliveryExchange',
  [ORDER_BUCKET.DELIVERY_PARTIAL_RETURN]: 'deliveryPartialReturn',
  [ORDER_BUCKET.UNCLASSIFIED]:            'unclassified',
};

function computeOrderBoxes(stage1Orders, stage2Map) {
  const ob = {
    totalOrders: 0, pendingConfirm: 0, prepConfirmed: 0, prepExchange: 0, prepReturn: 0,
    shippedConfirmed: 0, shippedExchange: 0, shippedReturn: 0, inTransitBack: 0,
    lostCancelled: 0, lostRTO: 0, lostFullReturn: 0,
    deliveryBasic: 0, deliveryExchange: 0, deliveryPartialReturn: 0, unclassified: 0,
  };
  const rows = [];
  const warnings = { unclassified: 0 };
  const bucketOf = new Map();

  for (const order of stage1Orders) {
    const bucket = classifyOrderForCounts(order, stage2Map.get(order.id));
    ob.totalOrders++;
    ob[OB_FIELD[bucket]]++;
    if (bucket === ORDER_BUCKET.UNCLASSIFIED) warnings.unclassified++;
    bucketOf.set(order.id, bucket);

    const li = order.lineItems?.nodes || [];
    rows.push({
      orderId: numericIdFromGid(order.id),
      orderName: order.name || null,
      day: cairoDay(order.createdAt),
      pieces: li.reduce((s, l) => s + (l.quantity || 0), 0),
      s1: order.s1?.value || null,
      s2: order.s2?.value || null,
      // ⚠️ نفس التطبيع المستخدم في مفتاح التجميع بالظبط — أي اختلاف (مسافة زايدة)
      // بيخلي «المؤشر المعدَّل» بتاع المندوب مايتحسبش له خالص.
      courier: (order.courier?.value || '').trim() || 'غير محدد',
      zone: (order.zone?.value || '').trim() || 'BLANK',
      gov: normGov(order.shippingAddress?.province).gov,
      pay: order.pay?.value || null,
      bucket,
    });
  }
  return { orderBoxes: ob, orderRows: rows, orderWarnings: warnings, bucketOf };
}

// ══════════════════════════════════════════════════════
// §ANALYTICS — كل التجميعات الجديدة فوق نفس البيانات المجابة
// (dashboard-builder Step 4 §8: التجميع في الـ Worker، مش في المتصفح — عشان
//  الكارت والجدول والتصدير ما يختلفوش أبدًا)
// ══════════════════════════════════════════════════════

const SOLD_BUCKETS = [BUCKET.NET_SALES_NORMAL, BUCKET.NET_SALES_REPLACEMENT];
const RETURN_BUCKETS = [BUCKET.FINAL_RETURN, BUCKET.EXCHANGE_RETURN];
const LOST_BUCKETS = [BUCKET.RTO, BUCKET.CANCELLED, BUCKET.REMOVED, ...RETURN_BUCKETS];

function emptyAgg() {
  return { orders: 0, units: 0, net: 0, cogs: 0, lost: 0, delivered: 0, rto: 0,
           cancelled: 0, fullReturn: 0, inProgress: 0, transitBack: 0, retUnits: 0, shipped: 0 };
}
function bump(map, key, fn) {
  if (!map[key]) map[key] = emptyAgg();
  fn(map[key]);
  return map[key];
}

// §ANALYTICS::buildAnalytics
function buildAnalytics(orders, stage2Map, catalog, range, opts = {}) {
  const leadTimeDays = opts.leadTimeDays || 21;
  const serviceZ     = opts.serviceZ || 1.645;              // 95% service level
  const marginFloor  = opts.marginFloorPct != null ? opts.marginFloorPct : 20;
  const nowMs        = opts.nowMs || Date.now();
  const days         = daysBetweenStr(range.from, range.to);
  const weeks        = Math.max(days / 7, 0.14);

  const { boxes, rows, warnings }                              = computeBoxes(orders, stage2Map);
  const { orderBoxes, orderRows, orderWarnings, bucketOf }     = computeOrderBoxes(orders, stage2Map);

  const skuIdx  = catalog?.bySku || {};
  const costOf  = sku => (sku && skuIdx[sku] && skuIdx[sku].cost != null) ? skuIdx[sku].cost : null;
  const metaOf  = sku => skuIdx[sku] || null;

  // ── 1) تمريرة على صفوف القطع: SKU · أوردر · يوم ──────────────
  const bySku = {};
  const byOrderMoney = {};
  const byDay = {};
  let unitsSold = 0, unitsReturned = 0, unitsLost = 0;
  let cogsTotal = 0, unitsWithCost = 0, unitsNoCost = 0;

  for (const r of rows) {
    const sold = SOLD_BUCKETS.includes(r.bucket);
    const ret  = RETURN_BUCKETS.includes(r.bucket);
    const lost = LOST_BUCKETS.includes(r.bucket);

    const om = byOrderMoney[r.orderId] || (byOrderMoney[r.orderId] = { net: 0, units: 0, cogs: 0, lost: 0, retUnits: 0 });
    if (sold) {
      om.net += r.value; om.units += r.qty;
      unitsSold += r.qty;
      const c = costOf(r.sku);
      if (c != null) { om.cogs += c * r.qty; cogsTotal += c * r.qty; unitsWithCost += r.qty; }
      else unitsNoCost += r.qty;
      const d = byDay[r.day] || (byDay[r.day] = { net: 0, units: 0, cogs: 0 });
      d.net += r.value; d.units += r.qty; if (c != null) d.cogs += c * r.qty;
    }
    if (ret)  { om.retUnits += r.qty; unitsReturned += r.qty; }
    if (lost) { om.lost += r.value; unitsLost += r.qty; }

    if (r.sku) {
      const s = bySku[r.sku] || (bySku[r.sku] = {
        sku: r.sku, units: 0, net: 0, cogs: 0, retUnits: 0, retValue: 0,
        lostUnits: 0, lostValue: 0, orders: new Set(), noCost: 0,
      });
      if (sold) {
        s.units += r.qty; s.net += r.value; s.orders.add(r.orderId);
        const c = costOf(r.sku);
        if (c != null) s.cogs += c * r.qty; else s.noCost += r.qty;
      }
      if (ret)  { s.retUnits += r.qty; s.retValue += r.value; }
      if (lost) { s.lostUnits += r.qty; s.lostValue += r.value; }
    }
  }

  // ── 2) تمريرة على الأوردرات: جغرافيا · مناديب · قنوات · عملاء · طوابير ──
  const geoMap = {}, courierMap = {}, zoneMap = {}, channelMap = {}, packerMap = {};
  const cancelReasons = {}, returnReasons = {}, dowMap = {}, hourMap = {};
  const customers = {};
  const aging = { pendingConfirm: [], readyNotShipped: [], shippedNotDelivered: [], codOutstanding: [], transitBack: [] };
  const cycle = { confirmH: [], packH: [], toShipH: [] };
  const dq = {
    noCourierShipped: 0, blankZone: 0, unknownGov: 0, noCustomer: 0,
    nonStandardSku: 0, skuNotInCatalog: new Set(), attemptsMissing: 0,
  };
  let newCustOrders = 0, returningCustOrders = 0, journeyMissing = 0;
  let shippingRevenue = 0, discountTotal = 0, styleboxOrders = 0;
  let outstandingCODValue = 0, outstandingCODCount = 0, collectedCODValue = 0;
  let unknownCODValue = 0, unknownCODCount = 0;

  const TERMINAL = new Set([ORDER_BUCKET.DELIVERY_BASIC, ORDER_BUCKET.DELIVERY_EXCHANGE,
    ORDER_BUCKET.DELIVERY_PARTIAL_RETURN, ORDER_BUCKET.LOST_FULL_RETURN, ORDER_BUCKET.LOST_RTO]);

  for (const o of orders) {
    const oid   = numericIdFromGid(o.id);
    const money = byOrderMoney[oid] || { net: 0, units: 0, cogs: 0, lost: 0, retUnits: 0 };
    const bkt   = bucketOf.get(o.id);
    const s1    = o.s1?.value || null;
    const day   = cairoDay(o.createdAt);
    const gv    = normGov(o.shippingAddress?.province);
    const gov   = gv.gov;
    const courier = (o.courier?.value || '').trim() || 'غير محدد';
    const zone    = (o.zone?.value || '').trim() || 'BLANK';
    const isStylebox = !!o.sbid?.value;
    const payV  = (o.pay?.value || '').toUpperCase();

    const delivered   = bkt === ORDER_BUCKET.DELIVERY_BASIC || bkt === ORDER_BUCKET.DELIVERY_EXCHANGE || bkt === ORDER_BUCKET.DELIVERY_PARTIAL_RETURN;
    const isRTO       = bkt === ORDER_BUCKET.LOST_RTO;
    const isCancelled = bkt === ORDER_BUCKET.LOST_CANCELLED;
    const isFullRet   = bkt === ORDER_BUCKET.LOST_FULL_RETURN;
    const isTransit   = bkt === ORDER_BUCKET.IN_TRANSIT_BACK;
    const wasShipped  = delivered || isRTO || isFullRet || isTransit ||
                        bkt === ORDER_BUCKET.SHIPPED_CONFIRMED || bkt === ORDER_BUCKET.SHIPPED_EXCHANGE ||
                        bkt === ORDER_BUCKET.SHIPPED_RETURN;

    const apply = a => {
      a.orders++; a.units += money.units; a.net += money.net; a.cogs += money.cogs;
      a.lost += money.lost; a.retUnits += money.retUnits;
      if (delivered) a.delivered++;
      if (isRTO) a.rto++;
      if (isCancelled) a.cancelled++;
      if (isFullRet) a.fullReturn++;
      if (isTransit) a.transitBack++;
      if (wasShipped) a.shipped++;
      if (!delivered && !isRTO && !isCancelled && !isFullRet) a.inProgress++;
    };
    bump(geoMap, gov, apply);
    bump(courierMap, courier, apply);
    bump(zoneMap, zone, apply);
    bump(channelMap, isStylebox ? 'StyleBox' : 'Shopify', apply);
    bump(dowMap, String(dowOf(day || range.from)), apply);
    if (o.pb1?.value) bump(packerMap, o.pb1.value, apply);

    if (isStylebox) styleboxOrders++;
    shippingRevenue += delivered ? num(o.totalShippingPriceSet?.shopMoney?.amount) : 0;
    discountTotal   += num(o.currentTotalDiscountsSet?.shopMoney?.amount);

    // العميل الجديد مقابل العائد — customerOrderIndex = 1 يعني أول أوردر
    const idx = o.customerJourneySummary?.customerOrderIndex;
    if (idx == null) journeyMissing++;
    else if (idx === 1) newCustOrders++; else returningCustOrders++;

    const cid = o.customer?.id;
    if (!cid) dq.noCustomer++;
    else {
      const c = customers[cid] || (customers[cid] = {
        id: numericIdFromGid(cid), name: o.customer?.displayName || '—',
        lifetimeOrders: int(o.customer?.numberOfOrders), orders: 0, net: 0, units: 0, rto: 0,
      });
      c.orders++; c.net += money.net; c.units += money.units; if (isRTO) c.rto++;
    }

    if (!gv.known && gov !== 'غير محدد') dq.unknownGov++;
    if (zone === 'BLANK') dq.blankZone++;
    if (wasShipped && courier === 'غير محدد') dq.noCourierShipped++;
    if (!o.att?.value) dq.attemptsMissing++;

    if (o.cRsn?.value) cancelReasons[o.cRsn.value] = (cancelReasons[o.cRsn.value] || 0) + 1;
    if (o.rRsn?.value) returnReasons[o.rRsn.value] = (returnReasons[o.rRsn.value] || 0) + 1;

    // ── الكاش (COD): المُسلَّم و PAYMENT لسه PENDING = فلوس برّه المتجر ──
    // ⚠️ تلات حالات مش اتنين: محصَّل · لسه · **مش معروف**. لو حقل PAYMENT فاضي
    // على أوردر مُسلَّم، اعتباره «لسه» بيولّد فجوة خزنة وهمية بحجم كل الإيراد
    // وبيصدّر تنبيه أحمر بأكبر أثر مالي في الأداة — على بيانات ناقصة مش على واقع.
    if (delivered) {
      if (payV === 'PAID') collectedCODValue += money.net;
      else if (payV === 'PENDING') { outstandingCODValue += money.net; outstandingCODCount++; }
      else { unknownCODValue += money.net; unknownCODCount++; }
    }

    // ── أزمنة الدورة (تقريبية — الميتافيلد بيتكتب فوقه عند إعادة الطباعة) ──
    const tPrint = o.pt1?.value, tPack = o.pk1?.value;
    if (tPrint) { const h = hoursBetween(o.createdAt, tPrint); if (h != null && h >= 0 && h < 24 * 30) cycle.confirmH.push(h); }
    if (tPrint && tPack) { const h = hoursBetween(tPrint, tPack); if (h != null && h >= 0 && h < 24 * 30) cycle.packH.push(h); }
    if (tPack) { const h = hoursBetween(o.createdAt, tPack); if (h != null && h >= 0 && h < 24 * 30) cycle.toShipH.push(h); }

    // ── الطوابير: العدد **و** العمر (القاعدة 11) ──
    const ageH = hoursBetween(o.createdAt, new Date(nowMs).toISOString());
    const q = { orderId: oid, orderName: o.name, ageH: ageH != null ? round2(ageH) : null,
                value: money.net || money.lost || 0, s1, gov, courier };
    if (TEMP_STATES.includes(s1) && !o.cancelledAt) aging.pendingConfirm.push({ ...q, value: 0 });
    if (s1 === S1.READY && !o.cancelledAt) aging.readyNotShipped.push(q);
    if (s1 === S1.SHIPPED && !o.cancelledAt) aging.shippedNotDelivered.push(q);
    if (isTransit) aging.transitBack.push(q);
    if (delivered && payV === 'PENDING') aging.codOutstanding.push({ ...q, value: money.net });
  }

  for (const k of Object.keys(aging)) aging[k].sort((a, b) => (b.ageH || 0) - (a.ageH || 0));

  // ── 3) السلسلة اليومية (مقارنة بنفس يوم الأسبوع، مش باليوم السابق) ─────
  const series = [];
  let seriesTruncated = false;
  // تمريرة واحدة بدل filter لكل يوم — الشكل القديم كان O(أيام × أوردرات)
  const rowsByDay = {};
  for (const r of orderRows) (rowsByDay[r.day] || (rowsByDay[r.day] = [])).push(r);
  for (let d = range.from; d <= range.to; d = addDaysStr(d, 1)) {
    const ov = rowsByDay[d] || [];
    const m  = byDay[d] || { net: 0, units: 0, cogs: 0 };
    series.push({
      d, dow: dowOf(d),
      orders: ov.length,
      net: round2(m.net), units: m.units, cogs: round2(m.cogs),
      delivered: ov.filter(r => r.bucket === ORDER_BUCKET.DELIVERY_BASIC || r.bucket === ORDER_BUCKET.DELIVERY_EXCHANGE || r.bucket === ORDER_BUCKET.DELIVERY_PARTIAL_RETURN).length,
      rto: ov.filter(r => r.bucket === ORDER_BUCKET.LOST_RTO).length,
      cancelled: ov.filter(r => r.bucket === ORDER_BUCKET.LOST_CANCELLED).length,
    });
    // حارس ذاكرة. القص بيتبلّغ صراحةً — سقف صامت في التجميع هو نفس خطيئة MAX_PAGES.
    if (series.length >= 400) { seriesTruncated = true; break; }
  }

  // ── 4) المنتجات: SKU → ستايل → براند → فئة → كوليكشن → مقاس ─────────
  const productRows = Object.values(bySku).map(s => {
    const meta = metaOf(s.sku);
    const p = parseSku(s.sku);
    if (!p.ok) dq.nonStandardSku++;
    if (!meta && s.units > 0) dq.skuNotInCatalog.add(s.sku);
    const margin = s.net - s.cogs;
    return {
      sku: s.sku, style: p.style, color: p.color, size: p.size,
      vendor: meta?.vendor || '—', type: meta?.type || '—',
      title: meta?.title || null, vid: meta?.vid || null, pid: meta?.pid || null,
      stock: meta ? meta.qty : null, price: meta?.price ?? null, cost: meta?.cost ?? null,
      stylebox: meta?.stylebox || false,
      colls: meta?.colls || [],
      units: s.units, net: round2(s.net), cogs: round2(s.cogs),
      noCostUnits: s.noCost,
      // ⚠️ الهامش **مش** بيتحسب لو في وحدة واحدة اتباعت من غير تكلفة مسجّلة.
      // الحساب الساذج كان بيطلّع «هامش 100%» على موديل تكلفته مجهولة، وده رقم
      // شكله ممتاز ومعناه «مش عارفين» — وهو بالظبط نوع الرقم الغلط اللي بيتصدّق.
      margin: round2(margin),
      marginReliable: s.units > 0 && s.noCost === 0,
      marginPct: (s.units > 0 && s.noCost === 0) ? round2(pct(margin, s.net)) : null,
      costCoverage: s.units ? round2(pct(s.units - s.noCost, s.units)) : null,
      retUnits: s.retUnits, retValue: round2(s.retValue),
      returnRate: round2(pct(s.retUnits, s.units + s.retUnits)),
      lostUnits: s.lostUnits, lostValue: round2(s.lostValue),
      ordersCount: s.orders.size,
    };
  }).sort((a, b) => b.net - a.net);

  const rollup = (list, keyFn) => {
    const m = {};
    for (const r of list) {
      const k = keyFn(r);
      if (k == null) continue;
      const e = m[k] || (m[k] = { key: k, units: 0, net: 0, cogs: 0, retUnits: 0, lostValue: 0, skus: 0, stock: 0, noCostUnits: 0 });
      e.units += r.units; e.net += r.net; e.cogs += r.cogs; e.retUnits += r.retUnits;
      e.lostValue += r.lostValue; e.skus++; e.stock += r.stock || 0;
      e.noCostUnits += r.noCostUnits || 0;
    }
    return Object.values(m).map(e => ({
      ...e, net: round2(e.net), cogs: round2(e.cogs),
      margin: round2(e.net - e.cogs),
      marginReliable: e.units > 0 && e.noCostUnits === 0,
      marginPct: (e.units > 0 && e.noCostUnits === 0) ? round2(pct(e.net - e.cogs, e.net)) : null,
      costCoverage: e.units ? round2(pct(e.units - e.noCostUnits, e.units)) : null,
      returnRate: round2(pct(e.retUnits, e.units + e.retUnits)),
    })).sort((a, b) => b.net - a.net);
  };

  const styles  = rollup(productRows, r => r.style);
  const options = rollup(productRows, r => (r.style && r.color) ? `${r.style} / ${r.color}` : null);
  const vendors = rollup(productRows, r => r.vendor);
  const types   = rollup(productRows, r => r.type);
  const sizes   = rollup(productRows, r => r.size);
  const collMap = {};
  for (const r of productRows) {
    for (const c of (r.colls || [])) {
      const e = collMap[c] || (collMap[c] = { key: c, units: 0, net: 0, cogs: 0, retUnits: 0, lostValue: 0, skus: 0, stock: 0, noCostUnits: 0 });
      e.units += r.units; e.net += r.net; e.cogs += r.cogs; e.retUnits += r.retUnits; e.skus++;
      e.noCostUnits += r.noCostUnits || 0;
    }
  }
  const collections = Object.values(collMap).map(e => ({
    ...e, net: round2(e.net), margin: round2(e.net - e.cogs),
    marginReliable: e.units > 0 && e.noCostUnits === 0,
    marginPct: (e.units > 0 && e.noCostUnits === 0) ? round2(pct(e.net - e.cogs, e.net)) : null,
    returnRate: round2(pct(e.retUnits, e.units + e.retUnits)),
  })).sort((a, b) => b.net - a.net);

  // منحنى المقاسات: نصيب كل مقاس من الوحدات المباعة (للمقاسات الرقمية بس)
  const sizeTotal = sizes.reduce((s, x) => s + x.units, 0);
  const sizeCurve = sizes.map(s => ({ size: s.key, units: s.units, share: round2(pct(s.units, sizeTotal)),
                                      returnRate: s.returnRate }))
                         .sort((a, b) => (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0));
  const coreSizes = new Set(sizeCurve.filter(s => s.share >= 15).map(s => s.size));

  // ── 5) المخزون (الكتالوج × مبيعات الفترة) ───────────────────────────
  const inventory = buildInventory(catalog, bySku, { days, weeks, leadTimeDays, serviceZ, coreSizes, series });

  // ── 6) مؤشرات القمة ─────────────────────────────────────────────────
  const deliveredOrders = orderBoxes.deliveryBasic + orderBoxes.deliveryExchange + orderBoxes.deliveryPartialReturn;
  const finished = deliveredOrders + orderBoxes.lostRTO + orderBoxes.lostFullReturn;
  const grossMargin = boxes.netSales - cogsTotal;

  const kpi = {
    orders: orderBoxes.totalOrders,
    totalValue: round2(boxes.totalValue),
    netSales: round2(boxes.netSales),
    lost: round2(boxes.lost),
    inProgressValue: round2(boxes.inProgress),
    units: unitsSold,
    cogs: round2(cogsTotal),
    grossMargin: round2(grossMargin),
    grossMarginPct: round2(pct(grossMargin, boxes.netSales)),
    costCoveragePct: round2(pct(unitsWithCost, unitsWithCost + unitsNoCost)),
    unitsNoCost,
    aov: round2(safeDiv(boxes.netSales, deliveredOrders)),
    upt: round2(safeDiv(unitsSold, deliveredOrders)),
    asp: round2(safeDiv(boxes.netSales, unitsSold)),
    delivered: deliveredOrders,
    rto: orderBoxes.lostRTO,
    fullReturn: orderBoxes.lostFullReturn,
    cancelled: orderBoxes.lostCancelled,
    transitBack: orderBoxes.inTransitBack,
    inProgressOrders: orderBoxes.totalOrders - finished - orderBoxes.lostCancelled,
    rtoRate: round2(pct(orderBoxes.lostRTO, finished)),
    postDeliveryReturnRate: round2(pct(orderBoxes.lostFullReturn, deliveredOrders + orderBoxes.lostFullReturn)),
    deliveryRate: round2(pct(deliveredOrders, finished)),
    cancelRate: round2(pct(orderBoxes.lostCancelled, orderBoxes.totalOrders)),
    reRequestRate: round2(pct(orderBoxes.deliveryExchange + orderBoxes.deliveryPartialReturn +
                              orderBoxes.prepExchange + orderBoxes.prepReturn +
                              orderBoxes.shippedExchange + orderBoxes.shippedReturn, deliveredOrders)),
    discountTotal: round2(discountTotal),
    discountRate: round2(pct(discountTotal, boxes.netSales + discountTotal)),
    shippingRevenue: round2(shippingRevenue),
    newCustOrders, returningCustOrders, journeyMissing,
    repeatRatePct: round2(pct(returningCustOrders, newCustOrders + returningCustOrders)),
    uniqueCustomers: Object.keys(customers).length,
    styleboxOrders, shopifyOrders: orderBoxes.totalOrders - styleboxOrders,
    outstandingCODValue: round2(outstandingCODValue), outstandingCODCount,
    collectedCODValue: round2(collectedCODValue),
    unknownCODValue: round2(unknownCODValue), unknownCODCount,
    codCollectedPct: round2(pct(collectedCODValue, collectedCODValue + outstandingCODValue)),
    unitsReturned, unitsLost,
    // null معناها «مفيش عيّنة» — الواجهة بتعرض «—» مش «0 ساعة»
    avgConfirmH: cycle.confirmH.length ? round2(median(cycle.confirmH)) : null,
    avgPackH:    cycle.packH.length    ? round2(median(cycle.packH))    : null,
    avgToShipH:  cycle.toShipH.length  ? round2(median(cycle.toShipH))  : null,
    confirmSamples: cycle.confirmH.length,
    packSamples: cycle.packH.length,
    cycleSamples: cycle.toShipH.length,
    days,
    ordersPerDay: round2(safeDiv(orderBoxes.totalOrders, days)),
    netPerDay: round2(safeDiv(boxes.netSales, days)),
  };

  const toList = (m, nameKey) => Object.entries(m).map(([k, v]) => ({
    [nameKey]: k, ...v,
    net: round2(v.net), cogs: round2(v.cogs), lost: round2(v.lost),
    margin: round2(v.net - v.cogs),
    marginPct: round2(pct(v.net - v.cogs, v.net)),
    rtoRate: round2(pct(v.rto, v.delivered + v.rto + v.fullReturn)),
    deliveryRate: round2(pct(v.delivered, v.delivered + v.rto + v.fullReturn)),
    aov: round2(safeDiv(v.net, v.delivered)),
    share: round2(pct(v.orders, orderBoxes.totalOrders)),
  })).sort((a, b) => b.orders - a.orders);

  const geo      = toList(geoMap, 'gov');
  const couriers = toList(courierMap, 'courier');
  const zones    = toList(zoneMap, 'zone');
  const channels = toList(channelMap, 'channel');
  const packers  = toList(packerMap, 'packer');
  const byDow    = toList(dowMap, 'dow');

  // المؤشر المعدَّل للمندوب: نسبة نجاحه ÷ متوسط نجاح **منطقته**.
  // من غير التعديل ده، مندوب شغّال في صعيد مصر هيبان أسوأ من مندوب في مدينة نصر
  // لأسباب مالهاش علاقة بشغله — وده أسرع طريق لفقدان ثقة الفريق في الداشبورد.
  const zoneOfCourier = {};
  for (const r of orderRows) {
    if (!r.courier) continue;
    const z = r.zone || 'BLANK';
    const m = zoneOfCourier[r.courier] || (zoneOfCourier[r.courier] = {});
    m[z] = (m[z] || 0) + 1;
  }
  const zoneRate = {};
  for (const z of zones) zoneRate[z.zone] = z.deliveryRate;
  for (const c of couriers) {
    const zc = zoneOfCourier[c.courier] || {};
    const domZone = Object.entries(zc).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    c.zone = domZone;
    c.zoneDeliveryRate = domZone ? zoneRate[domZone] : null;
    c.adjIndex = (domZone && zoneRate[domZone]) ? round2(c.deliveryRate / zoneRate[domZone]) : null;
  }

  const topCustomers = Object.values(customers)
    .map(c => ({ ...c, net: round2(c.net) }))
    .sort((a, b) => b.net - a.net).slice(0, 50);

  const dataQuality = {
    ...dq,
    skuNotInCatalog: Array.from(dq.skuNotInCatalog).slice(0, 100),
    skuNotInCatalogCount: dq.skuNotInCatalog.size,
    negativeInventory: inventory.negativeQty,
    missingCostVariants: inventory.missingCost,
    priceErrors: inventory.priceErrors,
    vendorDupes: findVendorDupes(catalog?.vendors || []),
    duplicateSkus: catalog?.duplicateSkus || [],
    unclassifiedOrders: orderWarnings.unclassified,
    unclassifiedPieces: warnings.unclassified,
    fulfilmentMismatch: warnings.fulfilmentMismatch,
    redelivery: warnings.redelivery,
    catalogVariantsTruncated: catalog?.warnings?.variantsTruncated || [],
    catalogCollectionsTruncated: catalog?.warnings?.collectionsTruncated || 0,
  };

  return {
    boxes, rows, warnings, orderBoxes, orderRows, orderWarnings,
    kpi, series, seriesTruncated, geo, couriers, zones, channels, packers, byDow,
    products: productRows.slice(0, 1500), styles, options, vendors, types, collections,
    sizeCurve, coreSizes: Array.from(coreSizes),
    reasons: {
      cancel: Object.entries(cancelReasons).map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n),
      ret:    Object.entries(returnReasons).map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n),
    },
    aging, customers: { top: topCustomers, unique: Object.keys(customers).length },
    inventory, dataQuality,
  };
}

// §ANALYTICS::findVendorDupes — براندات باسمين مختلفين (Skechers / Sketchers)
// ⚠️ المحاولة الأولى كانت بتجريد الحروف المتحركة — وفشلت على الحالة الحقيقية نفسها:
//    skechers → skchrs · sketchers → sktchrs (مختلفين). الحل الصح مسافة تحرير
//    (Levenshtein) ≤ 2 على الاسم المطبَّع — بتمسك حرف زايد/ناقص/مقلوب.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function findVendorDupes(vendors) {
  const norm = v => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const list = vendors.filter(Boolean);
  const used = new Set();
  const groups = [];
  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    const g = [list[i]];
    const a = norm(list[i]);
    if (a.length < 4) continue;
    for (let k = i + 1; k < list.length; k++) {
      if (used.has(k)) continue;
      const b = norm(list[k]);
      if (b.length < 4) continue;
      const maxDist = Math.max(1, Math.min(2, Math.floor(Math.max(a.length, b.length) * 0.25)));
      if (a !== b && levenshtein(a, b) <= maxDist) { g.push(list[k]); used.add(k); }
    }
    if (g.length > 1) { used.add(i); groups.push(g); }
  }
  return groups;
}

// §ANALYTICS::buildInventory
function buildInventory(catalog, bySku, ctx) {
  const empty = {
    variants: [], totalValueCost: 0, totalValueRetail: 0, units: 0,
    negativeQty: [], missingCost: [], priceErrors: [], dead: [], lowCover: [],
    brokenOptions: [], byVendor: [], byType: [], oos: 0, available: 0, optionCount: 0,
    unavailable: true,
  };
  if (!catalog || !catalog.variants?.length) return empty;

  const { days, weeks, leadTimeDays, serviceZ, coreSizes } = ctx;
  const out = { ...empty, unavailable: false, negativeQty: [], missingCost: [], priceErrors: [], dead: [], lowCover: [], brokenOptions: [] };
  const vendorAgg = {}, typeAgg = {};
  const optionAgg = {};
  const varRows = [];

  for (const v of catalog.variants) {
    const sold = bySku[v.sku]?.units || 0;
    const qty  = v.qty;
    const cost = v.cost;
    const valueCost   = cost != null ? cost * Math.max(qty, 0) : 0;
    const valueRetail = v.price * Math.max(qty, 0);
    const dailyVel  = safeDiv(sold, days);
    const coverDays = dailyVel > 0 ? qty / dailyVel : (qty > 0 ? Infinity : 0);
    const coverWeeks = dailyVel > 0 ? round2(coverDays / 7) : null;
    // مخزون الأمان: SS = Z × σ_d × √LT — σ_d مقدّرة من الطلب اليومي (توزيع بواسون)
    const sigmaD = Math.sqrt(Math.max(dailyVel, 0));
    const safety = serviceZ * sigmaD * Math.sqrt(leadTimeDays);
    const rop    = dailyVel * leadTimeDays + safety;

    const row = {
      vid: v.vid, pid: v.pid, sku: v.sku, style: v.style, color: v.color, size: v.size,
      title: v.title, vendor: v.vendor, type: v.type, stylebox: v.stylebox, colls: v.colls,
      qty, cost, price: v.price, cmp: v.cmp,
      valueCost: round2(valueCost), valueRetail: round2(valueRetail),
      sold, dailyVel: round2(dailyVel),
      coverWeeks: coverWeeks === null ? null : (Number.isFinite(coverWeeks) ? coverWeeks : null),
      coverInfinite: dailyVel === 0 && qty > 0,
      sellThrough: round2(pct(sold, sold + Math.max(qty, 0))),
      rop: round2(rop), needsReorder: qty > 0 && dailyVel > 0 && qty <= rop,
      marginPct: (cost != null && v.price) ? round2(pct(v.price - cost, v.price)) : null,
    };
    varRows.push(row);

    out.units += Math.max(qty, 0);
    out.totalValueCost   += valueCost;
    out.totalValueRetail += valueRetail;
    if (qty > 0) out.available++; else out.oos++;
    if (qty < 0) out.negativeQty.push(row);
    if (cost == null) out.missingCost.push(row);
    if (v.cmp != null && v.cmp > 0 && v.cmp < v.price) out.priceErrors.push(row);
    if (qty > 0 && sold === 0) out.dead.push(row);
    if (row.needsReorder) out.lowCover.push(row);

    const va = vendorAgg[v.vendor] || (vendorAgg[v.vendor] = { key: v.vendor, qty: 0, valueCost: 0, valueRetail: 0, sold: 0, skus: 0, oos: 0 });
    va.qty += Math.max(qty, 0); va.valueCost += valueCost; va.valueRetail += valueRetail; va.sold += sold; va.skus++; if (qty <= 0) va.oos++;
    const ta = typeAgg[v.type] || (typeAgg[v.type] = { key: v.type, qty: 0, valueCost: 0, valueRetail: 0, sold: 0, skus: 0, oos: 0 });
    ta.qty += Math.max(qty, 0); ta.valueCost += valueCost; ta.valueRetail += valueRetail; ta.sold += sold; ta.skus++; if (qty <= 0) ta.oos++;

    if (v.style && v.color) {
      const ok = `${v.style} / ${v.color}`;
      const oa = optionAgg[ok] || (optionAgg[ok] = { option: ok, style: v.style, color: v.color,
        vendor: v.vendor, title: v.title, pid: v.pid, sizes: [], qty: 0, sold: 0 });
      oa.sizes.push({ size: v.size, qty, sold });
      oa.qty += Math.max(qty, 0); oa.sold += sold;
    }
  }

  // مقاسات مكسورة: مقاس أساسي (نصيبه ≥15% من مبيعات المتجر) نافد
  // بينما الأوبشن نفسه لسه فيه مخزون وبيبيع — ده طلب مكبوت مش نجاح.
  for (const oa of Object.values(optionAgg)) {
    if (oa.qty <= 0 || oa.sold < 3) continue;
    const missingCore = oa.sizes.filter(s => coreSizes.has(s.size) && s.qty <= 0).map(s => s.size);
    const present = oa.sizes.filter(s => s.qty > 0).length;
    const total   = oa.sizes.length;
    if (missingCore.length) {
      out.brokenOptions.push({
        ...oa, missingCore, availability: round2(pct(present, total)),
        sizes: oa.sizes.sort((a, b) => (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0)),
      });
    }
  }
  out.brokenOptions.sort((a, b) => b.sold - a.sold);
  out.optionCount = Object.keys(optionAgg).length;

  const fin = o => Object.values(o).map(e => ({
    ...e, valueCost: round2(e.valueCost), valueRetail: round2(e.valueRetail),
    sellThrough: round2(pct(e.sold, e.sold + e.qty)),
    oosRate: round2(pct(e.oos, e.skus)),
  })).sort((a, b) => b.valueCost - a.valueCost);

  out.byVendor = fin(vendorAgg);
  out.byType   = fin(typeAgg);
  out.variants = varRows.sort((a, b) => b.valueCost - a.valueCost);
  out.totalValueCost   = round2(out.totalValueCost);
  out.totalValueRetail = round2(out.totalValueRetail);
  out.deadValue   = round2(out.dead.reduce((s, r) => s + r.valueCost, 0));
  out.lowCoverCount = out.lowCover.length;
  out.coverWeeksOverall = round2(safeDiv(out.units, safeDiv(
    Object.values(bySku).reduce((s, x) => s + x.units, 0), weeks)));
  out.inStockRate = round2(pct(out.available, out.available + out.oos));
  out.builtAt = catalog.builtAt;
  return out;
}

// ══════════════════════════════════════════════════════
// §INSIGHTS — «المحلل المخضرم» — الطبقة اللي بتقول تعمل إيه، مش بس إيه اللي حصل
//
// أربع قواعد حاكمة، كل واحدة فيهم اتحطت لسبب:
//   ① الترتيب **بالجنيه** مش بالنسبة. انخفاض 60% في قناة بتجيب 3,000 ج.م أقل
//      أهمية من 6% في قناة بتجيب 400,000 — الترتيب بالنسبة بيقلب الأولويات.
//   ② حد أدنى للعيّنة قبل أي تنبيه. نسبة على 7 أوردرات مش إشارة، وWilson
//      interval هو اللي بيقرر: تداخل الفترتين = صمت، مش تنبيه.
//   ③ سقف صارم على العدد المعروض — 3 حرجة فوق، والباقي في تابه.
//      (Google SRE: أي تنبيه لازم يكون قابل للتنفيذ، وإلا بيتجاهل — وبيجرّ معاه غيره)
//   ④ كل رؤية بتقول **تعمل إيه**. "راجع الأرقام" مش إجراء.
//
// شكل الرؤية: { id, sev, domain, title, why, action, impact, impactLabel, evidence[], conf }
// ══════════════════════════════════════════════════════

const SEV_WEIGHT = { critical: 3, watch: 1.6, info: 1 };
const fmtEG = v => Math.round(v || 0).toLocaleString('en-US') + ' ج.م';
const fmtPc = v => (Math.round((v || 0) * 10) / 10) + '%';

function mkInsight(o) {
  return {
    id: o.id, sev: o.sev || 'watch', domain: o.domain || 'عام',
    title: o.title, why: o.why, action: o.action,
    impact: Math.round(o.impact || 0),
    impactLabel: o.impactLabel || (o.impact ? fmtEG(o.impact) : '—'),
    evidence: o.evidence || [], conf: o.conf || 'med',
    tab: o.tab || null, ref: o.ref || null,
  };
}

function buildInsights(cur, prev, ctx) {
  const I = [];
  const k = cur.kpi;
  const pk = prev?.kpi || null;
  const days = k.days;
  const avgOrderNet = safeDiv(k.netSales, k.delivered) || 0;
  const avgRTOLoss  = safeDiv(cur.boxes.lostRTO, k.rto) || avgOrderNet;
  const avgUnitMargin = k.units ? (k.grossMargin / k.units) : 0;
  const finished = k.delivered + k.rto + k.fullReturn;

  // ── 1) نسبة RTO الكلية اتحركت معنويًا ─────────────────────────────
  if (finished >= 40 && pk) {
    const cw = wilson(k.rto, finished);
    const pFin = pk.delivered + pk.rto + pk.fullReturn;
    const pw = wilson(pk.rto, pFin);
    if (pFin >= 40 && ciDisjoint(cw, pw) && cw.p > pw.p) {
      const extra = (cw.p - pw.p) * finished;
      I.push(mkInsight({
        id: 'rto_up', sev: 'critical', domain: 'الشحن والمرتجع', tab: 'geo',
        title: `نسبة الرفض (RTO) طلعت من ${fmtPc(pw.p * 100)} لـ ${fmtPc(cw.p * 100)}`,
        why: `الفرق ده إحصائيًا حقيقي مش صدفة (فترتا الثقة 95% مش متداخلتين). ` +
             `يعني ${Math.round(extra)} أوردر زيادة رجعوا من غير ما يتحصّل منهم جنيه، ` +
             `وكل واحد فيهم دفعنا فيه شحن رايح وجاي.`,
        action: `افتح تاب «الجغرافيا والمناديب» ورتّب بالـ RTO: لو الزيادة مركزة في محافظة أو ` +
                `مندوب واحد، ابدأ بيهم. لو موزّعة، المشكلة غالبًا في التأكيد قبل الشحن مش في التوصيل.`,
        impact: extra * avgRTOLoss, conf: 'high',
        evidence: [`الفترة الحالية: ${k.rto} من ${finished} أوردر منتهي`,
                   `الفترة السابقة: ${pk.rto} من ${pFin}`,
                   `متوسط الخسارة في أوردر RTO: ${fmtEG(avgRTOLoss)}`],
      }));
    }
  }

  // ── 2) محافظة الـ RTO فيها أعلى من المتوسط معنويًا ────────────────
  const baseRTO = safeDiv(k.rto, finished);
  for (const g of cur.geo) {
    const gFin = g.delivered + g.rto + g.fullReturn;
    if (gFin < 20 || !g.rto) continue;
    // ⚠️ لازم مجموعة المقارنة نفسها تكون كبيرة كفاية — من غير الشرط ده، محافظة
    // بتغطي الفترة كلها بتتقارن بعيّنة صناعية n=1.
    const restN = finished - gFin;
    if (restN < 20) continue;
    const z = twoPropZ(g.rto, gFin, k.rto - g.rto, restN);
    if (z > 1.96) {
      const excess = (g.rto / gFin - baseRTO) * gFin;
      if (excess < 1) continue;
      I.push(mkInsight({
        id: 'rto_gov_' + g.gov, sev: 'critical', domain: 'الجغرافيا', tab: 'geo',
        title: `${g.gov}: نسبة الرفض ${fmtPc(g.rtoRate)} مقابل ${fmtPc(baseRTO * 100)} في باقي المحافظات`,
        why: `الفرق معنوي إحصائيًا (z = ${round2(z)}) على ${gFin} أوردر منتهي — مش عيّنة صغيرة. ` +
             `المحافظة دي لوحدها كلّفتنا حوالي ${Math.round(excess)} أوردر مرفوض **زيادة** عن المعدل الطبيعي.`,
        action: `طبّق واحد من التلاتة على ${g.gov}: (١) تأكيد واتساب إجباري قبل الشحن، ` +
                `(٢) دفع مقدم جزئي للعميل الجديد، (٣) تغيير شركة الشحن للمنطقة دي. ` +
                `ابدأ بالأول — أرخصهم وأسرعهم أثرًا.`,
        impact: excess * avgRTOLoss, conf: gFin >= 50 ? 'high' : 'med',
        evidence: [`${g.rto} مرفوض من ${gFin} منتهي`, `نصيب المحافظة من الأوردرات: ${fmtPc(g.share)}`,
                   `صافي مبيعات المحافظة: ${fmtEG(g.net)}`],
      }));
    }
  }

  // ── 3) مندوب أداؤه أقل من متوسط منطقته ────────────────────────────
  for (const c of cur.couriers) {
    if (c.courier === 'غير محدد' || c.shipped < 25) continue;
    if (c.adjIndex == null || c.adjIndex >= 0.9) continue;
    const cFin = c.delivered + c.rto + c.fullReturn;
    if (cFin < 20) continue;
    const gap = (c.zoneDeliveryRate - c.deliveryRate) / 100 * cFin;
    if (gap < 1) continue;
    I.push(mkInsight({
      id: 'courier_' + c.courier, sev: 'watch', domain: 'المناديب', tab: 'geo',
      title: `${c.courier}: نسبة التسليم ${fmtPc(c.deliveryRate)} مقابل ${fmtPc(c.zoneDeliveryRate)} لمنطقته`,
      why: `المقارنة دي **معدَّلة على المنطقة** (${c.zone}) — يعني الفرق مش سببه إن ` +
           `شغله في منطقة أصعب. مؤشره ${c.adjIndex} (1.00 = بالظبط زي متوسط منطقته).`,
      action: `اقعد معاه على ${Math.min(cFin, 10)} شحنة مرفوضة من بتاعته وشوف السبب المتكرر: ` +
              `توقيت المحاولة؟ عدم الاتصال قبل الوصول؟ لو السبب اتكرر، اللي محتاج يتغيّر إجراء مش شخص.`,
      impact: gap * avgRTOLoss, conf: cFin >= 40 ? 'high' : 'med',
      evidence: [`${c.shipped} شحنة · ${c.delivered} تسليم · ${c.rto} مرفوض`,
                 `منطقته الأساسية: ${c.zone}`],
    }));
  }

  // ── 4) طابور التأكيد قديم ─────────────────────────────────────────
  const stale24 = cur.aging.pendingConfirm.filter(x => (x.ageH || 0) > 24);
  if (stale24.length) {
    const oldest = stale24[0];
    I.push(mkInsight({
      id: 'queue_confirm', sev: 'critical', domain: 'التشغيل', tab: 'ops',
      title: `${stale24.length} أوردر مستني تأكيد من أكتر من ٢٤ ساعة`,
      why: `كل ساعة زيادة قبل التأكيد بتزوّد احتمال الرفض والإلغاء — العميل بينسى، ` +
           `أو بيلاقي بديل، أو بيتغيّر رأيه. أقدم واحد قاعد ${Math.round(oldest.ageH)} ساعة.`,
      action: `اعمل جولة واتساب النهارده على الـ ${stale24.length} دول بالترتيب من الأقدم. ` +
              `ولو الرقم ده بيتكرر كل يوم، المشكلة في طاقة فريق التأكيد مش في يوم بعينه.`,
      impact: stale24.length * avgOrderNet * 0.25, conf: 'high',
      impactLabel: `≈ ${fmtEG(stale24.length * avgOrderNet * 0.25)} معرّضة للضياع`,
      evidence: [`أقدم أوردر: ${oldest.orderName} — ${Math.round(oldest.ageH)} ساعة`,
                 `الحالات: ${[...new Set(stale24.map(x => x.s1))].join(' · ')}`],
    }));
  }

  // ── 5) Ready وما خرجش ────────────────────────────────────────────
  const readyStale = cur.aging.readyNotShipped.filter(x => (x.ageH || 0) > 48);
  if (readyStale.length) {
    I.push(mkInsight({
      id: 'queue_ready', sev: 'watch', domain: 'التشغيل', tab: 'ops',
      title: `${readyStale.length} أوردر جاهز وما خرجش للشحن من أكتر من ٤٨ ساعة`,
      why: `الأوردر اتأكد واتجهّز وخد تكلفة تغليف بالفعل، وواقف. ده أسوأ نوع تأخير ` +
           `لأن كل المجهود اتعمل والعميل لسه مستني.`,
      action: `راجع جدول استلام شركة الشحن — التأخير عادةً في موعد البيك أب مش في التجهيز. ` +
              `لو الاستلام يومي، الأوردرات دي فاتها أكتر من موعد.`,
      impact: readyStale.reduce((s, x) => s + (x.value || 0), 0) * 0.15, conf: 'med',
      evidence: [`أقدم واحد: ${readyStale[0].orderName} — ${Math.round(readyStale[0].ageH)} ساعة`],
    }));
  }

  // ── 6) اتشحن وما اتسلّمش ─────────────────────────────────────────
  const shipStale = cur.aging.shippedNotDelivered.filter(x => (x.ageH || 0) > 24 * 7);
  if (shipStale.length) {
    I.push(mkInsight({
      id: 'queue_shipped', sev: 'watch', domain: 'الشحن', tab: 'ops',
      title: `${shipStale.length} شحنة عدّى عليها أسبوع وهي "خرجت للشحن" وما اتسلّمتش`,
      why: `الشحنة اللي بتعدّي أسبوع بتتحول لمرتجع في الغالب — والفلوس دي محسوبة عندنا ` +
           `"قيد التنفيذ" وهي فعليًا شبه ضايعة.`,
      action: `ابعت القائمة دي لشركة الشحن كـ NDR وطلب تحديث حالة إجباري خلال ٤٨ ساعة. ` +
              `واللي مالوش تحديث، اعتبره مرتجع في التخطيط ما تستناش.`,
      impact: shipStale.reduce((s, x) => s + (x.value || 0), 0) * 0.4, conf: 'med',
      evidence: [`أقدم شحنة: ${shipStale[0].orderName} — ${Math.round((shipStale[0].ageH || 0) / 24)} يوم`],
    }));
  }

  // ── 7) فلوس COD مُسلَّمة وما اتحصّلتش ─────────────────────────────
  if (k.outstandingCODCount > 0 && k.outstandingCODValue > 0) {
    const old7 = cur.aging.codOutstanding.filter(x => (x.ageH || 0) > 24 * 7);
    I.push(mkInsight({
      id: 'cod_outstanding', sev: old7.length ? 'critical' : 'watch', domain: 'الخزنة', tab: 'cash',
      title: `${fmtEG(k.outstandingCODValue)} اتسلّمت للعميل ولسه ما اتسجّلتش كمحصَّلة`,
      why: `${k.outstandingCODCount} أوردر حالتهم "تم التسليم" وحقل PAYMENT لسه PENDING. ` +
           `ده معناه واحد من اتنين: الفلوس فعلًا لسه مع المندوب/شركة الشحن، أو اتحصّلت ` +
           `وما اتسجّلتش. الاتنين محتاجين تدخّل — التاني أخطر لأنه بيخفي فجوة.`,
      action: `طابق الكشف ده مع كشف تحصيل شركة الشحن. أي أوردر عدّى ٧ أيام تسليم ولسه ` +
              `PENDING يدخل قايمة مطالبة رسمية النهارده${old7.length ? ` (عندك ${old7.length} منهم دلوقتي)` : ''}.`,
      impact: k.outstandingCODValue, conf: 'high',
      evidence: [`نسبة التحصيل الحالية: ${fmtPc(k.codCollectedPct)}`,
                 `أقدم مبلغ غير محصَّل: ${old7.length ? Math.round(old7[0].ageH / 24) + ' يوم' : 'أقل من أسبوع'}`],
    }));
  }

  // ── 8) نفاد وشيك ─────────────────────────────────────────────────
  const inv = cur.inventory;
  if (!inv.unavailable && inv.lowCover.length) {
    // ⚠️ الفاريانت اللي تكلفته null كان بياخد هامش = السعر بالكامل، فبيتصدّر
    // الترتيب بأثر وهمي — والأثر هو مفتاح ترتيب كل الرؤى، فبيزق رؤية حقيقية بره
    // أعلى تلاتة. بنستبعده ونقول كام واحد استُبعد.
    const priced = inv.lowCover.filter(r => r.cost != null && r.price);
    const unpriced = inv.lowCover.length - priced.length;
    const top = priced
      .map(r => ({ ...r, lostUnits: Math.max(0, r.dailyVel * ctx.leadTimeDays - r.qty) }))
      .map(r => ({ ...r, lostMargin: r.lostUnits * (r.price - r.cost) }))
      .sort((a, b) => b.lostMargin - a.lostMargin);
    const totalLost = top.reduce((s, r) => s + r.lostMargin, 0);
    if (totalLost > 0) {
      I.push(mkInsight({
        id: 'stock_reorder', sev: 'critical', domain: 'المخزون', tab: 'stock',
        title: `${inv.lowCover.length} مقاس هيخلص قبل ما الشحنة الجديدة توصل`,
        why: `المقاسات دي بتبيع بمعدل معروف، والكمية اللي فيها أقل من نقطة إعادة الطلب ` +
             `(مهلة التوريد ${ctx.leadTimeDays} يوم + مخزون أمان بمستوى خدمة 95%). ` +
             `يعني هتقف عن البيع قبل ما توصل.`,
        action: `اطلب دلوقتي أعلى ١٠ في القايمة — دول لوحدهم بيمثلوا الجزء الأكبر من الخسارة. ` +
                `أعلى واحد: ${top[0].sku} (${top[0].qty} متاح، بيبيع ${top[0].dailyVel}/يوم).`,
        impact: totalLost, conf: 'med',
        impactLabel: `≈ ${fmtEG(totalLost)} ربح ضايع`,
        evidence: top.slice(0, 5).map(r => `${r.sku}: متاح ${r.qty} · نقطة الطلب ${r.rop} · ربح معرّض ${fmtEG(r.lostMargin)}`)
          .concat(unpriced ? [`${unpriced} مقاس مستبعد من حساب الأثر لأن تكلفته مش مسجّلة`] : []),
      }));
    }
  }

  // ── 9) مخزون راكد ────────────────────────────────────────────────
  // ⚠️ البوابة دي مقصودة: «ما باعش في ١٤ يوم» مش ركود — ده الوضع الطبيعي لمعظم
  // المقاسات في متجر أحذية. التنبيه مايظهرش غير على فترة ٣٠ يوم فأكتر، ووقتها
  // بيبقى بيقول حاجة حقيقية. تاب المخزون بيعرض الرقم على أي فترة مع كتابة الفترة.
  if (!inv.unavailable && days >= 30 && inv.deadValue >= 10000) {
    const topDead = inv.dead.slice(0, 5);
    I.push(mkInsight({
      id: 'stock_dead', sev: 'watch', domain: 'المخزون', tab: 'stock',
      title: `${fmtEG(inv.deadValue)} مخزون ما باعش ولا قطعة في ${days} يوم`,
      why: `${inv.dead.length} مقاس فيهم كمية وما باعوش خالص خلال الفترة المختارة. ` +
           `الفلوس دي نايمة — كانت ممكن تكون بضاعة بتتحرك. ` +
           `⚠️ الرقم ده مربوط بالفترة: اختار ٩٠ يوم عشان تفرّق بين "بطيء" و"ميّت".`,
      action: `قسّمهم لتلاتة: (١) مقاس طرفي في ستايل شغّال → استنى، (٢) ستايل كامل واقف ` +
              `→ خصم ٣٠-٤٠% أو نقله لكوليكشن تصفية، (٣) عدّى ٦ شهور → صفّيه بأي سعر يغطي التكلفة.`,
      impact: inv.deadValue * 0.15, conf: 'med',
      impactLabel: `${fmtEG(inv.deadValue)} رأس مال نايم`,
      evidence: topDead.map(r => `${r.sku}: ${r.qty} قطعة · ${fmtEG(r.valueCost)} بالتكلفة`),
    }));
  }

  // ── 10) مقاسات مكسورة ────────────────────────────────────────────
  if (!inv.unavailable && inv.brokenOptions.length) {
    const b = inv.brokenOptions.slice(0, 6);
    const est = b.reduce((s, o) => s + o.sold * 0.35 * avgUnitMargin, 0);
    I.push(mkInsight({
      id: 'stock_broken_sizes', sev: 'watch', domain: 'المخزون', tab: 'stock',
      title: `${inv.brokenOptions.length} موديل بيبيع وناقصه مقاس أساسي`,
      why: `المقاسات الأساسية (اللي بتمثل ١٥%+ من مبيعاتنا) نافدة في الموديلات دي بينما ` +
           `المقاسات الطرفية لسه موجودة. المبيعات اللي بتشوفها **أقل من الطلب الحقيقي** — ` +
           `العميل اللي مقاسه ناقص بيمشي، وما بيسيبش أثر في أي تقرير.`,
      action: `الموديلات دي أولوية إعادة الطلب قبل أي موديل جديد — الطلب عليها متأكد مش متوقع. ` +
              `وطول ما المقاس ناقص، شيلهم من الإعلانات عشان ما تدفعش على زيارات مش هتتحوّل.`,
      impact: est, conf: 'low',
      impactLabel: `≈ ${fmtEG(est)} مبيعات مكبوتة (تقدير)`,
      evidence: b.map(o => `${o.option}: ناقص ${o.missingCore.join('، ')} · باع ${o.sold} قطعة`),
    }));
  }

  // ── 11-13) جودة بيانات المخزون والتسعير ──────────────────────────
  if (!inv.unavailable && inv.negativeQty.length) {
    I.push(mkInsight({
      id: 'dq_negative_stock', sev: 'watch', domain: 'جودة البيانات', tab: 'stock',
      title: `${inv.negativeQty.length} مقاس مخزونه بالسالب`,
      why: `المخزون بالسالب معناه إننا بعنا أكتر من اللي مسجّل — يا إما جرد ناقص، ` +
           `يا إما بيع من غير خصم مخزون. الرقم ده بيخلي "قيمة المخزون" و"التغطية" غلط.`,
      action: `اعمل جرد فوري للمقاسات دي بأداة الجرد، وصحّح الكمية. ` +
              `ولو بتتكرر على نفس الموديلات، المشكلة في خطوة التغليف مش في الجرد.`,
      impact: 0, impactLabel: 'يفسد أرقام المخزون', conf: 'high',
      evidence: inv.negativeQty.slice(0, 5).map(r => `${r.sku}: ${r.qty}`),
    }));
  }
  // ⚠️ من غير شرط الوحدات، فترة فاضية (أول الصبح على نطاق مفتوح) بتطلّع تنبيه
  // أحمر «تغطية التكلفة 0%» بيقول إن الهامش مبالغ فيه — والهامش أصلاً مش موجود.
  if (!inv.unavailable && inv.missingCost.length && k.units > 0 && k.costCoveragePct < 99) {
    I.push(mkInsight({
      id: 'dq_missing_cost', sev: k.costCoveragePct < 90 ? 'critical' : 'watch',
      domain: 'جودة البيانات', tab: 'sales',
      title: `${inv.missingCost.length} مقاس نشط من غير تكلفة — تغطية التكلفة ${fmtPc(k.costCoveragePct)}`,
      why: `أي وحدة اتباعت من غير تكلفة مسجّلة بتدخل الإيراد وما بتدخلش تكلفة البضاعة، ` +
           `فالهامش المعروض **أعلى من الحقيقة**. النسبة دي هي بالظبط قد إيه تثق في رقم الربح.`,
      action: `افتح أداة Products Cost Check وسجّل تكلفة المقاسات دي. ` +
              `لحد ما التغطية توصل 100%، اقرا الهامش كسقف أعلى مش كرقم نهائي.`,
      impact: k.units ? (k.unitsNoCost / k.units) * k.netSales * 0.4 : 0, conf: 'high',
      impactLabel: `الهامش مبالغ فيه بحوالي ${fmtEG(k.unitsNoCost * avgUnitMargin)}`,
      evidence: [`${k.unitsNoCost} وحدة اتباعت من غير تكلفة`,
                 ...inv.missingCost.slice(0, 3).map(r => `${r.sku}`)],
    }));
  }
  if (!inv.unavailable && inv.priceErrors.length) {
    I.push(mkInsight({
      id: 'dq_price_error', sev: 'watch', domain: 'جودة البيانات', tab: 'products',
      title: `${inv.priceErrors.length} مقاس سعر المقارنة فيه **أقل** من سعر البيع`,
      why: `سعر المقارنة (compare-at) المفروض يكون السعر الأصلي الأعلى. لما يكون أقل، ` +
           `الموقع بيعرض "خصم بالسالب" أو بيخفي الخصم خالص — والعميل بيشوف حاجة غير متسقة.`,
      action: `صحّح سعر المقارنة للمقاسات دي أو امسحه. ` +
              `الأسهل: امسحه لو مش متأكد من السعر الأصلي.`,
      impact: 0, impactLabel: 'يضر الثقة على الموقع', conf: 'high',
      evidence: inv.priceErrors.slice(0, 5).map(r => `${r.sku}: البيع ${r.price} · المقارنة ${r.cmp}`),
    }));
  }

  // ── 14) SKU هامشه تحت الحد على حجم عالي ──────────────────────────
  const lowMargin = cur.products
    .filter(p => p.units >= 5 && p.net > 0 && p.marginReliable && p.marginPct < ctx.marginFloorPct)
    .sort((a, b) => ((ctx.marginFloorPct - b.marginPct) * b.net) - ((ctx.marginFloorPct - a.marginPct) * a.net));
  if (lowMargin.length) {
    const gap = lowMargin.reduce((s, p) => s + (ctx.marginFloorPct - p.marginPct) / 100 * p.net, 0);
    I.push(mkInsight({
      id: 'margin_floor', sev: 'critical', domain: 'الربحية', tab: 'products',
      title: `${lowMargin.length} موديل بيبيع كويس وهامشه أقل من ${ctx.marginFloorPct}%`,
      why: `الموديلات دي بتاخد نفس مجهود التغليف والشحن والتحصيل بتاع أي موديل تاني، ` +
           `وبتسيب ربح أقل. ودي مش موديلات ضعيفة — دي موديلات **بتبيع**، وده اللي بيخلي ` +
           `الخسارة تكبر مع الحجم.`,
      action: `تلات خيارات مرتبة بالسهولة: (١) ارفع السعر 5-10% وراقب الكمية أسبوعين، ` +
              `(٢) تفاوض على تكلفة الشراء مع المورّد، (٣) وقّف الإعلان عليها ووجّهه لموديل هامشه أعلى.`,
      impact: gap, conf: 'high',
      evidence: lowMargin.slice(0, 5).map(p => `${p.sku}: ${p.units} قطعة · هامش ${fmtPc(p.marginPct)} · ${fmtEG(p.net)}`),
    }));
  }

  // ── 15) معدل مرتجع SKU أعلى من الكتالوج معنويًا ──────────────────
  const totRet = cur.products.reduce((s, p) => s + p.retUnits, 0);
  const totSold = cur.products.reduce((s, p) => s + p.units, 0);
  const baseRet = safeDiv(totRet, totSold + totRet);
  for (const p of cur.products) {
    if (p.units < 30 || p.retUnits < 3) continue;
    const z = twoPropZ(p.retUnits, p.units + p.retUnits, totRet - p.retUnits, Math.max(totSold + totRet - p.units - p.retUnits, 1));
    if (z > 1.96) {
      I.push(mkInsight({
        id: 'ret_sku_' + p.sku, sev: 'watch', domain: 'المنتجات', tab: 'products',
        title: `${p.sku}: معدل المرتجع ${fmtPc(p.returnRate)} مقابل ${fmtPc(baseRet * 100)} للكتالوج`,
        why: `الفرق معنوي (z = ${round2(z)}) على ${p.units} وحدة مباعة — مش صدفة. ` +
             `في الأحذية، السبب الأول للمرتجع بفارق كبير هو المقاس، ` +
             `يليه اختلاف اللون/الشكل عن الصور.`,
        action: `افتح ${p.style} وشوف: (١) هل المرتجع مركّز في مقاس معيّن؟ يبقى المقاس ` +
                `بيجيب صغير/كبير → اكتب تنبيه في صفحة المنتج. (٢) لو موزّع، راجع الصور والوصف.`,
        impact: p.retValue, conf: 'med',
        evidence: [`${p.retUnits} مرتجع من ${p.units + p.retUnits} وحدة`, `قيمة المرتجع: ${fmtEG(p.retValue)}`],
      }));
    }
  }

  // ── 16) سبب مرتجع متكرر ──────────────────────────────────────────
  const topRetReason = cur.reasons.ret[0];
  if (topRetReason && topRetReason.n >= 5) {
    const share = pct(topRetReason.n, cur.reasons.ret.reduce((s, r) => s + r.n, 0));
    I.push(mkInsight({
      id: 'ret_reason', sev: 'watch', domain: 'المنتجات', tab: 'products',
      title: `«${topRetReason.v}» سبب ${fmtPc(share)} من المرتجعات المسجّلة`,
      why: `لما سبب واحد يتصدّر بالشكل ده، ده مش سلوك عملاء — ده مشكلة عندنا قابلة للإصلاح. ` +
           `وده أرخص نوع مشكلة تصلّحها، لأنها بتقلّل شحن مرتجع وتحسّن تقييم في نفس الوقت.`,
      action: `لو السبب مقاس: ضيف جدول مقاسات حقيقي مقاس بالسنتيمتر لكل ستايل + تنبيه ` +
              `"يجيب صغير/كبير" على الموديلات المتكررة. لو السبب صور: صوّر المنتج بإضاءة طبيعية وبقدم عليه.`,
      impact: cur.boxes.lostFinalReturn * (share / 100), conf: 'med',
      evidence: cur.reasons.ret.slice(0, 5).map(r => `${r.v}: ${r.n}`),
    }));
  }

  // ── 17) عمق الخصم زاد ────────────────────────────────────────────
  if (pk && k.discountRate > pk.discountRate + 2 && k.discountTotal > 0) {
    const extra = (k.discountRate - pk.discountRate) / 100 * (k.netSales + k.discountTotal);
    I.push(mkInsight({
      id: 'discount_creep', sev: 'watch', domain: 'الربحية', tab: 'sales',
      title: `عمق الخصم طلع من ${fmtPc(pk.discountRate)} لـ ${fmtPc(k.discountRate)}`,
      why: `الخصم بيتخصم من الهامش مباشرةً، وبيتحوّل بسرعة لعادة: العميل بيستنى الخصم ` +
           `بدل ما يشتري بالسعر العادي. الزيادة دي وحدها كلّفت ${fmtEG(extra)} من الربح.`,
      action: `شوف الخصم رايح فين: لو مركّز في تصفية مخزون راكد يبقى مقصود وكويس. ` +
              `لو موزّع على الموديلات الجديدة كمان، يبقى محتاج سقف على الخصم.`,
      impact: extra, conf: 'high',
      evidence: [`إجمالي الخصم: ${fmtEG(k.discountTotal)}`, `الفترة السابقة: ${fmtEG(pk.discountTotal)}`],
    }));
  }

  // ── 18) نسبة العملاء العائدين نزلت ───────────────────────────────
  if (pk && k.orders >= 100 && pk.orders >= 100) {
    const cw = wilson(k.returningCustOrders, k.newCustOrders + k.returningCustOrders);
    const pw = wilson(pk.returningCustOrders, pk.newCustOrders + pk.returningCustOrders);
    if (ciDisjoint(cw, pw) && cw.p < pw.p) {
      const lostOrders = (pw.p - cw.p) * k.orders;
      I.push(mkInsight({
        id: 'repeat_down', sev: 'watch', domain: 'العملاء', tab: 'customers',
        title: `نسبة العملاء العائدين نزلت من ${fmtPc(pw.p * 100)} لـ ${fmtPc(cw.p * 100)}`,
        why: `العميل العائد أرخص بكتير من العميل الجديد — مفيش تكلفة اكتساب، ونسبة رفضه ` +
             `أقل لأنه جرّبنا قبل كده. نزول النسبة دي معناه إننا بنشتري نمو بدل ما نبنيه.`,
        action: `شغّل حملة استرجاع على عملاء آخر ٩٠ يوم اللي ما اشتروش تاني، بعرض على ` +
                `الموديلات اللي اشتروا شبهها. والأهم: راجع تجربة أول أوردر — الرفض ` +
                `والتأخير هما أكبر سبب لعدم التكرار.`,
        impact: lostOrders * avgOrderNet, conf: 'med',
        evidence: [`عائدين: ${k.returningCustOrders} من ${k.newCustOrders + k.returningCustOrders}`,
                   `الفترة السابقة: ${pk.returningCustOrders} من ${pk.newCustOrders + pk.returningCustOrders}`],
      }));
    }
  }

  // ── 19) شذوذ في السلسلة اليومية (مقارنة بنفس يوم الأسبوع) ────────
  if (cur.series.length >= 14) {
    // ⚠️ اليوم الجاري **ناقص** بطبيعته — مقارنته بأيام كاملة بتولّد تنبيه أحمر
    // كاذب كل يوم الصبح («٧ أوردرات مقابل ٩٥ المعتاد»)، وبأعلى أثر مالي، فبيتصدّر
    // الشاشة ويدفن الرؤى الحقيقية. بنفحص آخر يوم **مكتمل** بس.
    const today = cairoTodayStr();
    const complete = cur.series.filter(s => s.d < today);
    const last = complete[complete.length - 1];
    const sameDow = last ? complete.slice(0, -1).filter(s => s.dow === last.dow).map(s => s.orders) : [];
    if (last && sameDow.length >= 3) {
      const z = robustZ(last.orders, sameDow);
      if (Math.abs(z) >= 3.5) {
        const med = median(sameDow);
        const cp = cusumChangePoint(cur.series.map(s => ({ d: s.d, v: s.orders })));
        I.push(mkInsight({
          id: 'anomaly_orders', sev: z < 0 ? 'critical' : 'info', domain: 'المبيعات', tab: 'sales',
          title: z < 0
            ? `أوردرات ${last.d} (${last.orders}) أقل بكتير من المعتاد لنفس اليوم (${med})`
            : `أوردرات ${last.d} (${last.orders}) أعلى بكتير من المعتاد لنفس اليوم (${med})`,
          why: `المقارنة مع **نفس يوم الأسبوع** في الأسابيع اللي فاتت، مش مع امبارح — ` +
               `عشان السبت مش زي الثلاثاء. الانحراف ${round2(Math.abs(z))} ضعف الانحراف الطبيعي.` +
               (cp ? ` وأول يوم اتغيّر فيه المستوى فعليًا كان ${cp}.` : ''),
          action: z < 0
            ? `افحص بالترتيب: الموقع شغّال؟ الإعلانات واقفة أو خلص بدجت؟ في عطلة أو حدث؟ ` +
              `لو كله تمام، المشكلة في المخزون — شوف تاب المخزون.`
            : `شوف مصدر الزيادة (حملة؟ منتج معيّن؟) وتأكد إن المخزون يستحمل الاستمرار.`,
          impact: Math.abs(last.orders - med) * avgOrderNet, conf: 'med',
          evidence: [`نفس اليوم في الأسابيع السابقة: ${sameDow.join(' · ')}`],
        }));
      }
    }
  }

  // ── 20-21) التركّز ───────────────────────────────────────────────
  const top10 = cur.products.slice(0, 10).reduce((s, p) => s + p.net, 0);
  if (k.netSales > 0 && pct(top10, k.netSales) > 50) {
    I.push(mkInsight({
      id: 'concentration_sku', sev: 'info', domain: 'المخاطر', tab: 'products',
      title: `أعلى ١٠ موديلات بيمثلوا ${fmtPc(pct(top10, k.netSales))} من المبيعات`,
      why: `التركّز ده سيف بحدّين: بيسهّل الشراء والتخطيط، وبيخلي أي نفاد أو مشكلة مورّد ` +
           `في موديل واحد يضرب المبيعات كلها.`,
      action: `اتأكد إن الـ ١٠ دول مخزونهم مأمّن ومورّدهم مش واحد. وابدأ تجرّب توسيع ` +
              `الصف التاني (الموديلات ١١-٣٠) بميزانية إعلان صغيرة.`,
      impact: 0, impactLabel: 'مخاطرة تركّز', conf: 'high',
      evidence: cur.products.slice(0, 5).map(p => `${p.sku}: ${fmtEG(p.net)}`),
    }));
  }
  const topGov = cur.geo[0];
  if (topGov && topGov.share > 50) {
    I.push(mkInsight({
      id: 'concentration_gov', sev: 'info', domain: 'المخاطر', tab: 'geo',
      title: `${topGov.gov} لوحدها ${fmtPc(topGov.share)} من الأوردرات`,
      why: `الاعتماد على منطقة واحدة بيخلي أي مشكلة شحن أو منافس محلي فيها يضرب ` +
           `المبيعات كلها — وفي نفس الوقت بيقول إن باقي مصر لسه فرصة مفتوحة.`,
      action: `اختار أعلى ٣ محافظات بعدها من حيث الأوردرات ونسبة تسليمها كويسة، ` +
              `وجرّب حملة موجّهة عليهم بميزانية محدودة قبل التوسّع الكامل.`,
      impact: 0, impactLabel: 'فرصة توسّع', conf: 'high',
      evidence: cur.geo.slice(0, 5).map(g => `${g.gov}: ${g.orders} أوردر · تسليم ${fmtPc(g.deliveryRate)}`),
    }));
  }

  // ── 22) اتشحن بدون مندوب ─────────────────────────────────────────
  if (cur.dataQuality.noCourierShipped > 0) {
    I.push(mkInsight({
      id: 'dq_no_courier', sev: 'watch', domain: 'جودة البيانات', tab: 'geo',
      title: `${cur.dataQuality.noCourierShipped} شحنة خرجت من غير مندوب/شركة مسجّلة`,
      why: `الشحنات دي مش داخلة في أي تقييم لمندوب ولا شركة — يعني تقييم المناديب ` +
           `اللي بتشوفه مبني على أقل من الحقيقة، وأي مشكلة فيها مالهاش صاحب.`,
      action: `اتأكد إن أداة تسجيل الشحن بتكتب حقل courier إجباريًا. ` +
              `والشحنات الحالية اتملّى يدويًا من كشف شركة الشحن.`,
      impact: 0, impactLabel: 'تقييم المناديب ناقص', conf: 'high',
      evidence: [`إجمالي الشحنات في الفترة: ${cur.couriers.reduce((s, c) => s + c.shipped, 0)}`],
    }));
  }

  // ── 23) كناري الأعطال: خارج التصنيف ──────────────────────────────
  if (cur.orderWarnings.unclassified > 0 || cur.warnings.unclassified > 0) {
    I.push(mkInsight({
      id: 'dq_unclassified', sev: 'critical', domain: 'جودة البيانات', tab: 'ops',
      title: `${cur.orderWarnings.unclassified} أوردر و${cur.warnings.unclassified} قطعة خارج التصنيف`,
      why: `المربع ده هو **كناري الأعطال** في الأداة: أي حالة جديدة أو تعارض بين ` +
           `شوبيفاي والميتافيلد بيقع هنا بدل ما يتبلع في مربع تاني ويطلع رقم غلط شكله سليم. ` +
           `وجوده مش عطل في الداشبورد — هو الداشبورد بيقول لك في بيانات محتاجة مراجعة.`,
      action: `افتح الجدول واشوف الحالات: الغالب أوردر manual_status فيه Returned/Cancelled ` +
              `من غير إلغاء فعلي في شوبيفاي. ده بيتصلّح من أداة تحديث الحالة.`,
      impact: 0, impactLabel: 'أرقام محتاجة مراجعة', conf: 'high',
      evidence: [`قطع بحالة شحن متعارضة: ${cur.warnings.fulfilmentMismatch}`,
                 `محاولات تسليم مكررة: ${cur.warnings.redelivery}`],
    }));
  }

  // ── 24) براندات متكررة بأسماء مختلفة ─────────────────────────────
  for (const g of cur.dataQuality.vendorDupes) {
    I.push(mkInsight({
      id: 'dq_vendor_dupe_' + g[0], sev: 'info', domain: 'جودة البيانات', tab: 'products',
      title: `براند مكتوب بأكتر من هجاء: ${g.join(' / ')}`,
      why: `الأداة بتحسبهم براندين مختلفين، فمبيعات البراند بتتقسم على اتنين وبيبان ` +
           `أضعف من حقيقته في أي ترتيب.`,
      action: `وحّد الاسم من شوبيفاي (Products → تعديل جماعي → Vendor).`,
      impact: 0, impactLabel: 'ترتيب البراندات مضلّل', conf: 'high',
      evidence: g,
    }));
  }

  // ── 25) إشارات من سجل D1 (تكلفة صفر على شوبيفاي) ─────────────────
  const ops = ctx.ops;
  if (ops && !ops.unavailable) {
    if (ops.syncMismatch > 0) {
      I.push(mkInsight({
        id: 'ops_sync_mismatch', sev: 'watch', domain: 'المزامنة', tab: 'ops',
        title: `${ops.syncMismatch} حالة SKU مش متطابق بين شوبيفاي و StyleBox`,
        why: `كل حالة معناها إن المخزون أو السعر على StyleBox ما اتحدّثش. ` +
             `يعني إما بنبيع حاجة مش موجودة، أو بسعر قديم.`,
        action: `افتح سجل wp_stock_sync / stylebox_price_sync وصحّح الـ SKU المتكررة — ` +
                `عادةً مسافة زيادة أو اختلاف في اسم اللون.`,
        impact: 0, impactLabel: 'مخاطرة بيع بمخزون/سعر غلط', conf: 'high',
        evidence: (ops.mismatchSkus || []).slice(0, 5),
      }));
    }
    if (ops.duplicatesFound > 0) {
      I.push(mkInsight({
        id: 'ops_duplicates', sev: 'watch', domain: 'التشغيل', tab: 'ops',
        title: `${ops.duplicatesFound} أوردر اتحدد كتكرار محتمل`,
        why: `الأوردر المكرر لو اتشحن مرتين بيتحوّل لمرتجع مؤكد + تكلفة شحن مضاعفة. ` +
             `ولو اتلغى واحد منهم، بيدخل في نسبة الإلغاء ويشوّهها.`,
        action: `تأكد إن فريق التأكيد بيراجع تنبيه التكرار قبل الشحن مش بعده.`,
        impact: ops.duplicatesFound * avgOrderNet * 0.5, conf: 'med',
        evidence: [`في الفترة من ${ctx.range.from} إلى ${ctx.range.to}`],
      }));
    }
    if (ops.auditAdjustments > 0 && Math.abs(ops.auditNetDelta) > 0) {
      I.push(mkInsight({
        id: 'ops_audit', sev: 'info', domain: 'المخزون', tab: 'ops',
        title: `الجرد صحّح ${ops.auditAdjustments} مقاس بفارق صافي ${ops.auditNetDelta} قطعة`,
        why: `فروق الجرد هي الفرق بين المخزون الدفتري والحقيقي. الفرق السالب معناه ` +
             `قطع اختفت (بيع مش مسجّل أو فقد)، والموجب معناه استلام مش مسجّل.`,
        action: `لو الفرق بيتكرر في نفس الموديلات، المشكلة في خطوة معيّنة (تغليف/استلام) مش عشوائية.`,
        impact: 0, impactLabel: 'دقة المخزون', conf: 'high',
        evidence: [`عدد عمليات الجرد: ${ops.auditChecks}`],
      }));
    }
  }

  // ── 26) قص في الكتالوج / SKU مكرر — بيخلي أرقام المخزون ناقصة بصمت ──
  const cTrunc = cur.dataQuality.catalogVariantsTruncated || [];
  if (cTrunc.length) {
    I.push(mkInsight({
      id: 'dq_catalog_trunc', sev: 'watch', domain: 'جودة البيانات', tab: 'stock',
      title: `${cTrunc.length} منتج فيه مقاسات أكتر من الحد المجلوب`,
      why: `المنتجات دي مقاساتها ما جتش كاملة من شوبيفاي، فقيمة مخزونها وتحليل ` +
           `مقاساتها **ناقصين** — من غير أي رسالة خطأ. ده بالظبط نوع النقص اللي ` +
           `الأداة مصمّمة تقوله بدل ما تبلعه.`,
      action: `لو المنتجات دي مهمة، قسّمها لمنتجات أصغر أو بلّغ عشان نرفع الحد في الكتالوج.`,
      impact: 0, impactLabel: 'أرقام مخزون ناقصة', conf: 'high',
      evidence: cTrunc.slice(0, 5),
    }));
  }
  const dupSk = cur.dataQuality.duplicateSkus || [];
  if (dupSk.length) {
    I.push(mkInsight({
      id: 'dq_dup_sku', sev: 'watch', domain: 'جودة البيانات', tab: 'stock',
      title: `${dupSk.length} كود SKU متكرر على أكتر من مقاس نشط`,
      why: `الأداة بتربط المبيعات بالتكلفة عن طريق الـ SKU. لما نفس الكود يبقى على ` +
           `أكتر من فاريانت، التكلفة بتتاخد من واحد عشوائي منهم، والمبيعات بتتحسب ` +
           `للاتنين — فالسرعة والتغطية وإعادة الطلب كلهم غلط في الاتجاهين.`,
      action: `وحّد أو غيّر الأكواد المكررة من شوبيفاي. الكود لازم يكون فريد لكل مقاس.`,
      impact: 0, impactLabel: 'ربط التكلفة بالمبيعات غير موثوق', conf: 'high',
      evidence: dupSk.slice(0, 8),
    }));
  }

  // ── الترتيب: الأثر بالجنيه × وزن الخطورة ─────────────────────────
  I.sort((a, b) => (b.impact * SEV_WEIGHT[b.sev]) - (a.impact * SEV_WEIGHT[a.sev]));
  return I;
}

// ══════════════════════════════════════════════════════
// §CACHE — KV فقط، أبداً D1 (dashboard-builder Rule 2)
// ══════════════════════════════════════════════════════
const NS = `scc:${TOOL_NAME}:${CACHE_VERSION}`;
const dataKey    = (f, t) => `${NS}:data:${f}:${t}`;
const prevKey    = (f, t) => `${NS}:prev:${f}:${t}`;
const metaKey    = (f, t) => `${NS}:meta:${f}:${t}`;
const opsKey     = (f, t) => `${NS}:ops:${f}:${t}`;
const catalogKey = ()     => `${NS}:catalog`;

// نطاق مغلق (dateTo قبل النهارده بتوقيت القاهرة) = دائم · مفتوح = 15 دقيقة
function cacheTtlFor(dateTo) {
  return dateTo < cairoTodayStr() ? null : OPEN_RANGE_TTL;
}

async function readCache(env, key) {
  const raw = await env.DASH_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeCache(env, key, ttl, payload) {
  const lastUpdated = new Date().toISOString();
  const body = JSON.stringify({ ...payload, lastUpdated });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_CACHE_BYTES) {
    throw fail('cache_write',
      'حجم بيانات الفترة أكبر من حد الكاش — قصّر الفترة وحاول تاني',
      `payload ${bytes} bytes > ${MAX_CACHE_BYTES} for key ${key}`);
  }
  await env.DASH_KV.put(key, body, ttl ? { expirationTtl: ttl } : {});
  return lastUpdated;
}

// §CACHE::getCatalog — الكتالوج مستقل عن أي نطاق تاريخ، TTL 6 ساعات
async function getCatalog(env, token, forceRefresh = false) {
  const key = catalogKey();
  if (!forceRefresh) {
    const cached = await readCache(env, key);
    if (cached) return { ...cached, source: 'kv' };
  }
  const { products, warnings } = await fetchCatalog(env, token);
  const idx = buildCatalogIndex(products, warnings);
  await writeCache(env, key, CATALOG_TTL, idx);
  return { ...idx, source: 'shopify' };
}

// ══════════════════════════════════════════════════════
// §SHARED — Auth & Logging — EcomModa D1 Pattern v1.3.0
// نسخة حرفية من ecommoda-worker-builder/references/shared-functions.md — ممنوع تتعدّل
// ══════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();
  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username).run().catch(() => {});
  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');
  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp ?? new Date().toISOString(),
    entry.tool, entry.type, entry.employee ?? null,
    entry.orderId ?? null, entry.orderName ?? null,
    entry.sku ?? null, entry.productTitle ?? null,
    entry.delta ?? null, entry.valueBefore ?? null, entry.valueAfter ?? null,
    entry.notes ?? null, entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

// ⚠️ الفلاتر هنا **متعدّدة القيم** عن قصد — معيار الجداول الموحّد بيقول إن كل فلتر
// multi-select. الفلترة بتحصل في SQL (مش في المتصفح) لأن الجدول مقسّم صفحات على
// السيرفر: لو فلترنا الصفحة الحالية بس، عدّاد النتائج والتصدير هيكدبوا على المدير.
// كل قيمة بتتربط كـ placeholder منفصل — مفيش أي نص جاي من المستخدم بيتحط في SQL.
const LOG_SORTABLE = { timestamp: 'timestamp', tool: 'tool', type: 'type', employee: 'employee', order_name: 'order_name', sku: 'sku' };
const LOG_MAX_FILTER_VALUES = 60;

function logListParam(v) {
  if (v == null) return null;
  const arr = (Array.isArray(v) ? v : String(v).split(','))
    .map(x => String(x).trim()).filter(x => x && x !== 'all');
  return arr.length ? arr.slice(0, LOG_MAX_FILTER_VALUES) : null;
}

function logWhere({ tool = null, employee = null, type = null, search = null } = {}) {
  let sql = "SELECT __COLS__ FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  const inClause = (col, vals) => {
    if (!vals || !vals.length) return;
    sql += ` AND ${col} IN (${vals.map(() => '?').join(',')})`;
    b.push(...vals);
  };
  inClause('tool', logListParam(tool));
  inClause('employee', logListParam(employee));
  inClause('type', logListParam(type));
  if (search) { sql += ' AND (order_name LIKE ? OR notes LIKE ? OR sku LIKE ?)'; b.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  return { sql, b };
}

// ⚠️ الترتيب من whitelist بس. الاسم اللي جاي من المستخدم مبيدخلش الـ SQL أبدًا —
// بندوّر عليه في LOG_SORTABLE وبناخد **القيمة** المكتوبة عندنا، مش المدخل.
function logOrderBy(sort, dir) {
  const col = LOG_SORTABLE[sort] || 'timestamp';
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // ثانوي بالتاريخ عشان الصفحات تبقى ثابتة لما يكون العمود فيه قيم مكرّرة كتير
  return col === 'timestamp' ? ` ORDER BY timestamp ${d}` : ` ORDER BY ${col} ${d}, timestamp DESC`;
}

async function getLogs(db, { tool = null, employee = null, type = null, search = null, sort = 'timestamp', dir = 'desc', limit = 100, offset = 0 } = {}) {
  const { sql, b } = logWhere({ tool, employee, type, search });
  const q = sql.replace('__COLS__', '*') + logOrderBy(sort, dir) + ' LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 100), offset);
  return (await db.prepare(q).bind(...b).all()).results;
}

async function getLogsCount(db, { tool = null, employee = null, type = null, search = null } = {}) {
  const { sql, b } = logWhere({ tool, employee, type, search });
  const row = await db.prepare(sql.replace('__COLS__', 'COUNT(*) as total')).bind(...b).first();
  return row?.total ?? 0;
}

async function getLogsExport(db, { tool = null, employee = null, type = null, search = null, sort = 'timestamp', dir = 'desc' } = {}) {
  const { sql, b } = logWhere({ tool, employee, type, search });
  const q = sql.replace('__COLS__', '*') + logOrderBy(sort, dir) + ' LIMIT 2000';
  return (await db.prepare(q).bind(...b).all()).results;
}

// ══════════════════════════════════════════════════════
// §OPS — تحليلات من سجل D1 — تكلفة صفر على شوبيفاي
//
// ⚠️ فخ محسوم: العمود timestamp فيه صيغتين مختلفتين —
//    metafields_change  →  "2026-08-23 - 23:53:32"  (توقيت القاهرة، صيغة مخصّصة)
//    كل الباقي          →  "2026-08-23T13:21:08.905Z" (ISO، UTC)
// عشان كده كل فلاتر التاريخ هنا بتستخدم substr(timestamp,1,10) — ده الشيء الوحيد
// اللي بيشتغل صح مع الصيغتين. النتيجة: أرقام metafields_change ممكن تفرق ±٣ ساعات
// على حدود اليوم، والواجهة بتقول كده صراحةً.
// ══════════════════════════════════════════════════════
async function buildOps(db, from, to) {
  const q = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results || [];
  const one = async (sql, ...b) => await db.prepare(sql).bind(...b).first();

  // ⚠️ العمود فيه صيغتين: metafields_change بيكتب توقيت **القاهرة** بصيغة مخصّصة
  // ("2026-08-23 - 23:53:32")، وكل الباقي بيكتب ISO **UTC**. الفلترة هنا بتوقيت
  // القاهرة (زي فلتر الأوردرات)، فلازم الـ ISO يتزحلق +٣ ساعات — من غير كده كل
  // نشاط من ١٢ لـ ٣ الفجر بيتحسب على اليوم اللي فات في كل أرقام التحصيل والجرد.
  // COALESCE بيغطّي الصيغة المخصّصة (datetime بترجع NULL عليها) بالقيمة الخام،
  // وهي أصلاً بتوقيت القاهرة فما بتحتاجش زحلقة.
  const D = "COALESCE(substr(datetime(substr(timestamp,1,19),'+3 hours'),1,10), substr(timestamp,1,10))";

  const [packing, statusChanges, cash, audit, mismatch, dupes, printing, bosta] = await Promise.all([
    q(`SELECT employee, COUNT(*) n, SUM(COALESCE(item_count,0)) items, ${D} d
        FROM logs WHERE tool IN ('pack_checker','pack_verification') AND type='packed' AND ${D} BETWEEN ? AND ?
        GROUP BY employee, d ORDER BY d`, from, to),
    q(`SELECT employee, value_after AS newStatus, COUNT(*) n
        FROM logs WHERE tool='order_status' AND type='update' AND ${D} BETWEEN ? AND ?
        GROUP BY employee, value_after ORDER BY n DESC LIMIT 200`, from, to),
    q(`SELECT type, COUNT(*) n, SUM(COALESCE(value_after,0)) total, ${D} d
        FROM logs WHERE tool IN ('cod_payment','cod_preregister','treasury')
        AND type IN ('payment','refund','extra_shipping','preregister','deposit')
        AND ${D} BETWEEN ? AND ? GROUP BY type, d ORDER BY d`, from, to),
    q(`SELECT employee, type, COUNT(*) n, SUM(COALESCE(delta,0)) netDelta
        FROM logs WHERE tool='inventory_audit' AND type IN ('adjustment','ok')
        AND ${D} BETWEEN ? AND ? GROUP BY employee, type`, from, to),
    q(`SELECT tool, sku, COUNT(*) n FROM logs
        WHERE tool IN ('wp_stock_sync','stylebox_price_sync') AND type='sku_mismatch' AND ${D} BETWEEN ? AND ?
        GROUP BY tool, sku ORDER BY n DESC LIMIT 50`, from, to),
    one(`SELECT COUNT(*) n FROM logs WHERE tool='duplicate_order_check'
          AND type='duplicate_found' AND ${D} BETWEEN ? AND ?`, from, to),
    q(`SELECT type, COUNT(*) n FROM logs WHERE tool='order_printer'
        AND ${D} BETWEEN ? AND ? GROUP BY type`, from, to),
    q(`SELECT tool, type, COUNT(*) n FROM logs WHERE tool IN ('bosta_tracker','bosta_return')
        AND type IN ('tagged','returned') AND ${D} BETWEEN ? AND ? GROUP BY tool, type`, from, to),
  ]);

  const packByEmployee = {};
  for (const r of packing) {
    const e = packByEmployee[r.employee || '—'] || (packByEmployee[r.employee || '—'] = { employee: r.employee || '—', orders: 0, items: 0, days: new Set() });
    e.orders += r.n; e.items += r.items || 0; e.days.add(r.d);
  }
  const packers = Object.values(packByEmployee).map(e => ({
    employee: e.employee, orders: e.orders, items: e.items, activeDays: e.days.size,
    ordersPerDay: round2(safeDiv(e.orders, e.days.size)),
  })).sort((a, b) => b.orders - a.orders);

  const cashByType = {};
  for (const r of cash) {
    const e = cashByType[r.type] || (cashByType[r.type] = { type: r.type, n: 0, total: 0 });
    e.n += r.n; e.total += num(r.total);
  }
  // «فحص» ≠ «تصحيح»: النوع ok معناه الجرد طلع مظبوط، وadjustment معناه اتصحّح.
  // دمجهم كان بيخلي الرؤية تقول «الجرد صحّح N مقاس» وN فيها الفحوصات السليمة كمان.
  const auditChecksN      = audit.reduce((s, r) => s + r.n, 0);
  const auditAdjustmentsN = audit.filter(r => r.type === 'adjustment').reduce((s, r) => s + r.n, 0);
  const auditNetDelta     = audit.filter(r => r.type === 'adjustment').reduce((s, r) => s + int(r.netDelta), 0);

  return {
    unavailable: false,
    packers,
    packingByDay: packing.map(r => ({ d: r.d, employee: r.employee || '—', n: r.n, items: r.items || 0 })),
    statusChanges,
    cash: Object.values(cashByType),
    cashByDay: cash.map(r => ({ d: r.d, type: r.type, n: r.n, total: round2(num(r.total)) })),
    audit, auditChecks: auditChecksN, auditAdjustments: auditAdjustmentsN, auditNetDelta,
    syncMismatch: mismatch.reduce((s, r) => s + r.n, 0),
    mismatchSkus: mismatch.slice(0, 20).map(r => `${r.sku} (${r.tool}) ×${r.n}`),
    duplicatesFound: dupes?.n || 0,
    printing, bosta,
    note: 'كل التواريخ محوّلة لتوقيت القاهرة (UTC+3) قبل الفلترة — نفس أساس فلتر الأوردرات',
  };
}

// ══════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsPreflight();

    // ⚠️ الفحص ده **قبل** أي مقارنة: لو السر اتضاف في الداشبورد وما اتعملّوش
    // Promote (أشهر عطل في الستاك)، `env.WORKER_SECRET` بتبقى undefined والمقارنة
    // بتبقى مع النص الحرفي "Bearer undefined" — يعني أي حد يبعت الهيدر ده ياخد
    // كل البيانات. الفشل الصريح أأمن ألف مرة من الباب المفتوح.
    if (!env.WORKER_SECRET) {
      return json({ error: 'WORKER_SECRET غير مضبوط على الـ Worker — أضفه من الإعدادات ثم اعمل Promote', step: 'env' }, 500);
    }
    // WORKER_SECRET على كل الطلبات — تسجيل دخول الموظف طبقة **فوق** ده مش بديل عنه
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader !== `Bearer ${env.WORKER_SECRET}`) {
      return json({ error: 'غير مصرح — WORKER_SECRET غلط أو ناقص' }, 401);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      // ─── §AUTH ─────────────────────────────────────────────
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400);
        return json({ ok: true, ...(await checkEmployee(env.DB, username)) });
      }
      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400);
        await registerPin(env.DB, username, pin);
        return json({ ok: true });
      }
      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400);
        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401);
        // ⚠️ فشل السجل مايمنعش الدخول — بس بيتقال صراحةً بدل ما يتبلع (Step 5A ⑦)
        let logged = true, logError = null;
        try { await writeLog(env.DB, { tool: TOOL_NAME, type: 'login', employee: username, notes: `دخول: ${displayName}` }); }
        catch (e) { logged = false; logError = e.message.slice(0, 160); }
        return json({ ok: true, displayName, logged, logError });
      }
      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        if (username) {
          await writeLog(env.DB, { tool: TOOL_NAME, type: 'logout', employee: username, notes: `خروج: ${username.replace(/_/g, ' ')}` });
        }
        return json({ ok: true });
      }
      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results });
      }

      // ─── §CONFIG ───────────────────────────────────────────
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME, cacheVersion: CACHE_VERSION });
      }

      if (action === 'diag') {
        // فحص ذاتي — **بدون أي كتابة وبدون عرض قيمة أي سر** (أسماء وأطوال بس)
        const checks = [];
        const envKeys = Object.keys(env).sort();
        for (const kk of ['WORKER_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'SHOP_DOMAIN']) {
          const v = env[kk];
          checks.push({ name: kk, ok: !!v, detail: v ? `موجود · الطول ${String(v).length}` : 'ناقص' });
        }
        checks.push({ name: 'DASH_KV binding', ok: !!env.DASH_KV, detail: env.DASH_KV ? 'مربوط' : 'مش مربوط' });
        checks.push({ name: 'DB binding (D1)', ok: !!env.DB, detail: env.DB ? 'مربوط' : 'مش مربوط' });
        let shopifyOk = false, shopifyDetail = '';
        try {
          const t = await getAccessToken(env);
          const r = await shopifyGQL(env, t, '{ shop { name currencyCode } }');
          shopifyOk = !!r?.data?.shop;
          shopifyDetail = shopifyOk ? `${r.data.shop.name} · ${r.data.shop.currencyCode}` : JSON.stringify(r).slice(0, 120);
        } catch (e) { shopifyDetail = e.message.slice(0, 160); }
        checks.push({ name: 'Shopify OAuth + GraphQL', ok: shopifyOk, detail: shopifyDetail });
        let d1Ok = false, d1Detail = '';
        try { const r = await env.DB.prepare('SELECT COUNT(*) n FROM logs').first(); d1Ok = true; d1Detail = `${r.n} سجل`; }
        catch (e) { d1Detail = e.message.slice(0, 160); }
        checks.push({ name: 'D1 query', ok: d1Ok, detail: d1Detail });
        const cat = await readCache(env, catalogKey()).catch(() => null);
        checks.push({ name: 'كاش الكتالوج', ok: !!cat, detail: cat ? `${cat.variants?.length || 0} فاريانت · ${cat.builtAt}` : 'فاضي (هيتجاب عند أول طلب)' });
        return json({ ok: checks.every(c => c.ok), version: WORKER_VERSION, envKeys, checks });
      }

      // ─── §DATA ─────────────────────────────────────────────
      if (action === 'get_data') {
        let body = {};
        if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
        const dateFrom = body.dateFrom || url.searchParams.get('dateFrom');
        const dateTo   = body.dateTo   || url.searchParams.get('dateTo');
        const forceRefresh = body.forceRefresh === true;
        const withPrev = body.withPrev !== false;
        const settings = {
          leadTimeDays:   int(body.leadTimeDays) || 21,
          marginFloorPct: body.marginFloorPct != null ? num(body.marginFloorPct) : 20,
        };
        const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateFrom || !dateTo) return json({ error: 'محتاج dateFrom و dateTo', step: 'validation' }, 400);
        // ⚠️ من غير الفحص ده، '2026-8-1' بتعدّي وبتخلي daysBetweenStr ترجّع NaN،
        // وبعدين addDaysStr بترمي RangeError فالرد بيبقى 500 بخطوة 'unknown'.
        if (!ISO_DAY.test(dateFrom) || !ISO_DAY.test(dateTo)) {
          return json({ error: 'صيغة التاريخ لازم تكون YYYY-MM-DD', step: 'validation' }, 400);
        }
        if (dateFrom > dateTo)    return json({ error: 'تاريخ البداية بعد تاريخ النهاية', step: 'validation' }, 400);

        const key = dataKey(dateFrom, dateTo);
        if (!forceRefresh) {
          const cached = await readCache(env, key);
          // الإعدادات بتدخل في الحساب — كاش بإعدادات مختلفة مايتقراش
          if (cached && cached.settingsSig === JSON.stringify(settings)) {
            return json({ ...cached, source: 'kv' });
          }
        }

        const token = await getAccessToken(env);
        const catalog = await getCatalog(env, token, forceRefresh && body.refreshCatalog === true);

        const runRange = async (from, to) => {
          const s1 = await fetchStage1(env, token, from, to);
          const candIds = s1.filter(isCandidateForStage2).map(o => o.id);
          const s2 = candIds.length ? await fetchStage2(env, token, candIds) : new Map();
          return { orders: s1, stage2Map: s2, candidates: candIds.length };
        };

        const curRaw = await runRange(dateFrom, dateTo);
        let cur;
        try {
          cur = buildAnalytics(curRaw.orders, curRaw.stage2Map, catalog, { from: dateFrom, to: dateTo }, settings);
        } catch (e) { throw fail('aggregate', 'فشل تجميع بيانات الفترة', e.message); }

        // ── الفترة السابقة: كاش مستقل ومقصود ─────────────────────────
        // من غير الكاش ده، كل ضغطة «تحديث» كانت بتجيب **فترتين** من شوبيفاي —
        // يعني ضعف التكلفة والوقت في كل مرة، مع إن الفترة السابقة **مقفولة**
        // ومستحيل تتغيّر. وبنكاش نسخة **مصغّرة** بس (مؤشرات + سلسلة + ملخّصات)
        // لأن صفوف الفترة السابقة مالهاش أي استخدام في الواجهة.
        let prev = null;
        const prevRange = previousRange(dateFrom, dateTo);
        if (withPrev) {
          const pk = prevKey(prevRange.from, prevRange.to);
          const cachedPrev = body.refreshPrev === true ? null : await readCache(env, pk);
          if (cachedPrev && cachedPrev.settingsSig === JSON.stringify(settings)) {
            prev = cachedPrev;
          } else {
            const prevRaw = await runRange(prevRange.from, prevRange.to);
            const pa = buildAnalytics(prevRaw.orders, prevRaw.stage2Map, catalog, prevRange, settings);
            prev = {
              kpi: pa.kpi, boxes: pa.boxes, orderBoxes: pa.orderBoxes, series: pa.series,
              geo: pa.geo, couriers: pa.couriers, settingsSig: JSON.stringify(settings),
            };
            await writeCache(env, pk, cacheTtlFor(prevRange.to), prev);
          }
        }

        // سجل D1 رخيص لكنه ٨ استعلامات في كل نداء — الكاش هنا بيخلي التبديل بين
        // التابات والـ refresh السريع مجانيين. نفس قاعدة النطاق المقفول/المفتوح.
        let ops = { unavailable: true };
        const ok_ = opsKey(dateFrom, dateTo);
        try {
          const cachedOps = forceRefresh ? null : await readCache(env, ok_);
          if (cachedOps) ops = cachedOps;
          else {
            ops = await buildOps(env.DB, dateFrom, dateTo);
            await writeCache(env, ok_, cacheTtlFor(dateTo), ops);
          }
        } catch (e) { ops = { unavailable: true, error: e.message.slice(0, 200) }; }

        let insights = [];
        try {
          insights = buildInsights(cur, prev, {
            range: { from: dateFrom, to: dateTo }, prevRange, ops,
            leadTimeDays: settings.leadTimeDays, marginFloorPct: settings.marginFloorPct,
          });
        } catch (e) {
          // ⚠️ فشل محرك الرؤى **مايضيّعش** الأرقام. الرؤى طبقة فوق البيانات مش
          // شرط لعرضها — والداشبورد من غير رؤى أنفع بكتير من شاشة خطأ.
          insights = [{ id: 'insights_failed', sev: 'watch', domain: 'النظام', title: 'محرك الرؤى وقع — الأرقام سليمة',
            why: 'حصل خطأ أثناء توليد التوصيات: ' + e.message.slice(0, 160),
            action: 'بلّغ عشان يتصلّح. كل الأرقام والجداول في التابات شغّالة عادي.',
            impact: 0, impactLabel: 'الرؤى غير متاحة', evidence: [], conf: 'high', tab: null }];
        }

        // البيانات المرجعة: الملخّصات كاملة + الصفوف للـ drill-down.
        // الفترة السابقة بترجع **مؤشراتها فقط** — صفوفها مالهاش أي استخدام في الواجهة
        // وبتضاعف حجم الرد بلا داعي.
        // ⚠️ صفوف الـ drill-down بتتشال على الفترات الطويلة — **بإعلان صريح** مش بصمت.
        // السبب: 90 يوم ≈ 10,000 أوردر ≈ 15MB، وده بيقرّب من حد KV (25MB) وبيتقل
        // على المتصفح. التجميعات كلها بترجع كاملة على أي فترة — اللي بيتشال هو
        // الجدول التفصيلي بس، والواجهة بتقول كده بدل ما تعرض جدول ناقص.
        const rangeDays = daysBetweenStr(dateFrom, dateTo);
        const includeRows = body.includeRows === true || rangeDays <= ROWS_MAX_DAYS;

        const payload = {
          range: { from: dateFrom, to: dateTo, days: rangeDays, prev: prevRange },
          settings, settingsSig: JSON.stringify(settings),
          rowsIncluded: includeRows,
          rowsOmittedReason: includeRows ? null
            : `الفترة ${rangeDays} يوم — جدول التفاصيل بيتحمّل على الفترات حتى ${ROWS_MAX_DAYS} يوم. كل الملخّصات والرسوم كاملة.`,
          boxes: cur.boxes, rows: includeRows ? cur.rows : [], warnings: cur.warnings,
          orderBoxes: cur.orderBoxes, orderRows: includeRows ? cur.orderRows : [], orderWarnings: cur.orderWarnings,
          kpi: cur.kpi, prevKpi: prev?.kpi || null,
          prevBoxes: prev?.boxes || null, prevOrderBoxes: prev?.orderBoxes || null,
          series: cur.series, seriesTruncated: cur.seriesTruncated, prevSeries: prev?.series || null,
          geo: cur.geo, couriers: cur.couriers, zones: cur.zones, channels: cur.channels,
          packers: cur.packers, byDow: cur.byDow,
          products: cur.products, styles: cur.styles, options: cur.options,
          vendors: cur.vendors, types: cur.types, collections: cur.collections,
          sizeCurve: cur.sizeCurve, coreSizes: cur.coreSizes,
          reasons: cur.reasons, aging: cur.aging, customers: cur.customers,
          inventory: cur.inventory, dataQuality: cur.dataQuality,
          insights, ops,
          catalogMeta: {
            builtAt: catalog.builtAt, source: catalog.source,
            variants: catalog.variants.length, products: catalog.productCount,
            vendors: catalog.vendors.length,
          },
          counts: {
            ordersScanned: curRaw.orders.length, candidatesFetched: curRaw.candidates,
            prevOrdersScanned: prev ? prev.orderBoxes.totalOrders : null,
          },
        };

        const ttl = cacheTtlFor(dateTo);
        const lastUpdated = await writeCache(env, key, ttl, payload);
        await writeCache(env, metaKey(dateFrom, dateTo), ttl, {
          ordersScanned: curRaw.orders.length, netSales: cur.kpi.netSales,
        });

        // ✅ رجّع اللي اتجاب دلوقتي — أبداً re-read من KV بعد الكتابة (اتساق 60 ثانية)
        return json({ ...payload, lastUpdated, source: 'shopify' });
      }

      if (action === 'get_meta') {
        const dateFrom = url.searchParams.get('dateFrom');
        const dateTo   = url.searchParams.get('dateTo');
        if (!dateFrom || !dateTo) return json({ error: 'محتاج dateFrom و dateTo', step: 'validation' }, 400);
        const cached = await readCache(env, metaKey(dateFrom, dateTo));
        return json(cached || { ordersScanned: null, lastUpdated: null });
      }

      if (action === 'get_catalog') {
        const token = await getAccessToken(env);
        const forceRefresh = url.searchParams.get('forceRefresh') === 'true';
        const cat = await getCatalog(env, token, forceRefresh);
        return json({ ok: true, builtAt: cat.builtAt, source: cat.source,
                      productCount: cat.productCount, variants: cat.variants, vendors: cat.vendors,
                      warnings: cat.warnings });
      }

      if (action === 'get_ops') {
        const dateFrom = url.searchParams.get('dateFrom');
        const dateTo   = url.searchParams.get('dateTo');
        if (!dateFrom || !dateTo) return json({ error: 'محتاج dateFrom و dateTo', step: 'validation' }, 400);
        return json({ ok: true, ...(await buildOps(env.DB, dateFrom, dateTo)) });
      }

      if (action === 'clear_cache') {
        const dateFrom = url.searchParams.get('dateFrom');
        const dateTo   = url.searchParams.get('dateTo');
        const what     = url.searchParams.get('what') || '';
        if (what === 'catalog') {
          await env.DASH_KV.delete(catalogKey());
          return json({ cleared: 'catalog' });
        }
        if (dateFrom && dateTo) {
          await env.DASH_KV.delete(dataKey(dateFrom, dateTo));
          await env.DASH_KV.delete(metaKey(dateFrom, dateTo));
          await env.DASH_KV.delete(opsKey(dateFrom, dateTo));
          await env.DASH_KV.delete(prevKey(dateFrom, dateTo));
          const pr = previousRange(dateFrom, dateTo);
          await env.DASH_KV.delete(prevKey(pr.from, pr.to));
          return json({ cleared: `${dateFrom}:${dateTo}` });
        }
        // ⚠️ list() بيرجّع 1000 مفتاح كحد أقصى وبيرجّع cursor. من غير الحلقة دي،
        // «مسح الكل» بيسيب مفاتيح النطاقات المقفولة (اللي فيها التكلفة المتجمّدة —
        // وهي بالظبط سبب المسح) وبيقول «تم مسح الكل».
        let cursor = null, count = 0;
        for (;;) {
          const list = await env.DASH_KV.list({ prefix: `${NS}:`, cursor: cursor || undefined });
          for (const kk of list.keys) { await env.DASH_KV.delete(kk.name); count++; }
          if (list.list_complete || !list.cursor) break;
          cursor = list.cursor;
        }
        return json({ cleared: 'all', count });
      }

      // ─── §LOG-ENDPOINTS ────────────────────────────────────
      // ⚠️ انحراف مقصود عن القاعدة العامة (السجل = سجل الأداة نفسها):
      // الأداة دي **قراءة فقط**، فسجلها الخاص فيه دخول/خروج بس — واللي بيتستبعد
      // server-side أصلاً، يعني التاب كان هيبقى فاضي للأبد. وبما إنها شاشة المدير،
      // القيمة الحقيقية إنه يشوف سجل **كل الأدوات**. الافتراضي `all` مع فلتر أداة،
      // و`tool=store_command_center` بيرجّع سلوك القاعدة العامة.
      const logQ = () => ({
        tool:     url.searchParams.get('tool'),
        employee: url.searchParams.get('employee'),
        type:     url.searchParams.get('type'),
        search:   url.searchParams.get('search') || null,
        sort:     url.searchParams.get('sort') || 'timestamp',
        dir:      url.searchParams.get('dir')  || 'desc',
      });
      if (action === 'get_logs') {
        const limit   = Math.min(parseInt(url.searchParams.get('limit')  || '100', 10), 100);
        const offset  = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
        const entries = await getLogs(env.DB, { ...logQ(), limit, offset });
        return json({ ok: true, entries });
      }
      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logQ());
        return json({ ok: true, total });
      }
      if (action === 'get_logs_export') {
        const entries = await getLogsExport(env.DB, logQ());
        return json({ ok: true, entries });
      }
      if (action === 'get_log_tools') {
        const [tools, emp, types] = await Promise.all([
          env.DB.prepare("SELECT tool, COUNT(*) n FROM logs WHERE type NOT IN ('login','logout') GROUP BY tool ORDER BY n DESC").all(),
          env.DB.prepare("SELECT employee, COUNT(*) n FROM logs WHERE employee IS NOT NULL AND type NOT IN ('login','logout') GROUP BY employee ORDER BY n DESC").all(),
          env.DB.prepare("SELECT type, COUNT(*) n FROM logs WHERE type NOT IN ('login','logout') GROUP BY type ORDER BY n DESC").all(),
        ]);
        return json({
          ok: true,
          tools: tools.results || [],
          employees: (emp.results || []).map(r => ({ employee: r.employee, n: r.n })),
          types: types.results || [],
        });
      }

      return json({ error: `Unknown action: ${action}` }, 400);
    } catch (e) {
      return json({ error: e.message, step: e.step || 'unknown', technical: e.technical || null }, 500);
    }
  },
};

// ══════════════════════════════════════════════════════
// §EXPORTS — للاختبار المحلي فقط (test/harness.mjs).
// وجودها مالوش أي أثر على الـ Worker — Cloudflare بيستخدم الـ default export بس.
// ══════════════════════════════════════════════════════
export {
  buildAnalytics, buildInsights, buildInventory, buildCatalogIndex,
  computeBoxes, computeOrderBoxes, classifyOrderForCounts, isCancelledOrRTO,
  isCandidateForStage2, normalBucket, stageFromS2, normGov, parseSku,
  logListParam, logOrderBy, logWhere,
  wilson, twoPropZ, robustZ, median, mad, cusumChangePoint, ciDisjoint,
  cairoDay, previousRange, daysBetweenStr, addDaysStr, findVendorDupes,
  BUCKET, ORDER_BUCKET, S1, TOOL_NAME, WORKER_VERSION, CACHE_VERSION,
};
