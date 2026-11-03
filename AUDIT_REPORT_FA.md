# گزارش ممیزی و اصلاح Mahyar Gap

**نتیجه کلی:** سورس اصلاح شده و build تولیدی موفق است؛ با این حال، چون PostgreSQL، LiveKit و دو مرورگر/کاربر در اختیار این ممیزی نبود، نمی‌توان اتصال end-to-end پیام‌ها، صدا، دوربین یا screen share را به‌عنوان تست واقعی تأیید کرد. بنابراین این نسخه را «تست‌شده در production» نمی‌نامم.

## اصلاحات انجام‌شده

- API احراز هویت‌شده با bcrypt و JWT و کنترل دسترسی سمت سرور؛ routeهای Socket.IO نیز token را بررسی می‌کنند.
- پیام‌ها و direct messageها از API/Prisma ذخیره می‌شوند؛ رویدادهای create/update/delete برای پیام‌ها و DMs از Socket.IO به اتاق‌های مجاز فرستاده می‌شود. direct-message participantها و شناسهٔ conversation اعتبارسنجی می‌شوند و امکان افزودن participant به conversation موجود بسته شده است.
- احراز مجوز سرور برای پیام، voice، role، channel، ban و kick؛ ایجاد و تخصیص role سمت سرور بررسی می‌شود. کاربر غیرمالک نمی‌تواند مجوزهای مدیریتی/حساس یا role ممتاز را اعطا کند. نام `@everyone` رزرو شده است.
- kick/ban عضویت را حذف می‌کند، voice-sessionهای باقی‌مانده را پاک می‌کند، دسترسی socket به channelها را می‌بندد و در صورت پیکربندی LiveKit، participant را قطع و token قبلی را revoke می‌کند. تغییر مجوزهای role نیز رسانهٔ عضو را برای دریافت token تازه reconnect می‌کند.
- تغییر پیام‌ها و DMs به کلاینت‌های آنلاین از طریق Socket.IO منعکس می‌شود؛ کلاینت channel انتخاب‌شده را پس از reconnect دوباره join می‌کند. LiveKit در کد از reconnect/backoff محدود استفاده می‌کند.
- WebRTC شبیه‌سازی‌شده حذف شد و به LiveKit SDK محلی/trackهای واقعی browser وصل شد. تنظیمات ورودی/خروجی دستگاه، mute/deafen و camera/screen-track به session واقعی متصل هستند. UI برای حضور صوتی، trackها و وضعیت اتصال از اطلاعات واقعی LiveKit استفاده می‌کند، نه شمارش sessionهای قدیمی.
- XSS ناشی از مقادیر رنگ، آیکن، status و برخی inline handlerها محدود شد؛ HTML escape و sanitizerهای محدودکننده اضافه شد. CSP و security headers فعال‌اند.
- تمام ۱۳۵ HTML inline event handler به `data-action`/keyboard metadata تبدیل شد و با event delegation روی `document` و فهرست مجاز actionها اجرا می‌شود؛ inline JavaScript قابل‌اجرا یا `eval` استفاده نمی‌شود. رویدادهای فرم احراز هویت همچنان با `addEventListener` ثبت می‌شوند.
- Tailwind CDN حذف شد؛ dependency و config محلی اضافه شدند و `npm run build` فایل minified `css/tailwind.generated.css` را تولید می‌کند. CSP اکنون `script-src 'self'` و `script-src-attr 'none'` را صریحاً اعمال می‌کند و دیگر `unsafe-inline`, `unsafe-eval` یا دامنهٔ Tailwind CDN در script policy ندارد.
- کنترل emoji picker نیز برای click/touch عملکرد toggle دارد. اسکن سورس first-party هیچ SVG/path literal یا API ساخت SVG پیدا نکرد؛ خطای `path d` گزارش‌شده در این سورس قابل تکرار/تعیین نبود.
- درخواست مرورگر برای `/favicon.ico` ابتدا 404 می‌شد؛ فایل ICO کوچکِ هم‌رنگ برند افزوده شد، route استاتیک صریح و محدود برای آن ثبت شد و asset در Docker runner کپی می‌شود.
- درخواست دوستی از حالت auto-accept به pending واقعی تغییر کرد. audit log از update/delete عادی append-only شد.
- ادعاهای نادرست برای Railway/DB/LiveKit health، GIF و screen-share demo حذف شدند. uploader حذف شد چون storage ندارد؛ DM voice/video به‌وضوح پشتیبانی‌نشده اعلام می‌شود. private channel درخواست‌شده رد می‌شود تا ACL ناقص به‌عنوان حفاظت ارائه نشود.
- `bcrypt` و `zod` به نسخه‌های دارای اصلاح امنیتی ارتقا یافتند. Docker/Railway files، migration اولیه و متغیرهای محیطی نمونه پاک‌سازی شدند.
- برای سازگاری با `machina@7.0.1`، هر دو stage در Dockerfile به `node:22-alpine` تغییر کردند و شرط Node در `package.json` و metadata ریشهٔ `package-lock.json` روی `>=22.22.0` هماهنگ شد.
- خطای Railway مربوط به sort اصلاح شد: `server_members` و `voice_sessions` اکنون بر اساس `joinedAt` مرتب می‌شوند؛ برای مدل‌های دیگر، نگاشت صریح `createdAt` حفظ شده است. هیچ migration یا تغییری در داده‌های DB انجام نشد.
- خطای token signing در LiveKit رفع شد: permissionها اکنون از `TrackSource` enum رسمی SDK استفاده می‌کنند؛ علاوه بر آن، client فقط error code، correlation ID و نام متغیرهای محیطی مجاز/مفقود را حفظ و نمایش می‌دهد، نه credential یا مقادیر پاسخ دلخواه.

