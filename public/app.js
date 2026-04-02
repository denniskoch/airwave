/* ── TechTV frontend ── */
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  config: null,
  channels: [],
  programmes: {},      // channelId → sorted programme array
  currentChannelId: null,
  hls: null,
  streamTimer: null,
  progressTimer: null,
};

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    state.config = await fetch('/api/config').then(r => r.json());
    renderClockShells();
    startClocks();

    const [m3uText, xmltvText] = await Promise.all([
      fetch('/api/channels').then(r => r.text()),
      fetch('/api/xmltv').then(r => r.text()),
    ]);

    state.channels = parseM3U(m3uText);
    state.programmes = parseXMLTV(xmltvText);

    initVolume();
    renderGuide();
    if (state.channels.length) selectChannel(state.channels[0]);

    document.getElementById('epgBtn').addEventListener('click', openFullEPG);
    document.getElementById('epgCloseBtn').addEventListener('click', closeFullEPG);
    document.getElementById('chUpBtn').addEventListener('click', () => {
      const idx = state.channels.findIndex(c => c.id === state.currentChannelId);
      selectChannel(state.channels[(idx - 1 + state.channels.length) % state.channels.length]);
    });
    document.getElementById('chDnBtn').addEventListener('click', () => {
      const idx = state.channels.findIndex(c => c.id === state.currentChannelId);
      selectChannel(state.channels[(idx + 1) % state.channels.length]);
    });

    loadAllRSS();
    setInterval(refreshEPGData,    5 * 60 * 1000);
    setInterval(refreshChannels,   5 * 60 * 1000);
    setInterval(loadAllRSS,        5 * 60 * 1000);
    setInterval(tickEPG,           60 * 1000);      // reclassify now/past/future blocks
    // renderGuide is called by refreshEPGData every 5 min — that's sufficient for position drift
  } catch (e) {
    console.error('Init failed', e);
  }
}

// ── M3U parser ─────────────────────────────────────────────────────────────
function parseM3U(text) {
  const channels = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF:')) continue;
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith('#')) continue;

    const tvgId   = line.match(/tvg-id="([^"]+)"/)?.[1] ?? '';
    const tvgName = line.match(/tvg-name="([^"]+)"/)?.[1];
    const tvgLogo = line.match(/tvg-logo="([^"]+)"/)?.[1] ?? '';
    const chNo    = parseInt(line.match(/tvg-chno="(\d+)"/)?.[1] ?? line.match(/channel-number="(\d+)"/)?.[1] ?? '0', 10);
    const name    = tvgName ?? line.split(',').pop().trim();

    // Prefer HLS so hls.js can handle it
    let url = next;
    if (url.match(/\/channel\/\d+\.ts$/)) {
      url = url.replace(/\.ts$/, '.m3u8') + '?mode=segmenter';
    }

    channels.push({ id: tvgId, number: chNo, name, logo: tvgLogo, url });
    i++;
  }
  return channels.sort((a, b) => a.number - b.number);
}

// ── XMLTV parser ───────────────────────────────────────────────────────────
function parseXMLTV(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const programmes = {};
  doc.querySelectorAll('programme').forEach(el => {
    const chId  = el.getAttribute('channel');
    const start = parseXMLTVDate(el.getAttribute('start'));
    const stop  = parseXMLTVDate(el.getAttribute('stop'));
    if (!start || !stop) return;
    if (!programmes[chId]) programmes[chId] = [];
    programmes[chId].push({
      start,
      stop,
      title:      el.querySelector('title')?.textContent ?? '',
      icon:       el.querySelector('icon')?.getAttribute('src') ?? '',
      categories: [...el.querySelectorAll('category')].map(c => c.textContent),
      year:       el.querySelector('date')?.textContent?.slice(0, 4) ?? '',
    });
  });
  Object.values(programmes).forEach(p => p.sort((a, b) => a.start - b.start));
  return programmes;
}

function parseXMLTVDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mm, ss, sign, tzH, tzM] = m;
  const utc    = Date.UTC(+yr, +mo - 1, +dy, +hh, +mm, +ss);
  const offset = (sign === '+' ? 1 : -1) * ((+tzH * 60 + +tzM) * 60000);
  return new Date(utc - offset);
}

// ── Programme helpers ──────────────────────────────────────────────────────
function getCurrentProg(channelId, at = Date.now()) {
  return (state.programmes[channelId] ?? []).find(p => p.start <= at && p.stop > at) ?? null;
}

