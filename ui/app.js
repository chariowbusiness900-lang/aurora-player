/* ===== Aurora Player - app.js ===== */
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

let settings = null;
let tracks = [];
let ignored = [];
let stats = { favorites: {}, playlists: {}, playCount: {}, lastPlayed: [] };
let queue = [];
let queuePos = -1;
let shuffle = false;
let repeat = false;
let currentView = 'home';
let searchQuery = '';

const $ = (id) => document.getElementById(id);
const audio = $('audio');

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function toast(msg, ms) {
  ms = ms || 2600;
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function saveStats() { invoke('save_stats', { stats }); }
function isFav(id) { return !!stats.favorites[id]; }

function applyTheme() {
  const pref = settings.theme || 'system';
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings && settings.theme === 'system') applyTheme();
});

function hex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function lum(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function mix(a, b, t) { return Math.round(a + (b - a) * t); }

function applyAdaptiveColors(imgUrl) {
  const root = document.documentElement.style;
  const reset = () => {
    root.removeProperty('--accent');
    root.removeProperty('--accent-soft');
    root.removeProperty('--bg');
    root.removeProperty('--surface');
  };
  if (!settings.adaptive_colors || !imgUrl) { reset(); return; }
  const img = new Image();
  img.onload = () => {
    try {
      const c = $('palette-canvas');
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 24, 24);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      let best = null, bestScore = -1, ar = 0, ag = 0, ab = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        ar += r; ag += g; ab += b; n++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        const score = sat * 1.6 + (mx / 255) * 0.4;
        if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      }
      ar = Math.round(ar / n); ag = Math.round(ag / n); ab = Math.round(ab / n);
      const dark = document.body.classList.contains('dark');
      let r = best[0], g = best[1], b = best[2];
      const L = lum(r, g, b);
      if (L < 0.25) { r = mix(r, 255, .35); g = mix(g, 255, .35); b = mix(b, 255, .35); }
      if (L > 0.8) { r = mix(r, 0, .3); g = mix(g, 0, .3); b = mix(b, 0, .3); }
      root.setProperty('--accent', hex(r, g, b));
      root.setProperty('--accent-soft', dark ? 'rgba(' + r + ',' + g + ',' + b + ',.22)' : 'rgba(' + r + ',' + g + ',' + b + ',.16)');
      root.setProperty('--bg', dark
        ? hex(mix(32, ar, .08), mix(32, ag, .08), mix(32, ab, .08))
        : hex(mix(243, ar, .05), mix(243, ag, .05), mix(243, ab, .05)));
      root.setProperty('--surface', dark
        ? 'rgba(' + mix(32, ar, .10) + ',' + mix(32, ag, .10) + ',' + mix(32, ab, .10) + ',.78)'
        : 'rgba(' + mix(255, ar, .05) + ',' + mix(255, ag, .05) + ',' + mix(255, ab, .05) + ',.72)');
    } catch (e) { /* ignore */ }
  };
  img.src = imgUrl;
}

const coverCache = new Map();
async function coverUrl(id) {
  if (coverCache.has(id)) return coverCache.get(id);
  const url = await invoke('get_cover', { id }).catch(() => null);
  coverCache.set(id, url);
  return url;
}

function switchView(v) {
  currentView = v;
  document.body.dataset.view = v;
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  const el = $('view-' + v);
  if (el) el.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === v));
  render();
}

function trackRowHtml(t, i, list) {
  const playing = queue[queuePos] && queue[queuePos].id === t.id;
  const fav = isFav(t.id);
  return '<div class="track-row ' + (playing ? 'playing' : '') + '" data-id="' + t.id + '" data-list="' + list + '" data-i="' + i + '">' +
    '<img data-cover="' + t.id + '" alt="" />' +
    '<div><div class="tr-title">' + esc(t.title) + '</div><div class="tr-sub">' + esc(t.artist) + '</div></div>' +
    '<div class="tr-album">' + esc(t.album) + '</div>' +
    '<button class="tr-fav ' + (fav ? 'on' : '') + '" data-fav="' + t.id + '">' + (fav ? '\u2665' : '\u2661') + '</button>' +
    '<div class="tr-dur">' + fmtTime(t.duration_secs) + '</div>' +
  '</div>';
}

function hydrateCovers(container) {
  container.querySelectorAll('img[data-cover]').forEach(async img => {
    const url = await coverUrl(img.dataset.cover);
    if (url) img.src = url;
  });
}

