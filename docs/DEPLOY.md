<div dir="rtl">

# دليل النشر — مركز قيادة المتجر

الأداة قطعتين منفصلتين، وكل واحدة بتتنشر بطريقتها:

| القطعة | الملف | بتتنشر فين |
|---|---|---|
| الـ API | `index.js` + `wrangler.toml` | Cloudflare Worker (`store-command-center-worker`) |
| الواجهة | `index.html` | GitHub Pages |

> **نسخة الـ Worker ≠ نسخة الـ HTML.** طبيعي يختلفوا. زرار «⚠️» جنب رقم النسخة
> في الهيدر بيظهر لوحده لو الاتنين مش متوافقين.

---

## قبل أي حاجة — خط الأساس

قبل ما تنشر، افتح الأداة الحالية وسجّل ٣ أرقام لفترة معروفة (مثلاً «آخر ٧ أيام»):
عدد الأوردرات · صافي المبيعات · نسبة التسليم. بعد النشر، نفس الفترة لازم تدّي
**نفس الأرقام**. فتح الصفحة من غير مقارنة أرقام **مش إثبات إن النشر نجح**.

---

## 1. الريبو

الريبو على GitHub لازم يتعمل **فاضي** — من غير README ولا .gitignore ولا license
(أي ملف بيتعمل مع الريبو بيخلي أول push محتاج merge).

```bash
git init -b main
git add -A
git commit -m "Initial commit — Store Command Center"
git remote add origin https://github.com/ecommoda-dev/Store-Command-Center.git
git push -u origin main
```

> ⚠️ **الريبو عام (public).** ممنوع تمامًا يتعمل commit لأي ملف فيه بيانات عملاء
> حقيقية. `test/payload.json` و`test/shots/` و`data/` كلهم في `.gitignore` عشان
> كده — **متشيلهمش منه**.

---

## 2. مساحة KV (خطوة لمرة واحدة — لازم تسبق أول deploy)

`wrangler.toml` فيه `id = "PUT_KV_NAMESPACE_ID_HERE"` كـ placeholder. الـ deploy
**هيفشل** طول ما هو كده. اعمل المساحة وحط الـ id الحقيقي:

```bash
npx wrangler kv namespace create DASH_KV
# الرد فيه: id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

بعدين بدّل القيمة في `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DASH_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # ← الـ id اللي رجع من الأمر فوق
```

وبعدها commit + push.

> ليه KV مش D1؟ لأن ده **كاش** مش سجل: قيمة واحدة كبيرة لكل نطاق، بتتقرا كلها
> مرة واحدة، وبتنتهي صلاحيتها لوحدها. D1 هنا للسجل والمصادقة بس.

---

## 3. إنشاء الـ Worker مربوط بالـ git من أول لحظة

> Workers & Pages → **Create** → **Continue with GitHub** → اختار
> `ecommoda-dev/Store-Command-Center` → **Next**
>
> في شاشة "Set up your application":
> - **Project name** = `store-command-center-worker` — **بالظبط زي `name` في
>   `wrangler.toml`**. الافتراضي بيبقى اسم الريبو، وسيبه كده بيعمل **Worker شبح**:
>   Worker تاني باسم الريبو بيتنشر عليه الكود، وإنت بتراقب الأول وبتستغرب إنه واقف.
> - Build command: **فاضي**
> - Deploy command: `npx wrangler deploy`
> - → **Deploy**

المسار ده بيبني من أول مرة. (ربط Worker **موجود** هو اللي محتاج commit جديد
عشان يشغّل أول build.)

---

## 4. الأسرار (Secrets)

الأداة بتحتاج سرين. الـ `[vars]` في `wrangler.toml` بتتطبّق تلقائي مع Workers
Builds، إنما **الأسرار لأ** — دي بتتحط من الداشبورد:

> Worker → Settings → **Variables and Secrets** → Add → نوع **Secret**

| السر | القيمة |
|---|---|
| `SHOPIFY_TOKEN` | توكن Admin API (نفس اللي في باقي الأدوات) |
| `API_SECRET` | السر اللي الواجهة بتبعته في هيدر `X-API-Key` |

### ⚠️ الفخ رقم واحد: Promote بعد أي سر جديد

إضافة سر بتعمل **version جديدة من غير نشر**. الـ Active deployment بيفضل القديم
اللي مش شايف السر — والأداة بترجّع خطأ مصادقة وإنت متأكد إنك حطيت السر.

> بعد أي إضافة/تعديل سر: **Deployments → أحدث version → Promote to production**

وبعدها اتأكد إن `Active` فعلاً بقى الرقم الجديد.

---

## 5. الواجهة — GitHub Pages

> Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)`