// ── Channel selection ──────────────────────────────────────────────────────
function selectChannel(ch) {
  if (ch.id === state.currentChannelId) return;
  state.currentChannelId = ch.id;

  // Header
  document.getElementById('headerChannel').innerHTML =
    `<span class="ch-num-badge">CH ${ch.number}</span><span class="ch-title">${esc(ch.name)}</span>`;

  // Channel bug (fades after 3s)
  const bug = document.getElementById('chBug');
  bug.textContent = `CH ${ch.number}`;
  bug.classList.add('visible');
  setTimeout(() => bug.classList.remove('visible'), 3000);

  startStatic();
  clearTimeout(state.streamTimer);
  state.streamTimer = setTimeout(() => playStream(ch.url), 800);

  updateNowBar(ch);
  clearInterval(state.progressTimer);
  state.progressTimer = setInterval(() => updateNowBar(ch), 15000);

  updateGuideActiveRow();
}

// ── Video playback ─────────────────────────────────────────────────────────
function playStream(url) {
  const video = document.getElementById('videoPlayer');
  if (state.hls) { state.hls.destroy(); state.hls = null; }

  if (Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    state.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); showLoading(false); stopStatic(); });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) showLoading(true); });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.addEventListener('loadeddata', () => { showLoading(false); stopStatic(); }, { once: true });
    video.play().catch(() => {});
  }
}

function showLoading(on) {
  document.getElementById('videoOverlay').classList.toggle('visible', on);
}

// ── Now-playing bar ────────────────────────────────────────────────────────
function updateNowBar(ch) {
  const now  = Date.now();
  const prog = getCurrentProg(ch.id, now);

  const artEl  = document.getElementById('nbArt');
  const titleEl = document.getElementById('nbTitle');
  const tagsEl  = document.getElementById('nbTags');
  const startEl = document.getElementById('nbStart');
  const endEl   = document.getElementById('nbEnd');
  const fillEl  = document.getElementById('nbFill');

  if (prog) {
    if (prog.icon) { artEl.src = prog.icon; artEl.style.display = 'block'; }
    else             { artEl.style.display = 'none'; }

    titleEl.textContent = prog.title;

    const tagParts = [];
    if (prog.year) tagParts.push(`<span class="tag">${prog.year}</span>`);
    prog.categories.slice(0, 3).forEach(c => tagParts.push(`<span class="tag">${esc(c)}</span>`));
    tagsEl.innerHTML = tagParts.join('');

    const elapsed  = now - prog.start;
    const duration = prog.stop - prog.start;
    fillEl.style.width = Math.min(100, (elapsed / duration) * 100) + '%';
    startEl.textContent = fmtTime(prog.start);
    endEl.textContent   = fmtTime(prog.stop);
  } else {
    artEl.style.display = 'none';
    titleEl.textContent = ch.name;
    tagsEl.innerHTML    = '';
    fillEl.style.width  = '0%';
    startEl.textContent = '';
    endEl.textContent   = '';
  }
}

// ── EPG ────────────────────────────────────────────────────────────────────
const MINI_PAST_MINS   = () => state.config?.guide?.pastMinutes   ?? 30;
const MINI_FUTURE_MINS = () => state.config?.guide?.futureMinutes ?? 90;
const MINI_WIN_MINS    = () => MINI_PAST_MINS() + MINI_FUTURE_MINS();

