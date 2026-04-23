// moneygrace service worker — 오프라인 지원 + 앱 쉘 캐시
// 새 배포 시 VERSION 을 바꿔 캐시 갱신을 유도한다.
const VERSION = "mg-2026-04-23-09";
const CACHE_NAME = `moneygrace::${VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./icon.svg",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
    })()
  );
  // 새 SW 는 설치 즉시 대기 상태로 진입 (클라이언트에서 수동 확정)
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k.startsWith("moneygrace::"))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 외부 요청(Anthropic API, Tesseract CDN 등)은 건드리지 않는다.
  if (url.origin !== self.location.origin) return;

  // stale-while-revalidate: 캐시를 즉시 반환하면서 백그라운드로 갱신
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((resp) => {
          if (resp && resp.ok && resp.type !== "opaque") {
            cache.put(req, resp.clone()).catch(() => {});
          }
          return resp;
        })
        .catch(() => null);
      return cached || (await networkPromise) || new Response("", { status: 504 });
    })()
  );
});
