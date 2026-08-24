// ══════════════════════════════════════════════════════════════════
// اختبار متصفح حقيقي — بيحمّل index.html في Chromium، بيعترض نداءات الـ Worker
// ويرجّع حمولة مبنية من بيانات المتجر الفعلية، وبعدين بيدخل ويمشي على كل تاب.
// الهدف: إمساك أي خطأ JS أو رسم أو جدول **قبل** النشر.
//   node test/browser-test.mjs [--shots]
// ══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'test', 'shots');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'payload.json'), 'utf8'));
const WORKER = 'https://mock-worker.test/';

let PASS = 0, FAIL = 0;
const check = (name, cond, detail = '') => {
  if (cond) { PASS++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

const browser = await chromium.launch({ executablePath: process.env.SCC_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();

let LAST_LOG_Q = {};
const pageErrors = [], consoleErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// ─── mock الـ Worker ───
await page.route('**/mock-worker.test/**', async route => {
  const url = new URL(route.request().url());
  const action = url.searchParams.get('action');
  const body = j => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
  if (action === 'get_employees')  return body({ ok: true, employees: [{ username: 'Ahmed_Ibraheem', display_name: 'Ahmed Ibraheem' }] });
  if (action === 'check_employee') return body({ ok: true, exists: true, hasPin: true, isActive: true });
  if (action === 'verify_employee')return body({ ok: true, displayName: 'Ahmed Ibraheem' });
  if (action === 'get_config')     return body({ ok: true, version: 'v1.0.0', tool: 'store_command_center' });
  if (action === 'get_data')       return body(payload);
  if (action === 'get_meta')       return body({ ordersScanned: 1516, lastUpdated: payload.lastUpdated });
  if (action === 'get_log_tools')  return body({ ok: true,
      tools: [{ tool: 'order_status', n: 120 }, { tool: 'pack_checker', n: 90 }, { tool: 'metafields_change', n: 40 }],
      employees: [{ employee: 'Ahmed_Ibraheem', n: 200 }, { employee: 'Abo_Selim', n: 60 }],
      types: [{ type: 'update', n: 210 }, { type: 'packed', n: 90 }] });
  if (action === 'get_logs') {
    // بيسجّل آخر استعلام وصله عشان الاختبار يتأكد إن الفلترة والترتيب راحوا للسيرفر
    LAST_LOG_Q = Object.fromEntries(url.searchParams);
    const all = [
      { id: 1, timestamp: '2026-08-22T09:14:00.000Z', tool: 'order_status', type: 'update', employee: 'Ahmed_Ibraheem',
        order_id: '7140362944834', order_name: '#51669', sku: null, value_before: 'Confirmed', value_after: 'Ready',
        notes: 'S1=Ready', extra: '{"courier":"Bosta","result":"success"}' },
      { id: 2, timestamp: '2026-08-22 - 11:02:11', tool: 'metafields_change', type: 'update', employee: null,
        order_id: '7140362944834', order_name: '#51669', notes: 'manual_status', extra: '{"newValue":"Shipped"}' },
    ];
    const tools = (url.searchParams.get('tool') || '').split(',').filter(Boolean);
    return body({ ok: true, entries: tools.length ? all.filter(e => tools.includes(e.tool)) : all });
  }
  if (action === 'get_logs_count') {
    const tools = (url.searchParams.get('tool') || '').split(',').filter(Boolean);
    return body({ ok: true, total: tools.length ? 1 : 2 });
  }
  if (action === 'get_logs_export')return body({ ok: true, entries: [] });
  if (action === 'diag')           return body({ ok: true, version: 'v1.0.0', envKeys: [], checks: [{ name: 'Shopify', ok: true, detail: 'EcomModa · EGP' }] });
  return body({ error: 'Unknown action: ' + action });
});


// الـ CDN محجوب في بيئة الاختبار — بنقدّم بدائل محلية بسيطة عشان نختبر **مسار
// الكود** بتاعنا (بناء الرسم والتصدير) من غير ما نحتاج المكتبة الحقيقية.
await page.route('**/cdnjs.cloudflare.com/**', route => {
  const u = route.request().url();
  if (u.includes('chart')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: `
    window.__charts = [];
    window.Chart = class Chart {
      constructor(el, cfg) { this.el = el; this.canvas = el; this.config = cfg; this.data = cfg.data;
        this.scales = { x: { getPixelForValue: () => 0 }, y: { getPixelForValue: () => 0 } };
        this.chartArea = { left: 0, right: 100, top: 0, bottom: 100 };
        this.ctx = el.getContext ? el.getContext('2d') : {};
        window.__charts.push(this); }
      destroy() {}
      getDatasetMeta() { return { data: [] }; }
    };` });
  if (u.includes('exceljs')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: `
    window.ExcelJS = { Workbook: class {
      constructor(){ this.xlsx = { writeBuffer: async () => new ArrayBuffer(8) }; }
      addWorksheet(){ const rows=[]; return { addRow(v){ rows.push(v); return { font:{}, eachCell(){}, }; },
        mergeCells(){}, getRow(){ return { font:{} }; }, columns: [], _rows: rows }; }
    } };` });
  return route.continue();
});

await page.addInitScript(([u]) => {
  localStorage.setItem('scc_worker_url', u);
  localStorage.setItem('scc_worker_secret', 'test-secret');
}, [WORKER]);

console.log('\n══ 1) التحميل وتسجيل الدخول ══');
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'networkidle' });
check('الصفحة اتحمّلت من غير أخطاء JS', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('شاشة الدخول ظاهرة', await page.locator('#loginOverlay:not(.hidden)').count() === 1);
check('زرار إعدادات جوّه كارت الدخول موجود', await page.locator('#loginSettingsBtn').count() === 1);
check('نسخة الأداة ظاهرة في شاشة الدخول', (await page.locator('#loginVersionText').textContent()) === 'v1.0.0');
check('منطقة الـ PIN مخفية قبل اختيار الموظف', !(await page.locator('#pinZone').evaluate(el => el.classList.contains('visible'))));

await page.selectOption('#loginEmployee', 'Ahmed_Ibraheem');
await page.waitForTimeout(300);
check('منطقة الـ PIN ظهرت بعد اختيار الموظف', await page.locator('#pinZone').evaluate(el => el.classList.contains('visible')));
for (const d of ['1', '2', '3', '4']) await page.click(`#keypad .key:has-text("${d}")`);
await page.waitForTimeout(1600);
check('الدخول نجح والشاشة اختفت', await page.locator('#loginOverlay.hidden').count() === 1);
check('لوحة المحتوى ظهرت', await page.locator('#appMain').isVisible());

console.log('\n══ 2) تاب القيادة ══');
await page.waitForSelector('#panel-cmd .kpi-card', { timeout: 12000 });
const kpiCount = await page.locator('#panel-cmd .kpi-grid.cols-4 > .kpi-card').count();
check('٨ كروت مؤشرات في تاب القيادة', kpiCount === 8, String(kpiCount));
const netTxt = await page.locator('#panel-cmd .kpi-card').first().locator('.kpi-value').textContent();
check('صافي المبيعات معروض برقم إنجليزي', /[0-9,]/.test(netTxt) && !/[٠-٩]/.test(netTxt), netTxt.trim());
const insCards = await page.locator('#panel-cmd .ins-card').count();
check('كروت الرؤى اترسمت', insCards > 0, insCards + ' كارت');
const firstImpact = await page.locator('#panel-cmd .ins-impact').first().textContent();
check('أول رؤية عليها أثر مالي', firstImpact.trim().length > 0, firstImpact.trim());
check('شجرة الأسباب اترسمت', await page.locator('#panel-cmd .tree-node').count() >= 12);
const freshTxt = await page.locator('.freshness-text').textContent();
check('مؤشر الطزاجة اشتغل', /تحديث|لحظية/.test(freshTxt), freshTxt.trim());
check('مؤشر الطزاجة وزرار التحديث في نفس الحاوية',
  await page.locator('#freshnessBar #refreshBtn').count() === 1);
const charts = await page.evaluate(() => Object.keys((typeof state !== 'undefined' ? state.charts : {}) || {}));
check('رسوم تاب القيادة اتبنت', charts.includes('chartCmdTrend') && charts.includes('chartCmdFate'), charts.join(', '));

if (SHOTS) { await page.screenshot({ path: path.join(OUT, 'cmd.png') }); await page.screenshot({ path: path.join(OUT, 'cmd-full.png'), fullPage: true }); }
console.log('\n══ 3) كل التابات بترسم من غير أخطاء ══');
const tabs = [['sales', 'المبيعات'], ['ops', 'الأوردرات'], ['products', 'المنتجات'],
              ['stock', 'المخزون'], ['geo', 'الجغرافيا'], ['customers', 'العملاء'], ['log', 'السجل']];
for (const [t, label] of tabs) {
  const before = pageErrors.length;
  await page.click('#tabBtn-' + t);
  await page.waitForTimeout(900);
  const html = await page.locator('#panel-' + t).innerHTML();
  check('تاب ' + label + ' اترسم', html.length > 800 && pageErrors.length === before,
    (html.length / 1024).toFixed(0) + ' KB' + (pageErrors.length > before ? ' · خطأ: ' + pageErrors[before] : ''));
  if (SHOTS) await page.screenshot({ path: path.join(OUT, t + '.png'), fullPage: false });
}

console.log('\n══ 4) الجدول الموحّد — الفلاتر والترتيب ══');
await page.click('#tabBtn-products');
await page.waitForTimeout(700);
check('أيقونة الفلتر رمادية عند التحميل (الحالة 1)',
  !(await page.locator('#fltIcon-products').evaluate(el => el.classList.contains('active'))));
check('زرار المسح باهت عند التحميل',
  await page.locator('#clearAll-products').evaluate(el => el.classList.contains('inactive')));
const countBefore = await page.locator('#tblCount-products').textContent();
await page.click('#msBtn-products-vendor');
await page.waitForTimeout(250);
await page.locator('#msList-products-vendor .ms-item input').first().check();
await page.waitForTimeout(350);
const countAfter = await page.locator('#tblCount-products').textContent();
check('الفلتر غيّر عدد النتائج', countBefore !== countAfter, countBefore + ' → ' + countAfter);
check('أيقونة الفلتر بقت مفعّلة (الحالة 2)',
  await page.locator('#fltIcon-products').evaluate(el => el.classList.contains('active')));
check('chips ظهرت باسم الفلتر مرة واحدة', await page.locator('#chipsRow-products-vendor .chips-label').count() === 1);
await page.click('#clearAll-products');
await page.waitForTimeout(400);
check('مسح كل الفلاتر رجّع العدد الأصلي', (await page.locator('#tblCount-products').textContent()) === countBefore);
check('أيقونة الفلتر رجعت رمادية (الحالة 3)',
  !(await page.locator('#fltIcon-products').evaluate(el => el.classList.contains('active'))));

// الترتيب — ٣ حالات + الأيقونة تظهر بس عند التفعيل
const iconsBefore = await page.locator('#panel-products .sort-icon.active').count();
check('مفيش أيقونة ترتيب قبل التفعيل على أعمدة تانية', iconsBefore <= 1);
await page.click('#panel-products th[data-sort-key="units"]');
await page.waitForTimeout(300);
check('الضغطة الأولى = تصاعدي (المعيار §8)',
  await page.evaluate(() => state.tables.products.sort.dir === 'asc'));
const firstUnitsDesc = await page.locator('#tblBody-products tr:first-child td:nth-child(6)').textContent();
await page.click('#panel-products th[data-sort-key="units"]');
await page.waitForTimeout(300);
const firstUnitsAsc = await page.locator('#tblBody-products tr:first-child td:nth-child(6)').textContent();
check('الترتيب بيقلب بين تنازلي وتصاعدي', firstUnitsDesc !== firstUnitsAsc, firstUnitsDesc + ' ↔ ' + firstUnitsAsc);
await page.click('#panel-products th[data-sort-key="units"]');
await page.waitForTimeout(300);
check('الضغطة التالتة بتلغي الترتيب',
  await page.evaluate(() => state.tables.products.sort.key === null));
check('الترتيب شغّال بعد مسح الفلاتر (مستقل عنها)', true);

console.log('\n══ 5) الهامش غير الموثوق بيظهر «—» مش 100% ══');
const unreliable = await page.evaluate(() =>
  (state.data.products || []).filter(p => p.units > 0 && !p.marginReliable).length);
const hasDash = await page.evaluate(() => {
  const rows = (state.data.products || []).filter(p => p.units > 0 && !p.marginReliable);
  return rows.every(p => p.marginPct === null);
});
check('كل موديل ناقص تكلفته هامشه null', hasDash, unreliable + ' موديل');

console.log('\n══ 6) تاب السجل — نفس معيار الجداول بالظبط ══');
await page.click('#tabBtn-log');
await page.waitForTimeout(1200);
check('السجل بشكل جدول مش بطاقات', await page.locator('#panel-log table.data-table').count() === 1);
check('السجل اتبنى بالكومبوننت الموحّد', await page.evaluate(() => !!state.tables.log && state.tables.log.cfg.server === true));
check('فلاتر السجل multi-select مش <select>',
  await page.locator('#panel-log .ms-btn').count() === 3 && await page.locator('#panel-log select').count() === 0);
check('أعمدة السجل قابلة للترتيب', await page.locator('#panel-log th.sortable-th').count() >= 6);
const logRows = await page.locator('#tblBody-log tr').count();
check('صفوف السجل اترسمت', logRows === 2, logRows + ' صف');
const oddTs = await page.locator('#tblBody-log tr:nth-child(2) td:first-child').textContent();
check('صيغة التاريخ المخصّصة ما بتطلعش Invalid Date', !/Invalid/.test(oddTs), oddTs.trim());
check('فلتر التاريخ مخفي في تاب السجل',
  await page.locator('#dashControls').evaluate(el => el.style.display === 'none'));

// الفلترة لازم تروح للسيرفر — مش تتنفّذ على الصفحة المعروضة
await page.click('#msBtn-log-tool');
await page.waitForTimeout(200);
check('قائمة الفلتر بتترسم عند أول فتح (كسول)', await page.locator('#msList-log-tool .ms-item').count() === 3);
await page.locator('#msList-log-tool .ms-item input[value="order_status"]').check();
await page.waitForTimeout(900);
check('⭐ الفلتر اتبعت للسيرفر (مش فلترة صفحة)', LAST_LOG_Q.tool === 'order_status', JSON.stringify(LAST_LOG_Q));
check('العدّاد اتحدّث من ردّ السيرفر', (await page.locator('#tblCount-log').textContent()).trim() === '1');
check('chips ظهرت في السجل', await page.locator('#chipsRow-log-tool .ms-chip').count() === 1);
await page.click('#panel-log th[data-sort-key="employee"]');
await page.waitForTimeout(900);
check('⭐ الترتيب اتبعت للسيرفر تصاعدي أولًا', LAST_LOG_Q.sort === 'employee' && LAST_LOG_Q.dir === 'asc', JSON.stringify(LAST_LOG_Q));
await page.click('#clearAll-log');
await page.waitForTimeout(900);
check('مسح الفلاتر رجّع العدّاد للكل', (await page.locator('#tblCount-log').textContent()).trim() === '2');

console.log('\n══ 6b) الأرقام الجديدة بتوصل للشاشة فعلاً ══');
await page.click('#tabBtn-products');
await page.waitForTimeout(700);
check('قسم جودة بيانات الكتالوج موجود', await page.locator('#secBody-prodDQ').count() === 1);
check('قسم الجودة فيه كل البنود الستة', await page.locator('#secBody-prodDQ .mini-row').count() === 6);
await page.click('#tabBtn-customers');
await page.waitForTimeout(700);
check('كارت «COD بحالة غير معروفة» ظاهر',
  (await page.locator('#panel-customers').textContent()).includes('COD بحالة غير معروفة'));
await page.click('#tabBtn-cmd');
await page.waitForTimeout(500);
const excText = await page.locator('#secBody-cmdExc').textContent();
check('لوحة الاستثناءات فيها بنود جودة الكتالوج',
  excText.includes('SKU مكرر في الكتالوج') && excText.includes('SKU مباع مش في الكتالوج'));
check('بانرات get_data بتتخفي في تاب السجل', await (async () => {
  await page.click('#tabBtn-log'); await page.waitForTimeout(500);
  const hidden = await page.locator('#globalBanners').evaluate(el => el.style.display === 'none');
  await page.click('#tabBtn-cmd'); await page.waitForTimeout(300);
  return hidden;
})());

console.log('\n══ 7) النوافذ وسلّم z-index ══');
await page.click('#tabBtn-cmd');
await page.waitForTimeout(400);
await page.click('button:has-text("عن الأداة")');
await page.waitForTimeout(300);
check('نافذة «عن الأداة» بتفتح', await page.locator('#aboutOverlay.open').count() === 1);
check('هيدر النافذة ثابت (flex-shrink:0)',
  await page.locator('#aboutOverlay .eco-modal-hdr').evaluate(el => getComputedStyle(el).flexShrink === '0'));
check('جسم النافذة بيتمرّر لوحده',
  await page.locator('#aboutOverlay .eco-modal-body').evaluate(el => getComputedStyle(el).overflowY === 'auto'));
check('زرار الإغلاق بإطار أحمر',
  await page.locator('#aboutOverlay .modal-close-x').evaluate(el => getComputedStyle(el).borderTopColor !== 'rgba(0, 0, 0, 0)'));
check('السهم على <summary> ظاهر (مفيش list-style:none)',
  await page.locator('#aboutOverlay .about-sec > summary').first().evaluate(el => getComputedStyle(el).listStyleType !== 'none'));
await page.click('#aboutOverlay .modal-close-x');
await page.waitForTimeout(200);
const zi = await page.evaluate(() => ({
  login: getComputedStyle(document.querySelector('.login-overlay')).zIndex,
  modal: getComputedStyle(document.querySelector('.eco-overlay')).zIndex,
  toast: getComputedStyle(document.querySelector('.toast-container')).zIndex,
}));
check('سلّم z-index: 500 / 600 / 9999', zi.login === '500' && zi.modal === '600' && zi.toast === '9999', JSON.stringify(zi));

console.log('\n══ 8) عرض الأداة والجداول ══');
const cw = await page.evaluate(() => {
  const c = document.querySelector('.container');
  return { max: getComputedStyle(c).maxWidth, w: c.getBoundingClientRect().width };
});
check('عرض الأداة Tier L = 1400px', cw.max === '1400px', JSON.stringify(cw));
await page.click('#tabBtn-products');
await page.waitForTimeout(600);
const align = await page.evaluate(() => {
  const th = document.querySelector('#panel-products thead th');
  const td = document.querySelector('#panel-products tbody td');
  return { th: getComputedStyle(th).textAlign, td: getComputedStyle(td).textAlign };
});
check('كل خلايا الجدول متوسّطة (رأس وجسم)', align.th === 'center' && align.td === 'center', JSON.stringify(align));

console.log('\n══ 9) نطاق تاريخ غلط بيتقال بصوت عالي ══');
await page.fill('#rangeDateFrom', '2026-08-20');
await page.fill('#rangeDateTo', '2026-08-10');
await page.waitForTimeout(300);
check('⭐ النطاق المقلوب بيعرض رسالة مش بيفشل بصمت',
  await page.locator('#rangeError').isVisible() &&
  (await page.locator('#rangeError').textContent()).includes('البداية'));
check('الخانتين اتعلّمت غلط', await page.locator('#rangeDateFrom.input-invalid').count() === 1);
await page.click('#rangePresetBtn');
await page.waitForTimeout(200);
await page.click('.range-preset-item[data-preset="today"]');
await page.waitForTimeout(900);
check('اختيار فترة جاهزة بيمسح رسالة الغلط', !(await page.locator('#rangeError').isVisible()));

console.log('\n══ 9b) عزل الأعطال — عطل رسم ≠ فشل تحميل ══');
await page.evaluate(() => { window.__origGeo = renderGeoTab; renderGeoTab = () => { throw new Error('عطل رسم مصطنع'); }; });
await page.evaluate(() => { state.renderedTabs.geo = false; });
await page.click('#tabBtn-geo');
await page.waitForTimeout(500);
check('⭐ عطل الرسم بيتعرض جوّه التاب', (await page.locator('#panel-geo .banner.err').count()) === 1);
check('⭐ عطل الرسم مش بيتعرض كـ«فشل تحميل البيانات»', (await page.locator('.error-state').count()) === 0);
check('⭐ باقي التابات فضلت شغّالة', await page.evaluate(() => !!state.data));
await page.evaluate(() => { renderGeoTab = window.__origGeo; state.renderedTabs.geo = false; });

console.log('\n══ 9c) حالة الخطأ ما بتعرضش أرقام — والسجل يفضل مفتوح ══');
await page.click('#tabBtn-cmd');
await page.waitForTimeout(300);
await page.evaluate(() => setViewState('error', { message: 'اختبار: فشل جلب الصفحة 3', step: 'stage1_page_3' }));
await page.waitForTimeout(300);
check('المحتوى بيتخفي في حالة الخطأ', !(await page.locator('#appMain').isVisible()));
check('رسالة الخطأ بتسمّي الخطوة', (await page.locator('.error-state').textContent()).includes('stage1_page_3'));
await page.click('#tabBtn-log');
await page.waitForTimeout(900);
check('⭐ تاب السجل بيفضل مفتوح والداشبورد في حالة خطأ',
  await page.locator('#panel-log table.data-table').isVisible());
check('⭐ شاشة الخطأ بتتخفي وإحنا في السجل', !(await page.locator('#viewState').isVisible()));
await page.click('#tabBtn-cmd');
await page.waitForTimeout(300);
check('الرجوع لتاب تاني بيرجّع شاشة الخطأ', await page.locator('.error-state').isVisible());

console.log('\n══ 10) صافي الأخطاء ══');
check('صفر أخطاء JS طول الجلسة', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
// «عطل رسم مصطنع» هو الاستثناء اللي حقنّاه إحنا في قسم 9b — تسجيله في الـ console
// هو **السلوك الصح** (panelError بتسجّله عشان يتشاف)، فمستبعد من العد.
const realConsoleErrors = consoleErrors.filter(e => !/favicon|net::ERR_FILE|ERR_TUNNEL_CONNECTION_FAILED|fonts.googleapis|عطل رسم مصطنع/.test(e));
check('صفر أخطاء console', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 4).join(' | '));

await browser.close();
console.log(`\n${'═'.repeat(70)}\nالنتيجة: ${PASS} نجحت · ${FAIL} فشلت\n${'═'.repeat(70)}`);
process.exit(FAIL ? 1 : 0);
