'use strict';
/* ============================================================
   Visor de Enfermedades — Grupo Palmicultor
   ============================================================ */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Colores por enfermedad ────────────────────────────────────
const ENF_COLOR = {
  'Anillo Rojo':      '#e63946',
  'PC':               '#f4a261',
  'Marchitez Letal':  '#9b2226',
  'Pudrición Seca':   '#8b5e3c',
  'Pudrición Húmeda': '#4361ee',
  'Otras':            '#6b7c74'
};

const ENF_ICON = {
  'Anillo Rojo':      '🔴',
  'PC':               '🟠',
  'Marchitez Letal':  '🟤',
  'Pudrición Seca':   '🟫',
  'Pudrición Húmeda': '🔵',
  'Otras':            '⚪'
};

// ── Estado global ─────────────────────────────────────────────
let MAP = null;
let mapLayers = { track: null, markers: [], start: null, end: null };
let currentSession = null;
let allSessions = [];
let filteredSessions = [];

// ── Utilidades DOM ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function show(id)  { $(id).classList.remove('hidden'); }
function hide(id)  { $(id).classList.add('hidden'); }
function setTxt(id, v) { $(id).textContent = v; }

// ── Auth ──────────────────────────────────────────────────────
async function login() {
  const email    = $('login-email').value.trim();
  const password = $('login-pass').value;
  const btn      = $('login-btn');
  const err      = $('login-error');

  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Ingresando...';

  const { error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Ingresar';

  if (error) {
    err.textContent = 'Credenciales incorrectas. Intente nuevamente.';
    return;
  }
  showApp();
}

async function logout() {
  await sb.auth.signOut();
  showLogin();
}

function showLogin() {
  hide('app');
  show('login-screen');
  $('login-email').value = '';
  $('login-pass').value = '';
  $('login-error').textContent = '';
}

async function showApp() {
  hide('login-screen');
  show('app');
  initMap();
  await loadFilters();
  await loadSessions();
}

// ── Mapa ──────────────────────────────────────────────────────
function initMap() {
  if (MAP) return;
  MAP = L.map('map', { zoomControl: true }).setView([4.5, -74.0], 7);

  const streets  = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 20
  });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri',
    maxZoom: 20
  });

  streets.addTo(MAP);
  L.control.layers({ 'Calles': streets, 'Satélite': satellite }).addTo(MAP);
}

function clearMapLayers() {
  if (mapLayers.track)  { MAP.removeLayer(mapLayers.track);  mapLayers.track = null; }
  if (mapLayers.start)  { MAP.removeLayer(mapLayers.start);  mapLayers.start = null; }
  if (mapLayers.end)    { MAP.removeLayer(mapLayers.end);    mapLayers.end = null; }
  mapLayers.markers.forEach(m => MAP.removeLayer(m));
  mapLayers.markers = [];
}

function drawSession(track, registros) {
  clearMapLayers();

  const bounds = [];

  // Track GPS
  if (track.length > 1) {
    const pts = track
      .filter(p => p.lat && p.lng)
      .map(p => [p.lat, p.lng]);

    if (pts.length > 1) {
      mapLayers.track = L.polyline(pts, {
        color: '#40916c', weight: 3, opacity: 0.8
      }).addTo(MAP);
      pts.forEach(p => bounds.push(p));

      // Punto inicio
      mapLayers.start = L.circleMarker(pts[0], {
        radius: 8, fillColor: '#1b4332', color: '#fff',
        weight: 2, fillOpacity: 1
      }).bindPopup('Inicio de recorrido').addTo(MAP);

      // Punto fin
      mapLayers.end = L.circleMarker(pts[pts.length - 1], {
        radius: 8, fillColor: '#e63946', color: '#fff',
        weight: 2, fillOpacity: 1
      }).bindPopup('Fin de recorrido').addTo(MAP);
    }
  }

  // Marcadores de enfermedades
  registros.filter(r => r.lat && r.lng).forEach(r => {
    const color = ENF_COLOR[r.enfermedad] || '#6b7c74';
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 9, fillColor: color, color: '#fff',
      weight: 2, fillOpacity: 0.9
    }).bindPopup(`
      <div style="min-width:160px">
        <strong>${esc(r.enfermedad)}</strong><br>
        ${r.nota ? '<em>' + esc(r.nota) + '</em><br>' : ''}
        <small>${r.fecha} ${r.hora}</small><br>
        <small>±${r.accuracy ? r.accuracy + 'm' : '--'}</small>
      </div>
    `).addTo(MAP);
    mapLayers.markers.push(marker);
    bounds.push([r.lat, r.lng]);
  });

  if (bounds.length > 0) {
    MAP.fitBounds(bounds, { padding: [30, 30] });
    setTimeout(() => MAP.invalidateSize(), 100);
  }
}