function bindTrackRows(container, list) {
  container.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.dataset.fav) return;
      playFromList(list, parseInt(row.dataset.i, 10));
    });
    row.addEventListener('contextmenu', () => addToQueue(row.dataset.id));
  });
  container.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(btn.dataset.fav); });
  });
}

function render() {
  const v = currentView;
  if (v === 'search') return renderSearch();
  if (v === 'settings') return renderSettings();
  if (v === 'home') return renderHome();
  if (v === 'tracks') return renderTrackList('view-tracks', 'Titres', tracks, 'all');
  if (v === 'favorites') return renderTrackList('view-favorites', 'Favoris', tracks.filter(t => isFav(t.id)), 'favorites');
  if (v === 'recents') return renderTrackList('view-recents', 'Récents', stats.lastPlayed.map(id => tracks.find(t => t.id === id)).filter(Boolean), 'recents');
  if (v === 'albums') return renderAlbums();
  if (v === 'artists') return renderArtists();
  if (v === 'playlists') return renderPlaylists();
}

function renderTrackList(viewId, title, list, listKey) {
  const el = $(viewId);
  el.innerHTML = '<h1>' + esc(title) + '</h1>' + (list.length
    ? '<div class="track-list">' + list.map((t, i) => trackRowHtml(t, i, listKey)).join('') + '</div>'
    : '<div class="empty">Rien ici pour le moment.</div>');
  hydrateCovers(el);
  bindTrackRows(el, listKey);
}

function renderHome() {
  const el = $('view-home');
  const rec = stats.lastPlayed.slice(0, 6).map(id => tracks.find(t => t.id === id)).filter(Boolean);
  const albumNames = Array.from(new Set(tracks.map(t => t.album))).slice(0, 8);
  el.innerHTML =
    '<div class="hero">' +
      '<h1>Bonjour</h1>' +
      '<p>' + tracks.length + ' titre(s) dans la bibliothèque. Le scan automatique tourne à chaque ouverture.</p>' +
      '<button class="btn ghost" id="hero-rescan">Rescanner maintenant</button>' +
    '</div>' +
    (rec.length ? '<h2>Récemment écoutés</h2><div class="track-list">' + rec.map((t, i) => trackRowHtml(t, i, 'recents')).join('') + '</div>' : '') +
    (albumNames.length ? '<h2>Vos albums</h2><div class="card-grid" id="home-albums"></div>' : '');
  hydrateCovers(el);
  bindTrackRows(el, 'recents');
  $('hero-rescan').addEventListener('click', () => doScan(true));
  const grid = $('home-albums');
  if (grid) {
    grid.innerHTML = albumNames.map(a => {
      const t = tracks.find(x => x.album === a);
      return '<div class="card" data-album="' + esc(a) + '">' +
        (t.has_cover ? '<img data-cover="' + t.id + '" alt="" />' : '<div class="cover-ph">\u25A4</div>') +
        '<div class="c-title">' + esc(a) + '</div>' +
        '<div class="c-sub">' + esc(t.album_artist || t.artist) + '</div>' +
      '</div>';
    }).join('');
    hydrateCovers(grid);
    grid.querySelectorAll('[data-album]').forEach(c => c.addEventListener('click', () => openAlbumDetail(c.dataset.album)));
  }
}

function renderAlbums() {
  const el = $('view-albums');
  const map = new Map();
  tracks.forEach(t => {
    if (!map.has(t.album)) map.set(t.album, { artist: t.album_artist || t.artist, first: t, count: 0 });
    map.get(t.album).count++;
  });
  const albums = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  el.innerHTML = '<h1>Albums</h1>' + (albums.length
    ? '<div class="card-grid">' + albums.map(pair => {
        const name = pair[0], info = pair[1];
        return '<div class="card" data-album="' + esc(name) + '">' +
          (info.first.has_cover ? '<img data-cover="' + info.first.id + '" alt="" />' : '<div class="cover-ph">\u25A4</div>') +
          '<div class="c-title">' + esc(name) + '</div>' +
          '<div class="c-sub">' + esc(info.artist) + ' · ' + info.count + ' titre(s)</div>' +
        '</div>';
      }).join('') + '</div>'
    : '<div class="empty">Aucun album. Ajoutez des dossiers dans les Paramètres.</div>');
  hydrateCovers(el);
  el.querySelectorAll('[data-album]').forEach(c => c.addEventListener('click', () => openAlbumDetail(c.dataset.album)));
}