## آزمون‌های موفق

| آزمون | نتیجه |
|---|---|
| نصب تمیز از lockfile با `npm ci` روی Node v22.23.4 | موفق |
| `npx prisma generate` | موفق؛ Prisma Client v5.22.0 تولید شد |
| `npm run build` (Tailwind local CSS + LiveKit browser bundle + TypeScript production) | موفق |
| `npm test` | ۱۰ از ۱۰ موفق؛ شامل API contract، delegated action allowlist، CSP/Tailwind checks، Prisma mappings، LiveKit grants و diagnostics امن خطا |
| `node --check` روی JS و test files | موفق |
| `npx prisma validate` | موفق |
| مقایسه SQL تولیدشده از Prisma با migration اولیه | دقیقاً برابر |
| `npm audit --omit=dev` (runtime dependencies) | ۰ آسیب‌پذیری گزارش‌شده |
| smoke test محلی سرور | صفحهٔ `/` با ۲۰۰ بالا آمد؛ `/api/health` با ۵۰۳ پاسخ داد، که با نبود PostgreSQL محلی انتظار می‌رفت |
| بررسی static handlerهای `app.*` | handler تعریف‌نشده پیدا نشد |
| Chromium headless local smoke test | صفحهٔ login بالا آمد؛ dynamic theme action عمل کرد؛ User Settings modal باز/بسته شد؛ ۰ inline event attributes و ۰ button بی‌عمل در DOM نمونه؛ console entries برابر ۰ (شامل CSP، SVG path و 404) |
| Tailwind و favicon assets از سرور محلی | Tailwind CSS و `/favicon.ico` هر دو HTTP 200؛ stylesheet محلی بارگذاری شد و صفحه دیگر Tailwind CDN را نمی‌خواند |

در خروجی نصب تمیز چند اخطار deprecation از dependencyهای انتقالی توسعه (`inflight`, `rimraf@2`, `glob@7`) و هنگام build اخطار غیرمسدودکنندهٔ «caniuse-lite is outdated» از Tailwind CLI باقی ماند. این اخطارها پنهان یا سرکوب نشدند؛ build و تست‌ها با موفقیت تمام شدند. در اجرای audit در ۳۱ اکتبر ۲۰۲۶، `npm audit` کامل ۴ مورد moderate در زنجیرهٔ توسعهٔ `ts-node-dev`/`glob`/`minimatch`/`rimraf` گزارش کرد که برایشان fix خودکار موجود نبود؛ `npm audit --omit=dev` برای dependencyهای runtime صفر مورد گزارش کرد. این موارد dev-only هستند و مربوط به اصلاح LiveKit نیستند.

Prisma Client دو query `ServerMember.joinedAt` و `VoiceSession.joinedAt` را بدون خطای field/orderBy پذیرفت؛ اجرای read تا اتصال به DB متوقف شد، چون فقط آدرس محلی آزمایشیِ عمداً غیرفعال استفاده شد. به دیتابیس production وصل نشدم و هیچ داده‌ای را حذف یا تغییر ندادم.

آزمون‌های Node به‌طور مشخص **unit/contract test کلاینت** هستند؛ آن‌ها جایگزین تست HTTP/DB واقعی نیستند.

## مواردی که هنوز تأیید نشده یا پیاده‌سازی نشده‌اند

