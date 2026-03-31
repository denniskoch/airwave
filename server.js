const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json(config));

app.get('/api/xmltv', async (req, res) => {
  try {
    const r = await fetch(`${config.iptv.server}${config.iptv.xmltvPath}`);
    if (!r.ok) return res.status(r.status).json({ error: 'Upstream error' });
    const text = await r.text();
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/channels', async (req, res) => {
  try {
    const r = await fetch(`${config.iptv.server}${config.iptv.m3uPath}`);
    if (!r.ok) return res.status(r.status).json({ error: 'Upstream error' });
    const text = await r.text();
    res.set('Content-Type', 'text/plain');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RSS proxy — only allows URLs explicitly listed in config to prevent open proxy abuse
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const allowed = config.rssFeeds.map(f => f.url);
  if (!allowed.includes(url)) {
    return res.status(403).json({ error: 'URL not in allowed list' });
  }

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'TechTV/1.0 RSS Reader' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TechTV → http://localhost:${PORT}`));
