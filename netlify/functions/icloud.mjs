// iCloud shared-streams API uses numbered partition hosts (p01–p99).
// We don't know which one owns this album until we get a 330 redirect,
// but some partitions never respond from certain networks.  Try several
// in parallel and take whichever answers first.
const CANDIDATE_HOSTS = [
  'p62-sharedstreams.icloud.com',
  'p57-sharedstreams.icloud.com',
  'p66-sharedstreams.icloud.com',
  'p01-sharedstreams.icloud.com',
  'p06-sharedstreams.icloud.com',
  'p36-sharedstreams.icloud.com',
];

export const handler = async () => {
  const ICLOUD_TOKEN = process.env.ICLOUD_ALBUM_TOKEN;
  const hdrs = { 'Content-Type': 'application/json' };
  const fail = (msg, extra = {}) =>
    ({ statusCode: 200, headers: hdrs, body: JSON.stringify({ photos: [], error: msg, ...extra }) });

  if (!ICLOUD_TOKEN) return fail('ICLOUD_ALBUM_TOKEN env var not set');

  const postJSON = (url, body, signal) =>
    fetch(url, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body),
      signal,
    });

  try {
    // ── Step 1: race all candidate hosts, get first response ──────────
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 9000);

    let host, stream;
    try {
      const first = await Promise.any(
        CANDIDATE_HOSTS.map(async h => {
          const r = await postJSON(
            `https://${h}/${ICLOUD_TOKEN}/sharedstreams/webstream`,
            { streamCtag: null },
            ctrl1.signal
          );
          // If iCloud wants us on a different partition it returns 330
          if (r.status === 330) {
            const redir = await r.json();
            const redirectHost = redir['X-Apple-MMe-Host'];
            const r2 = await postJSON(
              `https://${redirectHost}/${ICLOUD_TOKEN}/sharedstreams/webstream`,
              { streamCtag: null },
              ctrl1.signal
            );
            return { host: redirectHost, data: await r2.json() };
          }
          return { host: h, data: await r.json() };
        })
      );
      clearTimeout(t1);
      host = first.host;
      stream = first.data;
    } catch (e) {
      clearTimeout(t1);
      const isTimeout = e.name === 'AbortError' || (e.errors && e.errors.every(x => x.name === 'AbortError'));
      return fail(isTimeout ? 'iCloud API timed out — all partition hosts unreachable' : e.message);
    }

    const photos = stream.photos || [];
    if (!photos.length) {
      return { statusCode: 200, headers: hdrs, body: JSON.stringify({ photos: [] }) };
    }

    // ── Step 2: fetch CDN asset URLs ──────────────────────────────────
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 9000);
    let urlData;
    try {
      const urlResp = await postJSON(
        `https://${host}/${ICLOUD_TOKEN}/sharedstreams/webasseturls`,
        { photoGuids: photos.map(p => p.photoGuid) },
        ctrl2.signal
      );
      urlData = await urlResp.json();
    } catch (e) {
      clearTimeout(t2);
      return fail(e.name === 'AbortError' ? 'timed out fetching asset URLs' : e.message);
    }
    clearTimeout(t2);

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

    return { statusCode: 200, headers: hdrs, body: JSON.stringify({ photos: result }) };
  } catch (e) {
    return fail(e.message, { stack: e.stack });
  }
};
