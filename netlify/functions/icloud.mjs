export const handler = async () => {
  const ICLOUD_TOKEN = process.env.ICLOUD_ALBUM_TOKEN;

  try {
    let host = 'p62-sharedstreams.icloud.com';

    // Step 1: fetch stream metadata; handle 330 partition redirect
    let resp = await fetch(`https://${host}/${ICLOUD_TOKEN}/sharedstreams/webstream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamCtag: null })
    });
    if (resp.status === 330) {
      const redir = await resp.json();
      host = redir['X-Apple-MMe-Host'];
      resp = await fetch(`https://${host}/${ICLOUD_TOKEN}/sharedstreams/webstream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamCtag: null })
      });
    }
    const stream = await resp.json();
    const photos = stream.photos || [];

    if (!photos.length) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [] }) };
    }

    // Step 2: fetch CDN asset URLs
    const urlResp = await fetch(`https://${host}/${ICLOUD_TOKEN}/sharedstreams/webasseturls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoGuids: photos.map(p => p.photoGuid) })
    });
    const urlData = await urlResp.json();
    const items = urlData.items || {};

    const result = photos.flatMap(photo => {
      const derivs = photo.derivatives || {};
      const dKeys = Object.keys(derivs);
      // Prefer '2048' size; fall back to anything that isn't the original
      const key = dKeys.find(k => k === '2048')
               || dKeys.find(k => k !== '5003')
               || dKeys[0];
      if (!key) return [];
      const checksum = (derivs[key] || {}).checksum;
      const loc = checksum && items[checksum];
      if (!loc) return [];
      return [{ url: `https://${loc.url_location}${loc.url_path}`, caption: photo.caption || '' }];
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: result }) };
  } catch (e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [], error: e.message, stack: e.stack }) };
  }
};