1. **هیچ PostgreSQL محلی در دسترس نبود.** Migration روی DB خالی واقعاً اجرا نشد؛ فقط schema اعتبارسنجی و SQL migration با خروجی Prisma مقایسه شد.
2. **هیچ LiveKit URL/key یا دو کاربر/مرورگر در دسترس نبود.** صدای دوطرفه، دوربین، screen share، رفتار واقعی بعد از قطع اینترنت و revoke دسترسی در سرویس LiveKit end-to-end تست نشدند.
3. **Docker executable در sandbox نبود.** Image build اجرا نشد؛ Dockerfile و manifest بازبینی شدند و build معادل Node موفق بود.
4. پروژه به GitHub push نشده و Railway deploy نشده است؛ credential/remote کاربر فراهم نشده بود.
5. **پیوست فایل/S3/R2 پیاده‌سازی نشده** و کنترل upload از composer برداشته شده است.
6. **تماس صوتی/تصویری در DM پیاده‌سازی نشده**؛ تماس رسانه‌ای فقط از voice channel سرور انجام می‌شود.
7. **Forum/Announcement تخصصی، ACL کانال خصوصی، hierarchy نقش‌ها، MFA، تأیید ایمیل و بازیابی رمز** پیاده‌سازی نشده‌اند. مقدار `is_private` از طریق API رد می‌شود.
8. جست‌وجو و load-earlier بر دادهٔ محدود کلاینت (حداکثر ۲۰۰ پیام) متکی‌اند؛ pagination نامحدود سمت سرور نیست.
9. Socket.IO به adapter چندنمونه‌ای متصل نیست؛ تا افزودن Redis adapter، سرویس را روی یک replica اجرا کنید. بعضی voice sessionها بعد از قطع ناگهانی مرورگر ممکن است در DB باقی بمانند؛ UI آن‌ها را به‌عنوان participant زنده نشان نمی‌دهد.
10. token ورود ۳۰ دقیقه اعتبار دارد و refresh/password recovery وجود ندارد. token در localStorage نگهداری می‌شود؛ سیاست XSS/مبدا قابل‌اعتماد باید جدی گرفته شود.
11. CSP برای script سخت‌گیر شده است، اما `style-src` هنوز `unsafe-inline` دارد چون UI از style attributeهای پویا استفاده می‌کند. حذف آن نیازمند انتقال این styleها به stylesheet/classهای امن است.
12. Chromium تست فقط login shell و modal/theme را در حالت بدون نشست آزمایش کرد. به‌دلیل نبود PostgreSQL و حساب‌های معتبر، تمام viewهای authenticated و عملیات واقعی create/join/channel/message با دو کاربر end-to-end تست نشدند؛ به‌دلیل نبود LiveKit service/credentials، voice و screen share نیز قابل آزمون واقعی نبودند.
13. خطای SVG path در browser console این محیط بازتولید نشد؛ سورس first-party فاقد SVG path است. اگر خطا در Railway ادامه داشت، stack/URL منبع console لازم است تا مشخص شود از browser extension یا منبع third-party/state خاصی آمده است.

## Deploy دقیق روی Railway

1. فایل ZIP یا پوشهٔ سورس را باز کنید؛ از ریشهٔ پروژه `git init`, `git add .`, `git commit -m "Prepare Mahyar Gap for Railway"` و سپس `git remote add origin https://github.com/<account>/<repo>.git`, `git branch -M main` و `git push -u origin main` را اجرا کنید. `.env` واقعی را commit نکنید.
2. در Railway یک project بسازید و **Deploy from GitHub repo** را انتخاب کنید.
3. یک PostgreSQL service به همان project اضافه کنید و بررسی کنید Railway مقدار `DATABASE_URL` را به web service ارجاع داده باشد.
4. در web service متغیرهای `NODE_ENV=production`, `JWT_ACCESS_SECRET` (حداقل ۳۲ کاراکتر تصادفی؛ با `openssl rand -hex 32` بسازید) و `BCRYPT_ROUNDS=12` را تنظیم کنید.
5. یک LiveKit Cloud project یا LiveKit server سازگار بسازید و مقادیر `LIVEKIT_URL` (`wss://...`)، `LIVEKIT_API_KEY` و `LIVEKIT_API_SECRET` را فقط در Variables سرویس Railway وارد کنید. بدون این مقادیر، endpoint توکن voice عمداً `503` می‌دهد.
6. اگر مرورگر cross-origin است، `CORS_ORIGIN` را برابر origin عمومی HTTPS دقیق قرار دهید؛ در همان دامنه معمولاً unset بماند. دامنهٔ Railway برای getUserMedia و screen capture باید HTTPS باشد.
7. Deploy را اجرا کنید. Railway از `Dockerfile` استفاده می‌کند، browser bundle و TypeScript را build می‌کند و دستور startup در `railway.json`، `prisma migrate deploy` را پیش از بالا آوردن سرور اجرا می‌کند.
8. منتظر health check مسیر `/api/health` بمانید. این endpoint فقط اتصال PostgreSQL را بررسی می‌کند؛ سلامت LiveKit را تأیید نمی‌کند.
9. تست پذیرش: دو مرورگر مستقل/پروفایل خصوصی با دو حساب بسازید؛ server و text/voice channel ایجاد کنید؛ invite را استفاده کنید؛ پیام ارسال کنید، در مرورگر دوم دریافت و پس از reload ماندگاری‌اش را بسنجید؛ سپس هر دو به همان voice channel بپیوندند و microphone، camera، screen share، mute/deafen، قطع و وصل شبکه و رد دسترسی role را آزمایش کنید. این گام‌ها باید پس از deploy شما انجام شوند؛ هنوز در این ممیزی انجام نشده‌اند.

راهنمای انگلیسی deploy و ساختار پروژه در [README.md](README.md) است.
