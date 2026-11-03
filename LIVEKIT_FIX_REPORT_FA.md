# گزارش اصلاح خطای اتصال LiveKit در Mahyar Gap

## نتیجه

علت مستقیم خطای `Voice connection failed, internal server error` در endpoint صدور توکن پیدا و اصلاح شد. کد، رشته‌های متنی مانند `'microphone'` و `'camera'` را با `as any` به `canPublishSources` می‌داد؛ اما نسخهٔ LiveKit Server SDK نصب‌شده در پروژه `TrackSource` enum عددی می‌خواهد و هنگام ساخت JWT این مقدارها را به رشته تبدیل می‌کند. ورودی رشته‌ای باعث TypeError می‌شد و endpoint به‌جای توکن، پاسخ 500 عمومی برمی‌گرداند.

## تغییرهای انجام‌شده

- در `server/index.ts`، import رسمی `TrackSource` از `livekit-server-sdk` اضافه شد. grantها اکنون با `TrackSource.MICROPHONE`, `CAMERA`, `SCREEN_SHARE` و `SCREEN_SHARE_AUDIO` ساخته می‌شوند و cast ناامن `as any` حذف شد.
- توکن همچنان فقط در backend و با `LIVEKIT_API_KEY` و `LIVEKIT_API_SECRET` امضا می‌شود. هیچ API secret به JavaScript مرورگر یا پاسخ HTTP اضافه نشده است.
- مجوز LiveKit شامل ورود به اتاق مشخص (`roomJoin` و `room`)، دریافت trackها (`canSubscribe`) و انتشار داده می‌ماند؛ انتشار microphone بر اساس `SPEAK_VOICE` و camera/screen بر اساس `STREAM_VIDEO` به TrackSourceهای مجاز محدود است.
- `LIVEKIT_URL` اکنون با URL parser اعتبارسنجی می‌شود. `wss://` و `https://` به URL امن `wss://` برای browser تبدیل می‌شوند. محیط production، `ws://` و `http://` را رد می‌کند. URL باید origin ریشه باشد، بدون credential، query، fragment یا path.
- endpoint نام متغیرهای ناقص را به‌صورت غیرمحرمانه در پاسخ 503 اعلام می‌کند. خطای ساخت/sign کردن JWT یک `errorId` برای تطبیق با log برمی‌گرداند؛ log نام خطا و پیام sanitised را ثبت می‌کند، نه کل error object، stack، token یا credential. خطاهای DB/permission جداگانه از خطای امضای JWT عبور می‌کنند.
- `js/api.js` فقط code محدودشده، correlation ID معتبر و نام متغیرهای مجاز را از پاسخ خطا روی Error نگه می‌دارد؛ `js/app.js` هنگام شکست ورود voice همان reference ID و نام متغیرهای ناقص را نشان می‌دهد تا خطای Railway قابل ردیابی باشد. مقادیر secret، token و سایر فیلدهای پاسخ نادیده گرفته می‌شوند.
- در `tests/api.test.js` regression test اضافه شد که SDK واقعی را با TrackSource enum صدا می‌زند، JWT آزمایشی تولید و grantهای decodeشده را بررسی می‌کند، و اتصال route به config/URL امن را assert می‌کند.
- یک regression test دیگر تضمین می‌کند که client فقط metadata غیرمحرمانه را از خطای API نگه دارد.
- `README.md` برای نام‌های env، URL normalization و رفتار خطا به‌روز شد.

## تنظیمات Railway

نام‌های موردنیاز دقیقاً همان متغیرهایی هستند که backend می‌خواند:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

کد متغیر جدیدی اضافه نکرده است؛ اگر همین سه نام در **Variables همان web service که Mahyar Gap را اجرا می‌کند** از قبل وجود دارند و مقادیر معتبرند، متغیر جدید لازم نیست. URL production باید secure باشد و ترجیحاً دقیقاً همان `wss://...` endpoint نمایش‌داده‌شده توسط LiveKit Cloud باشد. `https://...` نیز پذیرفته و برای مرورگر به `wss://...` تبدیل می‌شود. کلید و secret را فقط در Railway server variables نگه دارید.

من به پروژه Railway یا مقدارهای runtime این کاربر دسترسی نداشتم؛ بنابراین نام متغیرهایی را که واقعاً در dashboard ثبت شده‌اند یا مطابقت مقدارهایشان با LiveKit Cloud را از این محیط مستقل تأیید نمی‌کنم و هیچ مقدار محرمانه‌ای چاپ نشده است.

پس از push/deploy نسخهٔ اصلاح‌شده، از داخل برنامه روی voice channel تست کنید. اگر خطای **token signing** باقی ماند، پاسخ شامل `errorId` است؛ همان ID را در Railway service logs جستجو کنید. خطای ناقص‌بودن config اکنون به شکل 503 با فهرست فقط نام متغیرهای مفقود مشخص می‌شود. اگر توکن صادر شد ولی اتصال WebSocket به LiveKit شکست خورد، بررسی بعدی باید URL پروژه، API Key/Secret جفت‌شده، دسترسی شبکه و تنظیمات LiveKit Cloud باشد؛ این مسیر به credential واقعی و تست روی deploy نیاز دارد.

## تست‌های اجراشده

- `npx tsc --noEmit -p tsconfig.json`: موفق.
- `npm run build`: موفق (CSS محلی، browser bundle و TypeScript).
- `node --check` فایل‌های JS و test: موفق.
- `npm test`: **۱۰ از ۱۰ تست موفق**؛ شامل تولید و decode توکن LiveKit آزمایشی با grantهای microphone/camera/screen share و حفظ امن error reference/نام متغیرهای مفقود در client.
- `npx prisma validate`: موفق.

ساخت JWT با credentials ساختگیِ صرفاً تستی انجام شد تا رفتار SDK و grantها بررسی شود؛ این کار API Key یا Secret کاربر را نمی‌آزماید. تست end-to-end روی Railway/LiveKit Cloud، اتصال دو کاربر، صدا یا screen share در این محیط اجرا نشده است.
