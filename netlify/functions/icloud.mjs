export const handler = async () => {
  const ICLOUD_TOKEN = process.env.ICLOUD_ALBUM_TOKEN;
  const ok = { 'Content-Type': 'application/json' };
  const fail = (msg, extra = {}) =>
    ({ statusCode: 200, headers: ok, body: JSON.stringify({ photos: [], error: msg, ...extra }) });

  if (!ICLOUD_TOKEN) return fail('ICLOUD_ALBUM_TOKEN env var not set');

  // Shared AbortController so all fetches respect a single 8s budget
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    let host = 'p62-sharedstreams.icloud.com';

    const fetchJSON = async (url, body) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return { status: r.status, data: await r.json() };
    };

    // Step 1: fetch stream metadata; handle 330 partition redirect
    let { status, data: stream } = await fetchJSON(
      `https://${host}/${ICLOUD_TOKEN}/sharedstreams/webstream`,
      { streamCtag: null }
    );
    if (status === 330) {
      host = stream['X-Apple-MMe-Host'];
      ({ data: stream } = await fetchJSON(
        `https://${host}/${ICLOUD_TOKEN}/sharedstreams/webstream`,
        { streamCtag: null }
      ));
    }
    const photos = stream.photos || [];

    if (!photos.length) {
      clearTimeout(timer);
      return { statusCode: 200, headers: ok, body: JSON.stringify({ photos: [] }) };
    }

    // Step 2: fetch CDN asset URLs
    const { data: urlData } = await fetchJSON(
      `https://${host}/${ICLOUD_TOKEN}/sharedstreams/webasseturls`,
      { photoGuids: photos.map(p => p.photoGuid) }
    );
    const items = urlData.items || {};

    const result = photos.flatMap(photo => {
      const derivs = photo.derivatives || {};
      const dKeys = Object.keys(derivs);
      const key = dKeys.find(k => k === '2048')
               || dKeys.find(k => k !== '5003')
               || dKeys[0];
      if (!key) return [];
      const checksum = (derivs[key] || {}).checksum;
      const loc = checksum && items[checksum];
      if (!loc) return [];
      return [{ url: `https://${loc.url_location}${loc.url_path}`, caption: photo.caption || '' }];
    });

    clearTimeout(timer);
    return { statusCode: 200, headers: ok, body: JSON.stringify({ photos: result }) };
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e.name === 'AbortError';
    return fail(isTimeout ? 'iCloud API timed out after 8s' : e.message, { stack: e.stack });
  }
};