function renderArtists() {
  const el = $('view-artists');
  const map = new Map();
  tracks.forEach(t => {
    const a = t.album_artist || t.artist;
    map.set(a, (map.get(a) || 0) + 1);
  });
  const artists = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  el.innerHTML = '<h1>Artistes</h1>' + (artists.length
    ? '<div class="card-grid">' + artists.map(pair =>
        '<div class="card" data-artist="' + esc(pair[0]) + '">' +
          '<div class="cover-ph">\u263A</div>' +
          '<div class="c-title">' + esc(pair[0]) + '</div>' +
          '<div class="c-sub">' + pair[1] + ' titre(s)</div>' +
        '</div>').join('') + '</div>'
    : '<div class="empty">Aucun artiste.</div>');
  el.querySelectorAll('[data-artist]').forEach(c => c.addEventListener('click', () => openArtistDetail(c.dataset.artist)));
}

function renderPlaylists() {
  const el = $('view-playlists');
  const names = Object.keys(stats.playlists);
  el.innerHTML = '<h1>Playlists</h1>' +
    '<button class="btn" id="pl-new" style="margin-bottom:16px">+ Nouvelle playlist</button>' +
    (names.length ? names.map(n =>
      '<div class="settings-block">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<strong>' + esc(n) + '</strong>' +
          '<div>' +
            '<button class="btn ghost" data-pl-play="' + esc(n) + '">\u25B6 Lire</button>' +
            '<button class="btn ghost" data-pl-del="' + esc(n) + '" style="color:#e81123">Supprimer</button>' +
          '</div>' +
        '</div>' +
        '<div class="track-list" style="margin-top:10px">' +
          (stats.playlists[n] || []).map((id, i) => {
            const t = tracks.find(x => x.id === id);
            return t ? trackRowHtml(t, i, 'pl:' + n) : '';
          }).join('') +
        '</div>' +
      '</div>').join('')
    : '<div class="empty">Créez votre première playlist.</div>');
  $('pl-new').addEventListener('click', () => {
    const name = prompt('Nom de la playlist :');
    if (name && !stats.playlists[name]) { stats.playlists[name] = []; saveStats(); render(); }
  });
  el.querySelectorAll('[data-pl-play]').forEach(b => b.addEventListener('click', () => {
    const ids = stats.playlists[b.dataset.plPlay] || [];
    const list = ids.map(id => tracks.find(t => t.id === id)).filter(Boolean);
    if (list.length) { setQueue(list, 0); play(); }
  }));
  el.querySelectorAll('[data-pl-del]').forEach(b => b.addEventListener('click', () => {
    delete stats.playlists[b.dataset.plDel]; saveStats(); render();
  }));
  hydrateCovers(el);
}

function renderSearch() {
  const el = $('view-search');
  const q = searchQuery.toLowerCase();
  const res = tracks.filter(t =>
    t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q) || t.genre.toLowerCase().includes(q));
  el.innerHTML = '<h1>Résultats pour « ' + esc(searchQuery) + ' »</h1>' + (res.length
    ? '<div class="track-list">' + res.map((t, i) => trackRowHtml(t, i, 'search')).join('') + '</div>'
    : '<div class="empty">Aucun résultat.</div>');
  hydrateCovers(el);
  bindTrackRows(el, 'search');
}

function openAlbumDetail(album) {
  const list = tracks.filter(t => t.album === album);
  const el = $('view-albums');
  el.innerHTML = '<button class="btn ghost" id="back-albums" style="margin-bottom:16px">\u2190 Albums</button>' +
    '<h1>' + esc(album) + '</h1>' +
    '<button class="btn" id="play-album" style="margin-bottom:16px">\u25B6 Lire l\'album</button>' +
    '<div class="track-list">' + list.map((t, i) => trackRowHtml(t, i, 'album')).join('') + '</div>';
  switchView('albums');
  $('back-albums').addEventListener('click', renderAlbums);
  $('play-album').addEventListener('click', () => { setQueue(list, 0); play(); });
  hydrateCovers(el);
  bindTrackRows(el, 'album');
}