الرابط بيبقى:

```
https://ecommoda-dev.github.io/Store-Command-Center/
```

⚠️ **حساسية الحروف:** GitHub Pages بيفرّق بين `index.html` و`Index.html`.
الملف هنا اسمه `index.html` بحروف صغيرة، فالرابط المختصر (اللي بينتهي بـ `/`)
بيشتغل من غير ما تكتب اسم الملف. لو كتبت اسم الملف بحرف كبير هيرجّع 404.

⚠️ **Pages أبطأ من Workers Builds.** بعد الـ push، الـ Worker بيبقى جاهز في
ثواني والواجهة ممكن تاخد دقيقتين. لو فتحت الصفحة ولقيت النسخة القديمة، استنى
وأعمل hard refresh (`Ctrl+Shift+R`) — مش تفتكرها فشلت وتعيد النشر.

---

## 6. أول تشغيل — إعدادات الأداة

الأداة بتفتح على شاشة الدخول وجنبها زرار **⚙️ الإعدادات**. أول مرة لازم تتملي:

| الحقل | القيمة |
|---|---|
| رابط الـ Worker | `https://store-command-center-worker.<account>.workers.dev` |
| سر الـ API | نفس قيمة `API_SECRET` |
| رابط الأدمن | `https://admin.shopify.com/store/<store>` (عشان لينكات الأوردرات) |
| مدة التوريد (يوم) | ٢١ افتراضيًا — بيدخل في نقطة إعادة الطلب |
| أقل هامش مقبول % | ٢٠ افتراضيًا — بيدخل في رؤية «موديل بيبيع بهامش ضعيف» |

القيم دي بتتخزن في `localStorage` على متصفح المستخدم. **اسم الموظف مش بيتخزن
أبدًا** — كل فتح للصفحة بيحتاج دخول جديد.

بعد ما تحط الإعدادات، اضغط **🩺 افحص الأداة والاتصالات** — بيرجّع سطر لكل فحص
(شوبيفاي · D1 · KV · الأسرار) وبيقول الناقص بالاسم.

---

## 7. تسجيل الأداة في `ecommoda-constants`

السجل بيتفلتر بالـ `tool`، فالأداة لازم تتسجّل عشان تظهر في أدوات تانية:

```
tool = store_command_center
```

ضيفها في §7 (جدول الأدوات) في مهارة `ecommoda-constants` مع نوعها: **قراءة فقط**
(بتكتب `login` / `logout` بس).

---

## 8. قائمة التحقق النهائية

```
[ ] 0.  خط الأساس متسجّل قبل البدء
[ ] 1.  الـ build نجح                      Deployments → Recent builds
[ ] 2.  الـ Active deployment = أحدث version   ← فخ الـ Promote
[ ] 3.  عدد الـ Workers ما زادش               ← فخ الـ Worker الشبح
[ ] 4.  الـ binding DB → ecommoda-dev-logs متربط
[ ] 5.  الـ binding DASH_KV بـ id حقيقي (مش placeholder)
[ ] 6.  SHOP_DOMAIN ظاهر في Runtime variables
[ ] 7.  Pages نشرت والرابط المختصر بيفتح (بشرطة مايلة في الآخر)
[ ] 8.  ?action=diag رجّع كل الفحوصات ✅
[ ] 9.  زرار «تحديث» جوّه الأداة رجّع أرقام = خط الأساس   ← الإثبات الحقيقي
[ ] 10. الدخول اتسجّل في D1:  SELECT * FROM logs WHERE tool='store_command_center'
[ ] 11. test/payload.json و test/shots/ **مش** في الـ commit
```

---

## 9. التحديثات بعد كده

```bash
git add -A && git commit -m "…" && git push
```

الـ push بيشغّل build ونشر تلقائي للـ Worker، وPages بتنشر الواجهة. **من غير أي
خطوة يدوية** — إلا لو ضفت سر جديد (ساعتها Promote).

قبل أي push، شغّل الاختبارات:

```bash
node test/harness.mjs        # 76 اختبار على بيانات حقيقية
node test/make-payload.mjs   # بيبني حمولة الاختبار
node test/browser-test.mjs   # 75 فحص في متصفح حقيقي
```

</div>