// ── Filtros ───────────────────────────────────────────────────
async function loadFilters() {
  const { data } = await sb.from('censo_registros').select('empresa').order('empresa');
  if (!data) return;
  const empresas = [...new Set(data.map(r => r.empresa).filter(Boolean))].sort();
  const sel = $('filter-empresa');
  sel.innerHTML = '<option value="">Todas las empresas</option>';
  empresas.forEach(e => {
    const o = document.createElement('option');
    o.value = e; o.textContent = e;
    sel.appendChild(o);
  });
}

function applyFilters() {
  const empresa   = $('filter-empresa').value;
  const fechaIni  = $('filter-fecha-ini').value;
  const fechaFin  = $('filter-fecha-fin').value;
  const texto     = $('filter-texto').value.trim().toLowerCase();

  filteredSessions = allSessions.filter(s => {
    if (empresa  && s.empresa !== empresa) return false;
    if (fechaIni && s.fecha < fechaIni)    return false;
    if (fechaFin && s.fecha > fechaFin)    return false;
    if (texto && !(
      (s.nombre||'').toLowerCase().includes(texto) ||
      (s.finca||'').toLowerCase().includes(texto)  ||
      (s.lote||'').toLowerCase().includes(texto)
    )) return false;
    return true;
  });

  renderSessionList();
  updateStats(filteredSessions);
}

// ── Sesiones ──────────────────────────────────────────────────
async function loadSessions() {
  showLoading(true);

  const { data, error } = await sb
    .from('censo_registros')
    .select('sesion_id, nombre, empresa, finca, lote, fecha, hora, enfermedad')
    .order('fecha', { ascending: false })
    .order('hora',  { ascending: false });

  showLoading(false);

  if (error || !data) {
    $('session-list').innerHTML = '<div class="empty-msg">Error cargando datos</div>';
    return;
  }

  // Agrupar por sesion_id
  const map = {};
  data.forEach(r => {
    if (!map[r.sesion_id]) {
      map[r.sesion_id] = {
        sesion_id: r.sesion_id,
        nombre:    r.nombre,
        empresa:   r.empresa,
        finca:     r.finca,
        lote:      r.lote,
        fecha:     r.fecha,
        hora:      r.hora,
        total:     0,
        enfs:      {}
      };
    }
    map[r.sesion_id].total++;
    map[r.sesion_id].enfs[r.enfermedad] = (map[r.sesion_id].enfs[r.enfermedad] || 0) + 1;
  });

  allSessions = Object.values(map).sort((a, b) =>
    (b.fecha + b.hora).localeCompare(a.fecha + a.hora)
  );
  filteredSessions = [...allSessions];

  renderSessionList();
  updateStats(filteredSessions);
  setTxt('total-sesiones', allSessions.length);
}

function renderSessionList() {
  const list = $('session-list');

  if (filteredSessions.length === 0) {
    list.innerHTML = '<div class="empty-msg">Sin resultados</div>';
    return;
  }

  list.innerHTML = filteredSessions.map(s => {
    const chips = Object.entries(s.enfs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([e, n]) => `<span class="enf-chip" style="background:${ENF_COLOR[e]||'#6b7c74'}22;color:${ENF_COLOR[e]||'#6b7c74'};border-color:${ENF_COLOR[e]||'#6b7c74'}44">${ENF_ICON[e]||'⚫'} ${n}</span>`)
      .join('');

    return `
      <div class="session-card ${currentSession === s.sesion_id ? 'active' : ''}"
           onclick="selectSession('${s.sesion_id}')">
        <div class="sess-header">
          <span class="sess-fecha">${formatFecha(s.fecha)}</span>
          <span class="sess-total">${s.total} plantas</span>
        </div>
        <div class="sess-nombre">${esc(s.nombre || '—')}</div>
        <div class="sess-lugar">${esc(s.empresa || '')} › ${esc(s.finca || '')} › Lote ${esc(s.lote || '')}</div>
        <div class="sess-chips">${chips}</div>
      </div>`;
  }).join('');
}