// Shared table builder — called by both renderMiniEPG and renderFullEPG
function renderEPG(container, channels, opts) {
  const { wStart, wEnd, ppm, timelineW, chColW,
          tableClass, timeRowClass, timeCellClass,
          chRowClass, progsCellClass, nowLineClass, onSelect } = opts;
  const now = Date.now();

  const table = document.createElement('table');
  table.className = tableClass;

  // Time header
  const thead   = document.createElement('thead');
  const timeRow = document.createElement('tr');
  if (timeRowClass) timeRow.className = timeRowClass;

  const thCorner = document.createElement('th');
  thCorner.className = 'epg-ch-col';
  thCorner.style.cssText = `width:${chColW}px;min-width:${chColW}px;`;
  timeRow.appendChild(thCorner);

  const thTime = document.createElement('th');
  thTime.className = timeCellClass;
  thTime.style.cssText = `width:${timelineW}px;min-width:${timelineW}px;`;
  const firstTick = Math.ceil(wStart / (30 * 60000)) * 30 * 60000;
  for (let t = firstTick; t <= wEnd; t += 30 * 60000) {
    const tick = document.createElement('div');
    tick.className = 'mini-tick';
    tick.style.left = ((t - wStart) / 60000 * ppm) + 'px';
    tick.innerHTML = `<span class="mini-tick-label">${fmtTime(t)}</span>`;
    thTime.appendChild(tick);
  }
  timeRow.appendChild(thTime);
  thead.appendChild(timeRow);
  table.appendChild(thead);

  // Channel rows
  const tbody = document.createElement('tbody');
  channels.forEach(ch => {
    const tr = document.createElement('tr');
    tr.className = chRowClass;
    tr.dataset.channelId = ch.id;
    if (ch.id === state.currentChannelId) tr.classList.add('active');
    tr.addEventListener('click', () => onSelect(ch));

    const tdLabel = document.createElement('td');
    tdLabel.className = 'epg-ch-col';
    tdLabel.innerHTML =
      `<div class="mini-ch-inner">` +
      `<span class="ch-num">${ch.number}</span>` +
      `<span class="ch-name">${esc(ch.name)}</span>` +
      `</div>`;
    tr.appendChild(tdLabel);

    const tdProgs = document.createElement('td');
    tdProgs.className = progsCellClass;
    tdProgs.style.cssText = `width:${timelineW}px;min-width:${timelineW}px;`;

    const progs = (state.programmes[ch.id] ?? []).filter(p => p.stop > wStart && p.start < wEnd);
    if (!progs.length) {
      const nd = document.createElement('div');
      nd.className = 'mini-no-data';
      nd.style.cssText = `left:2px;width:${timelineW - 4}px;`;
      nd.innerHTML = '<span>No EPG data</span>';
      tdProgs.appendChild(nd);
    } else {
      progs.forEach(prog => {
        const cs      = Math.max(prog.start.getTime(), wStart);
        const ce      = Math.min(prog.stop.getTime(),  wEnd);
        const leftPx  = (cs - wStart) / 60000 * ppm;
        const widthPx = Math.max(2, (ce - cs) / 60000 * ppm - 2);

        const block = document.createElement('div');
        block.className = 'mini-prog';
        block.dataset.start = prog.start.getTime();
        block.dataset.stop  = prog.stop.getTime();
        if (prog.start <= now && prog.stop > now) block.classList.add('now');
        else if (prog.stop <= now)                block.classList.add('past');
        else                                      block.classList.add('future');

        block.style.cssText = `left:${leftPx}px;width:${widthPx}px;`;
        block.title = `${prog.title} · ${fmtTime(prog.start)}–${fmtTime(prog.stop)}`;
        block.innerHTML =
          `<div class="mini-prog-title">${esc(prog.title)}</div>` +
          (widthPx > 80 ? `<div class="mini-prog-time">${fmtTime(prog.start)}–${fmtTime(prog.stop)}</div>` : '');

        block.addEventListener('click', e => { e.stopPropagation(); onSelect(ch); });
        tdProgs.appendChild(block);
      });
    }

    tr.appendChild(tdProgs);
    tbody.appendChild(tr);
  });
  // Always trail with at least 2 blank rows; pad to a minimum of 18 rows total
  const minRows    = 18;
  const trailRows  = 2;
  const spacerCount = Math.max(trailRows, minRows - channels.length);
  for (let i = 0; i < spacerCount; i++) {
    const tr = document.createElement('tr');
    tr.className = chRowClass + ' epg-spacer-row';
    tr.innerHTML = '<td class="epg-ch-col"></td><td></td>';
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);

  // Now-line
  const nowLine = document.createElement('div');
  nowLine.className = nowLineClass;
  nowLine.style.left = (chColW + MINI_PAST_MINS() * ppm) + 'px';

  container.innerHTML = '';
  container.appendChild(table);
  container.appendChild(nowLine);
}

// Render all channels into the single EPG panel
function renderGuide() {
  const wrap    = document.getElementById('epgScrollWrap');
  const chColW  = 130;
  const totalW  = wrap.clientWidth || window.innerWidth;
  const wStart  = Date.now() - MINI_PAST_MINS() * 60000;
  const wEnd    = Date.now() + MINI_FUTURE_MINS() * 60000;
  const winMins = MINI_WIN_MINS();
  const ppm     = Math.max(4, (totalW - chColW) / winMins);
  const timelineW = winMins * ppm;

  renderEPG(wrap, state.channels, {
    wStart, wEnd, ppm, timelineW, chColW,
    tableClass:    'full-epg-table',
    timeRowClass:  null,
    timeCellClass: 'full-time-cell',
    chRowClass:    'full-ch-row',
    progsCellClass:'full-progs-cell',
    nowLineClass:  'full-now-line',
    onSelect: ch => { selectChannel(ch); closeFullEPG(); },
  });
  // Callers are responsible for positioning scroll after render
}