function openArtistDetail(artist) {
  const list = tracks.filter(t => (t.album_artist || t.artist) === artist);
  const el = $('view-artists');
  el.innerHTML = '<button class="btn ghost" id="back-artists" style="margin-bottom:16px">\u2190 Artistes</button>' +
    '<h1>' + esc(artist) + '</h1>' +
    '<button class="btn" id="play-artist" style="margin-bottom:16px">\u25B6 Lire</button>' +
    '<div class="track-list">' + list.map((t, i) => trackRowHtml(t, i, 'artist')).join('') + '</div>';
  switchView('artists');
  $('back-artists').addEventListener('click', renderArtists);
  $('play-artist').addEventListener('click', () => { setQueue(list, 0); play(); });
  hydrateCovers(el);
  bindTrackRows(el, 'artist');
}

function listByKey(key) {
  if (key === 'all') return tracks;
  if (key === 'favorites') return tracks.filter(t => isFav(t.id));
  if (key.indexOf('pl:') === 0) return (stats.playlists[key.slice(3)] || []).map(id => tracks.find(t => t.id === id)).filter(Boolean);
  return null;
}

async function renderSettings() {
  const el = $('view-settings');
  settings = await invoke('get_settings');
  const musicDir = await invoke('get_music_dir').catch(() => null);
  el.innerHTML =
    '<h1>Paramètres</h1>' +
    '<div class="settings-block">' +
      '<h2>Dossiers à scanner</h2>' +
      '<div id="folders">' +
        (settings.folders.map(f => '<div class="folder-row"><span class="f-path">' + esc(f) + '</span><button class="btn ghost" data-rm-folder="' + esc(f) + '">Retirer</button></div>').join('') || '<div class="empty">Aucun dossier suivi.</div>') +
      '</div>' +
      '<div style="display:flex;gap:10px;margin-top:12px">' +
        '<button class="btn" id="add-folder">+ Ajouter un dossier</button>' +
        (musicDir && settings.folders.indexOf(musicDir) < 0 ? '<button class="btn ghost" id="add-music">Utiliser « Musique »</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="settings-block">' +
      '<h2>Filtres de scan</h2>' +
      '<div class="setting-line"><span>Durée minimale (secondes)</span><input type="number" id="set-mindur" min="0" value="' + settings.min_duration_secs + '" /></div>' +
      '<div class="setting-line"><span>Taille minimale (Ko)</span><input type="number" id="set-minsize" min="0" value="' + Math.round(settings.min_size_bytes / 1024) + '" /></div>' +
      '<p style="color:var(--text-2);font-size:12.5px;margin-top:6px">Par défaut : 60 s et 100 Ko, pour écarter les notes vocales, sons système et fichiers corrompus.</p>' +
    '</div>' +
    '<div class="settings-block">' +
      '<h2>Apparence</h2>' +
      '<div class="setting-line"><span>Thème</span>' +
        '<select id="set-theme">' +
          '<option value="system"' + (settings.theme === 'system' ? ' selected' : '') + '>Système</option>' +
          '<option value="light"' + (settings.theme === 'light' ? ' selected' : '') + '>Clair</option>' +
          '<option value="dark"' + (settings.theme === 'dark' ? ' selected' : '') + '>Sombre</option>' +
        '</select>' +
      '</div>' +
      '<div class="setting-line"><span>Couleurs adaptatives (pochette)</span>' +
        '<select id="set-adaptive">' +
          '<option value="1"' + (settings.adaptive_colors ? ' selected' : '') + '>Activées</option>' +
          '<option value="0"' + (!settings.adaptive_colors ? ' selected' : '') + '>Désactivées</option>' +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="settings-block">' +
      '<h2>Fichiers ignorés (' + ignored.length + ')</h2>' +
      (ignored.slice(0, 50).map(i => '<div class="ignored-row"><span class="i-path">' + esc(i.path) + '</span><span class="i-reason">' + esc(i.reason) + '</span></div>').join('') || '<div class="empty">Aucun fichier ignoré.</div>') +
      (ignored.length > 50 ? '<p style="color:var(--text-2);font-size:12px">…et ' + (ignored.length - 50) + ' autres.</p>' : '') +
    '</div>' +
    '<div class="settings-block">' +
      '<h2>Bibliothèque</h2>' +
      '<div style="display:flex;gap:10px"><button class="btn" id="rescan-now">Rescanner maintenant</button></div>' +
      '<p style="color:var(--text-2);font-size:12.5px;margin-top:10px">Aurora Player v0.1.0 · fichiers locaux (MP3, FLAC, M4A, OGG, WAV)</p>' +
    '</div>';

  $('add-folder').addEventListener('click', async () => {
    const folder = await invoke('pick_folder').catch(() => null);
    if (folder && settings.folders.indexOf(folder) < 0) {
      settings.folders.push(folder);
      await invoke('save_settings', { settings });
      doScan(true);
      renderSettings();
    }
  });
  const am = $('add-music');
  if (am) am.addEventListener('click', async () => {
    settings.folders.push(musicDir);
    await invoke('save_settings', { settings });
    doScan(true);
    renderSettings();
  });
  el.querySelectorAll('[data-rm-folder]').forEach(b => b.addEventListener('click', async () => {
    settings.folders = settings.folders.filter(f => f !== b.dataset.rmFolder);
    await invoke('save_settings', { settings });
    doScan(true);
    renderSettings();
  }));
  $('set-mindur').addEventListener('change', async (e) => {
    settings.min_duration_secs = Math.max(0, parseInt(e.target.value) || 0);
    await invoke('save_settings', { settings });
    doScan(true);
  });
  $('set-minsize').addEventListener('change', async (e) => {
    settings.min_size_bytes = Math.max(0, parseInt(e.target.value) || 0) * 1024;
    await invoke('save_settings', { settings });
    doScan(true);
  });
  $('set-theme').addEventListener('change', async (e) => {
    settings.theme = e.target.value;
    await invoke('save_settings', { settings });
    applyTheme();
  });
  $('set-adaptive').addEventListener('change', async (e) => {
    settings.adaptive_colors = e.target.value === '1';
    await invoke('save_settings', { settings });
    const cur = queue[queuePos];
    applyAdaptiveColors(cur ? coverCache.get(cur.id) : null);
  });
  $('rescan-now').addEventListener('click', () => doScan(true));
}

async function doScan(notify) {
  const res = await invoke('scan_library');
  tracks = res.tracks;
  ignored = res.ignored;
  if (notify) toast('Scan terminé : ' + res.added + ' ajouté(s), ' + res.removed + ' retiré(s).');
  if (currentView === 'settings') renderSettings();
  else render();
}

function setQueue(list, pos) {
  queue = list.slice();
  queuePos = pos;
  renderQueue();
}

function playFromList(listKey, index) {
  let list;
  if (listKey === 'album' || listKey === 'artist' || listKey === 'search') {
    const rows = Array.from(document.querySelectorAll('.track-row[data-list="' + listKey + '"]'));
    list = rows.map(r => tracks.find(t => t.id === r.dataset.id)).filter(Boolean);
  } else {
    list = listByKey(listKey) || tracks;
  }
  const row = document.querySelector('.track-row[data-list="' + listKey + '"][data-i="' + index + '"]');
  const id = row ? row.dataset.id : (list[index] || {}).id;
  const pos = list.findIndex(t => t.id === id);
  if (pos < 0) return;
  setQueue(list, pos);
  play();
}

async function play() {
  const t = queue[queuePos];
  if (!t) return;
  audio.src = window.__TAURI__.core.convertFileSrc(t.path);
  audio.play();
  $('pb-title').textContent = t.title;
  $('pb-artist').textContent = t.artist + ' · ' + t.album;
  $('pb-play').textContent = '\u23F8';
  const url = await coverUrl(t.id);
  $('pb-cover').src = url || '';
  applyAdaptiveColors(url);
  stats.playCount[t.id] = (stats.playCount[t.id] || 0) + 1;
  stats.lastPlayed = [t.id].concat(stats.lastPlayed.filter(x => x !== t.id)).slice(0, 50);
  saveStats();
  updateFavButton();
  markPlayingRows();
  renderQueue();
}

function markPlayingRows() {
  const cur = queue[queuePos];
  document.querySelectorAll('.track-row').forEach(r =>
    r.classList.toggle('playing', cur && r.dataset.id === cur.id));
}

function togglePlay() {
  if (!queue[queuePos]) { if (tracks.length) { setQueue(tracks, 0); play(); } return; }
  if (audio.paused) { audio.play(); $('pb-play').textContent = '\u23F8'; }
  else { audio.pause(); $('pb-play').textContent = '\u25B6'; }
}

function next() {
  if (!queue.length) return;
  if (shuffle) queuePos = Math.floor(Math.random() * queue.length);
  else queuePos = (queuePos + 1) % queue.length;
  play();
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  queuePos = (queuePos - 1 + queue.length) % queue.length;
  play();
}

function toggleFav(id) {
  if (stats.favorites[id]) delete stats.favorites[id];
  else stats.favorites[id] = true;
  saveStats();
  updateFavButton();
  render();
}

function updateFavButton() {
  const cur = queue[queuePos];
  const on = cur && isFav(cur.id);
  $('pb-fav').textContent = on ? '\u2665' : '\u2661';
  $('pb-fav').classList.toggle('on', !!on);
}

function addToQueue(id) {
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  if (queuePos < 0) { setQueue([t], 0); play(); return; }
  queue.splice(queuePos + 1, 0, t);
  renderQueue();
  toast('« ' + t.title + ' » ajouté à la file d\'attente.');
}

function renderQueue() {
  const el = $('queue-list');
  el.innerHTML = queue.map((t, i) =>
    '<div class="queue-item ' + (i === queuePos ? 'playing' : '') + '" data-q="' + i + '">' +
      '<span class="q-idx">' + (i + 1) + '</span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.title) + '</span>' +
      '<span style="color:var(--text-2)">' + fmtTime(t.duration_secs) + '</span>' +
    '</div>').join('') || '<div class="empty">File vide.</div>';
  el.querySelectorAll('[data-q]').forEach(item => item.addEventListener('click', () => {
    queuePos = parseInt(item.dataset.q, 10);
    play();
  }));
}

function initUI() {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.nav)));

  $('search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    if (searchQuery) switchView('search');
    else if (currentView === 'search') switchView('home');
  });

  $('win-min').addEventListener('click', () => appWindow.minimize());
  $('win-max').addEventListener('click', () => appWindow.toggleMaximize());
  $('win-close').addEventListener('click', () => appWindow.close());
  $('titlebar').addEventListener('mousedown', (e) => {
    if (e.target.closest('input,button')) return;
    appWindow.startDragging();
  });
  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('input,button')) return;
    appWindow.toggleMaximize();
  });

  $('pb-play').addEventListener('click', togglePlay);
  $('pb-next').addEventListener('click', next);
  $('pb-prev').addEventListener('click', prev);
  $('pb-fav').addEventListener('click', () => { const c = queue[queuePos]; if (c) toggleFav(c.id); });
  $('pb-shuffle').addEventListener('click', () => { shuffle = !shuffle; $('pb-shuffle').classList.toggle('on', shuffle); });
  $('pb-repeat').addEventListener('click', () => { repeat = !repeat; $('pb-repeat').classList.toggle('on', repeat); });
  $('pb-queue').addEventListener('click', () => {
    $('queue-panel').classList.toggle('hidden');
    $('pb-queue').classList.toggle('on');
  });
  $('queue-close').addEventListener('click', () => $('queue-panel').classList.add('hidden'));

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    $('pb-range').value = Math.round((audio.currentTime / audio.duration) * 1000);
    $('pb-cur').textContent = fmtTime(audio.currentTime);
    $('pb-dur').textContent = fmtTime(audio.duration);
  });
  $('pb-range').addEventListener('input', (e) => {
    if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
  });
  audio.addEventListener('ended', () => {
    const last = queuePos === queue.length - 1;
    if (repeat && last) { audio.currentTime = 0; audio.play(); return; }
    next();
  });
  $('pb-vol').addEventListener('input', (e) => { audio.volume = e.target.value / 100; });
  audio.volume = 0.9;

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight' && e.ctrlKey) next();
    if (e.code === 'ArrowLeft' && e.ctrlKey) prev();
  });
}

async function boot() {
  settings = await invoke('get_settings');
  applyTheme();
  initUI();
  switchView('home');
  await doScan(false);
  if (tracks.length === 0 && settings.folders.length === 0) {
    const musicDir = await invoke('get_music_dir').catch(() => null);
    if (musicDir) {
      settings.folders.push(musicDir);
      await invoke('save_settings', { settings });
      await doScan(false);
      toast('Dossier « Musique » ajouté automatiquement.');
    }
  }
  if (tracks.length === 0) {
    const p = $('view-home').querySelector('.hero p');
    if (p) p.textContent = 'Ajoutez vos dossiers de musique dans les Paramètres pour commencer.';
  }
  setInterval(() => doScan(false), 5 * 60 * 1000);
}

boot().catch(err => {
  document.body.innerHTML = '<pre style="padding:20px;color:#e81123">' + esc(String(err)) + '</pre>';
});