async function selectSession(sesionId) {
  currentSession = sesionId;
  renderSessionList(); // resaltar activo

  // Marcar loading en panel derecho
  $('detail-panel').classList.remove('hidden');
  $('detail-nombre').textContent = '...';
  $('detail-empresa').textContent = '';
  $('detail-fecha').textContent   = '';
  $('detail-total').textContent   = '';
  $('detail-enfs').innerHTML = '<div class="loading-sm">Cargando...</div>';
  clearMapLayers();

  // Cargar datos en paralelo
  const [regRes, trackRes] = await Promise.all([
    sb.from('censo_registros')
      .select('*')
      .eq('sesion_id', sesionId)
      .order('hora'),
    sb.from('censo_track')
      .select('lat, lng, ts, acc')
      .eq('sesion_id', sesionId)
      .order('ts')
  ]);

  const registros = regRes.data || [];
  const track     = trackRes.data || [];
  const s = allSessions.find(x => x.sesion_id === sesionId);

  // Panel detalle
  if (s) {
    $('detail-nombre').textContent  = s.nombre  || '—';
    $('detail-empresa').textContent = `${s.empresa || ''} › ${s.finca || ''} › Lote ${s.lote || ''}`;
    $('detail-fecha').textContent   = `${formatFecha(s.fecha)} · ${s.hora || ''}`;
    $('detail-total').textContent   = `${registros.length} plantas registradas`;
  }

  // Desglose de enfermedades
  const counts = {};
  registros.forEach(r => { counts[r.enfermedad] = (counts[r.enfermedad] || 0) + 1; });
  $('detail-enfs').innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `
      <div class="detail-enf-row">
        <div class="detail-enf-dot" style="background:${ENF_COLOR[e]||'#6b7c74'}"></div>
        <div class="detail-enf-name">${esc(e)}</div>
        <div class="detail-enf-count">${n}</div>
        <div class="detail-enf-bar">
          <div class="detail-enf-fill" style="width:${Math.round(n/registros.length*100)}%;background:${ENF_COLOR[e]||'#6b7c74'}"></div>
        </div>
      </div>`)
    .join('');

  // Mapa
  drawSession(track, registros);
}

function updateStats(sessions) {
  setTxt('total-sesiones', sessions.length);
  const total = sessions.reduce((s, x) => s + x.total, 0);
  setTxt('total-plantas', total);

  const enfs = {};
  sessions.forEach(s => Object.entries(s.enfs).forEach(([e, n]) => {
    enfs[e] = (enfs[e] || 0) + n;
  }));
  const top = Object.entries(enfs).sort((a, b) => b[1] - a[1])[0];
  setTxt('top-enfermedad', top ? `${ENF_ICON[top[0]]||''} ${top[0]}` : '—');
}

// ── Helpers ───────────────────────────────────────────────────
function formatFecha(f) {
  if (!f) return '—';
  const [y, m, d] = f.split('-');
  return `${d}/${m}/${y}`;
}

function showLoading(on) {
  on ? show('loading-overlay') : hide('loading-overlay');
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    showApp();
  } else {
    showLogin();
  }

  // Enter en campo contraseña
  $('login-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
  });

  $('login-btn').addEventListener('click', login);
  $('btn-logout').addEventListener('click', logout);

  $('filter-empresa').addEventListener('change', applyFilters);
  $('filter-fecha-ini').addEventListener('change', applyFilters);
  $('filter-fecha-fin').addEventListener('change', applyFilters);
  $('filter-texto').addEventListener('input',  applyFilters);
  $('btn-limpiar').addEventListener('click', () => {
    $('filter-empresa').value   = '';
    $('filter-fecha-ini').value = '';
    $('filter-fecha-fin').value = '';
    $('filter-texto').value     = '';
    applyFilters();
  });
})();