// Cheap 60s tick — only reclassify now/past/future, no DOM rebuild
function tickEPG() {
  const now = Date.now();
  document.getElementById('epgScrollWrap')
    .querySelectorAll('.mini-prog')
    .forEach(el => {
      const start = +el.dataset.start;
      const stop  = +el.dataset.stop;
      el.classList.toggle('now',    start <= now && stop > now);
      el.classList.toggle('past',   stop  <= now);
      el.classList.toggle('future', start >  now);
    });
}

// Fast path: just toggle active class and reposition scroll
function updateGuideActiveRow() {
  const wrap = document.getElementById('epgScrollWrap');
  wrap.querySelectorAll('.full-ch-row').forEach(tr => {
    tr.classList.toggle('active', tr.dataset.channelId === state.currentChannelId);
  });
  // also update ch-name colour (driven by .active on the row)
  scrollGuideToActive();
}

function scrollGuideToActive(targetHeight) {
  const wrap      = document.getElementById('epgScrollWrap');
  const activeRow = wrap.querySelector('.full-ch-row.active');
  if (!activeRow) return;
  const h = targetHeight ?? wrap.clientHeight;
  wrap.scrollTop = Math.max(0, activeRow.offsetTop - h / 2 + activeRow.offsetHeight / 2);
}

function openFullEPG() {
  const panel = document.getElementById('epgPanel');
  panel.classList.add('open');
  renderGuide();
  // Wait for the expand transition to finish, then centre the active row
  panel.addEventListener('transitionend', () => scrollGuideToActive(), { once: true });
}

function closeFullEPG() {
  const panel = document.getElementById('epgPanel');
  panel.classList.remove('open');
  // Wait for the collapse transition to finish, then snap mini strip to active channel
  panel.addEventListener('transitionend', () => scrollGuideToActive(210), { once: true });
}

// ── Clocks ─────────────────────────────────────────────────────────────────
function renderClockShells() {
  const container = document.getElementById('headerClocks');
  container.innerHTML = '';
  container.appendChild(mkClockItem('LOCAL', 'clock-local', true));
  (state.config?.timezones ?? []).forEach(tz =>
    container.appendChild(mkClockItem(tz.label, `clock-${tz.tz.replace(/\//g, '-')}`, false))
  );
}

function mkClockItem(label, id, isLocal) {
  const div = document.createElement('div');
  div.className = 'clock-item' + (isLocal ? ' local' : '');
  div.innerHTML = `<span class="clock-label">${esc(label)}</span><span class="clock-time" id="${id}">--:--:--</span>`;
  return div;
}

function startClocks() {
  tick();
  setInterval(tick, 1000);
}

function tick() {
  const now = new Date();
  const localEl = document.getElementById('clock-local');
  if (localEl) localEl.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  (state.config?.timezones ?? []).forEach(({ tz }) => {
    const el = document.getElementById(`clock-${tz.replace(/\//g, '-')}`);
    if (el) el.textContent = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  });
}

// ── RSS / credits scroller ─────────────────────────────────────────────────
async function loadAllRSS() {
  const feeds = state.config?.rssFeeds ?? [];
  // Render badges immediately
  const badges = document.getElementById('newsBadges');
  if (badges) {
    badges.innerHTML = feeds.map(f =>
      `<div class="news-badge" style="background:${f.color}20;color:${f.color};border:1px solid ${f.color}40">${esc(f.name)}</div>`
    ).join('');
  }

  const results = await Promise.allSettled(feeds.map(f => fetchRSS(f)));
  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      r.value.forEach(item => items.push({ ...item, feedName: feeds[i].name, feedColor: feeds[i].color }));
    }
  });

  renderNewsCredits(items);
}

async function fetchRSS(feed) {
  const r    = await fetch(`/api/rss?url=${encodeURIComponent(feed.url)}`);
  const text = await r.text();
  const doc  = new DOMParser().parseFromString(text, 'application/xml');
  return [...doc.querySelectorAll('item')].slice(0, 20).map(item => ({
    title: item.querySelector('title')?.textContent?.trim() ?? '',
    link:  item.querySelector('link')?.textContent?.trim()  ?? '#',
  })).filter(i => i.title);
}

