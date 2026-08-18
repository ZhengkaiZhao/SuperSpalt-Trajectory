import { version as appVersion } from '../package.json';

// export default null
declare let self: ServiceWorkerGlobalScope;

const cacheName = `superSplat-v${appVersion}-trajectory-webgpu-16`;

const cacheUrls = [
    './',
    './index.css',
    './index.html',
    './index.js',
    './index.js.map',
    './manifest.json',
    './static/icons/logo-192.png',
    './static/icons/logo-512.png',
    './static/images/screenshot-narrow.jpg',
    './static/images/screenshot-wide.jpg',
    './static/lib/webp/webp.mjs',
    './static/lib/webp/webp.wasm',
    './static/lib/glslang/glslang.js',
    './static/lib/glslang/glslang.wasm',
    './static/lib/twgsl/twgsl.js',
    './static/lib/twgsl/twgsl.wasm',
    './static/locales/de.json',
    './static/locales/en.json',
    './static/locales/fr.json',
    './static/locales/ja.json',
    './static/locales/ko.json',
    './static/locales/zh-CN.json'
];

self.addEventListener('install', (event) => {
    console.log(`installing v${appVersion}`);

    // create cache for current version
    self.skipWaiting();
    event.waitUntil(
        caches.open(cacheName)
        .then(cache => cache.addAll(cacheUrls))
    );
});

self.addEventListener('activate', (event) => {
    console.log(`activating v${appVersion}`);

    // delete the old caches once this one is activated
    event.waitUntil(caches.keys()
    .then(names => Promise.all(names.map(name => (name !== cacheName ? caches.delete(name) : false))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const core = ['/', '/index.html', '/index.js', '/index.css', '/sw.js']
    .some(path => url.pathname.endsWith(path));

    // Core bundles are network-first so an old installed PWA cannot hide a new
    // HUD or renderer build. Large immutable WASM/assets remain cache-first.
    event.respondWith(core ?
        fetch(event.request, { cache: 'no-store' })
        .then((response) => {
            const copy = response.clone();
            caches.open(cacheName).then(cache => cache.put(event.request, copy));
            return response;
        })
        .catch(() => caches.match(event.request)) :
        caches.match(event.request).then(response => response ?? fetch(event.request))
    );
});