function renderNewsCredits(items) {
  if (!items.length) return;
  const track = document.getElementById('newsTrack');

  const html = items.map(item =>
    `<div class="news-item">` +
    `<div class="news-item-source" style="color:${item.feedColor}">${esc(item.feedName)}</div>` +
    `<a class="news-item-title" href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a>` +
    `</div>`
  ).join('');

  // Double for seamless loop
  track.innerHTML = html + html;

  // Duration: each item ~8s, min 60s
  const duration = Math.max(60, items.length * 8);
  track.style.setProperty('--credits-duration', duration + 's');
  track.style.animationDuration = duration + 's';
}

// ── Data refresh ───────────────────────────────────────────────────────────
async function refreshChannels() {
  try {
    const text = await fetch('/api/channels').then(r => r.text());
    state.channels = parseM3U(text);
  } catch (e) {
    console.error('Channel refresh failed', e);
  }
}

async function refreshEPGData() {
  try {
    const text = await fetch('/api/xmltv').then(r => r.text());
    state.programmes = parseXMLTV(text);
    const ch = state.channels.find(c => c.id === state.currentChannelId);
    if (ch) updateNowBar(ch);
  } catch (e) {
    console.error('EPG refresh failed', e);
  } finally {
    renderGuide(); // always reposition blocks, whether data updated or not
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Channel change static effect ───────────────────────────────────────────
let _staticRaf = null;

function startStatic() {
  const canvas = document.getElementById('staticCanvas');
  const ctx    = canvas.getContext('2d');
  const W = 160, H = 90;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.transition = 'none';
  canvas.style.opacity    = '1';
  const imgData = ctx.createImageData(W, H);
  function tick() {
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const v    = (Math.random() * 255) | 0;
      const tint = Math.random() > 0.92 ? (Math.random() * 80 | 0) : 0;
      d[i] = v + tint; d[i+1] = v; d[i+2] = v + tint; d[i+3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    _staticRaf = requestAnimationFrame(tick);
  }
  _staticRaf = requestAnimationFrame(tick);
}

function stopStatic() {
  if (_staticRaf) { cancelAnimationFrame(_staticRaf); _staticRaf = null; }
  const canvas = document.getElementById('staticCanvas');
  canvas.style.transition = 'opacity 0.3s ease-out';
  canvas.style.opacity    = '0';
}

// ── Volume & mute ──────────────────────────────────────────────────────────
function initVolume() {
  const video   = document.getElementById('videoPlayer');
  const slider  = document.getElementById('volSlider');
  const muteBtn = document.getElementById('muteBtn');

  function updateIcon() {
    const icon = document.getElementById('volIcon');
    const name = (video.muted || video.volume === 0) ? 'volume-x'
               : video.volume < 0.5               ? 'volume-1'
               :                                    'volume-2';
    icon.setAttribute('data-lucide', name);
    lucide.createIcons({ nodes: [muteBtn] });
  }

  slider.addEventListener('input', () => {
    video.volume = slider.value / 100;
    video.muted  = slider.value == 0;
    updateIcon();
  });

  let premuteVolume = 100;
  muteBtn.addEventListener('click', () => {
    if (!video.muted) premuteVolume = slider.value > 0 ? +slider.value : premuteVolume;
    video.muted = !video.muted;
    if (video.muted) {
      slider.value = 0;
    } else {
      slider.value = premuteVolume;
      video.volume = premuteVolume / 100;
    }
    updateIcon();
  });

  // Start muted — browsers block autoplay with audio
  video.muted   = true;
  video.volume  = 1;
  slider.value  = 0;
  lucide.createIcons();
  updateIcon();
}

// ── Keyboard navigation ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!state.channels.length) return;
  const epgOpen = document.getElementById('epgPanel').classList.contains('open');
  const idx = state.channels.findIndex(c => c.id === state.currentChannelId);
  if (e.key === 'ArrowUp') {
    if (epgOpen) return;
    e.preventDefault();
    const prev = state.channels[(idx - 1 + state.channels.length) % state.channels.length];
    selectChannel(prev);
  } else if (e.key === 'ArrowDown') {
    if (epgOpen) return;
    e.preventDefault();
    const next = state.channels[(idx + 1) % state.channels.length];
    selectChannel(next);
  } else if (e.key === 'm' || e.key === 'M') {
    document.getElementById('muteBtn').click();
  } else if (e.key === 'g' || e.key === 'G') {
    epgOpen ? closeFullEPG() : openFullEPG();
  } else if (e.key === 'Escape') {
    closeFullEPG();
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
