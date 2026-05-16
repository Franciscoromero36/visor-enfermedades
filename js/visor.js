'use strict';
/* ============================================================
   Visor de Enfermedades v3 — Grupo Palmicultor
   ============================================================ */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const ENF_COLOR = {
  'Anillo Rojo':      '#e63946',
  'PC':               '#f4a261',
  'Marchitez Letal':  '#9b2226',
  'Pudrición Seca':   '#8b5e3c',
  'Pudrición Húmeda': '#4361ee',
  'Otras':            '#6b7c74'
};
const ENF_ICON = {
  'Anillo Rojo':'🔴','PC':'🟠','Marchitez Letal':'🟤',
  'Pudrición Seca':'🟫','Pudrición Húmeda':'🔵','Otras':'⚫'
};
const ENFERMEDADES = Object.keys(ENF_COLOR);
const SESSION_COLORS = ['#40916c','#e63946','#4361ee','#f4a261','#9b2226','#06d6a0','#fb8500','#8338ec','#023e8a','#8b5e3c'];

// ── Estado ────────────────────────────────────────────────────
let MAP = null;
let mapLayers = { polylines:[], markers:[], starts:[], ends:[] };
let selectedSessions = new Set();
let sessionData = {};       // sesion_id → { registros:[], track:[] }
let allSessions = [];
let filteredSessions = [];

// Timer
let timerInterval = null;
let timerIdx = 0;
let timerSpeed = 5;
let timerPlaying = false;
let timerEvents = [];
let animPolylines = {};     // sid → L.polyline (en animación)
let animPolyPoints = {};    // sid → [[lat,lng],...]

// Resumen
let resumenData = null;
let resumenFilters = { empresa:'', finca:'', lote:'', fechaIni:'', fechaFin:'' };

// ── DOM ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function show(id){ $(id).classList.remove('hidden'); }
function hide(id){ $(id).classList.add('hidden'); }
function setTxt(id,v){ $(id).textContent = v; }

// ── Auth ──────────────────────────────────────────────────────
async function login() {
  const email = $('login-email').value.trim();
  const pass  = $('login-pass').value;
  const btn   = $('login-btn');
  $('login-error').textContent = '';
  btn.disabled = true; btn.textContent = 'Ingresando...';
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'Ingresar';
  if (error) { $('login-error').textContent = 'Credenciales incorrectas.'; return; }
  showApp();
}

async function logout() {
  timerStop();
  await sb.auth.signOut();
  showLogin();
}

function showLogin() {
  hide('app'); show('login-screen');
  $('login-email').value = '';
  $('login-pass').value  = '';
}

async function showApp() {
  hide('login-screen'); show('app');
  initMap();
  await loadFilters();
  await loadSessions();
  switchTab('tab-mapa');
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== tabId));
  if (tabId === 'tab-resumen') loadResumen();
  if (tabId === 'tab-mapa' && MAP) setTimeout(() => MAP.invalidateSize(), 50);
}

// ── Mapa ──────────────────────────────────────────────────────
function initMap() {
  if (MAP) return;
  MAP = L.map('map', { zoomControl: true }).setView([4.5, -74.0], 7);
  const streets   = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution:'© OpenStreetMap', maxZoom:20 });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution:'© Esri', maxZoom:20 });
  streets.addTo(MAP);
  L.control.layers({'Calles':streets,'Satélite':satellite}).addTo(MAP);
}

function clearMapLayers() {
  mapLayers.polylines.forEach(l => MAP.removeLayer(l)); mapLayers.polylines = [];
  mapLayers.markers.forEach(m => MAP.removeLayer(m));   mapLayers.markers   = [];
  mapLayers.starts.forEach(m => MAP.removeLayer(m));    mapLayers.starts    = [];
  mapLayers.ends.forEach(m => MAP.removeLayer(m));      mapLayers.ends      = [];
  animPolylines = {};
  animPolyPoints = {};
}

function getSessionColor(sid) {
  const ids = [...selectedSessions];
  const idx = ids.indexOf(sid);
  return SESSION_COLORS[idx >= 0 ? idx % SESSION_COLORS.length : 0];
}

function addTrackPolyline(track, color) {
  const pts = track.filter(p => p.lat && p.lng).map(p => [p.lat, p.lng]);
  if (pts.length < 2) return null;
  const poly = L.polyline(pts, { color, weight:3, opacity:0.85 }).addTo(MAP);
  mapLayers.polylines.push(poly);
  return poly;
}

function addStartEndMarkers(track) {
  const valid = track.filter(p => p.lat && p.lng);
  if (!valid.length) return;
  const first = valid[0];
  const last  = valid[valid.length - 1];
  const sm = L.circleMarker([first.lat, first.lng], {
    radius:7, fillColor:'#1b4332', color:'#fff', weight:2, fillOpacity:1
  }).bindPopup('Inicio de recorrido').addTo(MAP);
  mapLayers.starts.push(sm);
  if (valid.length > 1) {
    const em = L.circleMarker([last.lat, last.lng], {
      radius:7, fillColor:'#e63946', color:'#fff', weight:2, fillOpacity:1
    }).bindPopup('Fin de recorrido').addTo(MAP);
    mapLayers.ends.push(em);
  }
}

function addDiseaseMarker(r) {
  if (!r.lat || !r.lng) return null;
  const color = ENF_COLOR[r.enfermedad] || '#6b7c74';
  return L.circleMarker([r.lat, r.lng], {
    radius:10, fillColor:color, color:'#fff', weight:2, fillOpacity:0.92
  }).bindPopup(`<b>${esc(r.enfermedad)}</b>${r.nota?'<br><em>'+esc(r.nota)+'</em>':''}<br><small>${r.fecha} ${r.hora} · ±${r.accuracy||'?'}m</small>`)
    .addTo(MAP);
}

function drawAllOnMap() {
  clearMapLayers();
  const bounds = [];
  [...selectedSessions].forEach(sid => {
    const data = sessionData[sid];
    if (!data) return;
    const color = getSessionColor(sid);
    addTrackPolyline(data.track, color);
    addStartEndMarkers(data.track);
    data.track.filter(p => p.lat && p.lng).forEach(p => bounds.push([p.lat, p.lng]));
    data.registros.forEach(r => {
      const m = addDiseaseMarker(r);
      if (m && r.lat && r.lng) bounds.push([r.lat, r.lng]);
    });
  });
  if (bounds.length) MAP.fitBounds(bounds, { padding:[30,30] });
}

// ── Timer / reproducción ──────────────────────────────────────
function buildTimerEvents() {
  const evts = [];
  [...selectedSessions].forEach(sid => {
    const data = sessionData[sid];
    if (!data) return;
    data.track.forEach((p, i) => {
      if (p.lat && p.lng) evts.push({ type:'track', data:p, idx:i, total:data.track.length, sid });
    });
    data.registros.forEach(r => {
      if (r.lat && r.lng) evts.push({ type:'reg', data:r, sid });
    });
  });
  evts.sort((a,b) => {
    const ta = a.type==='track' ? (a.data.ts||'') : (fechaToISO(a.data.fecha)+'T'+(a.data.hora||''));
    const tb = b.type==='track' ? (b.data.ts||'') : (fechaToISO(b.data.fecha)+'T'+(b.data.hora||''));
    return ta.localeCompare(tb);
  });
  return evts;
}

function timerInit() {
  timerStop();
  clearMapLayers();
  timerEvents = buildTimerEvents();
  timerIdx    = 0;
  updateTimerUI();
}

function timerPlay() {
  if (timerPlaying) return;
  timerPlaying = true;
  $('btn-play').textContent = '⏸ Pausar';
  timerInterval = setInterval(() => {
    const steps = timerSpeed;
    for (let i = 0; i < steps && timerIdx < timerEvents.length; i++, timerIdx++) {
      const ev = timerEvents[timerIdx];
      if (ev.type === 'track') {
        if (!animPolylines[ev.sid]) {
          const color = getSessionColor(ev.sid);
          animPolylines[ev.sid]  = L.polyline([], { color, weight:3, opacity:0.85 }).addTo(MAP);
          mapLayers.polylines.push(animPolylines[ev.sid]);
          animPolyPoints[ev.sid] = [];
        }
        animPolyPoints[ev.sid].push([ev.data.lat, ev.data.lng]);
        animPolylines[ev.sid].setLatLngs(animPolyPoints[ev.sid]);
      } else {
        const m = addDiseaseMarker(ev.data);
        if (m) mapLayers.markers.push(m);
      }
    }
    updateTimerUI();
    if (timerIdx >= timerEvents.length) timerStop();
  }, 80);
}

function timerPause() {
  clearInterval(timerInterval);
  timerPlaying = false;
  $('btn-play').textContent = '▶ Reproducir';
}

function timerStop() {
  clearInterval(timerInterval);
  timerPlaying = false;
  if ($('btn-play')) $('btn-play').textContent = '▶ Reproducir';
}

function timerReset() {
  timerStop();
  clearMapLayers();
  timerEvents = buildTimerEvents();
  timerIdx = 0;
  updateTimerUI();
}

function timerShowAll() {
  timerStop();
  timerEvents = buildTimerEvents();
  timerIdx    = timerEvents.length;
  drawAllOnMap();
  updateTimerUI();
}

function updateTimerUI() {
  const total = timerEvents.length;
  const pct   = total ? Math.round(timerIdx / total * 100) : 0;
  $('timer-bar').style.width = pct + '%';
  setTxt('timer-pct', pct + '%');
  const trackDone = timerEvents.slice(0, timerIdx).filter(e => e.type==='track').length;
  const regDone   = timerEvents.slice(0, timerIdx).filter(e => e.type==='reg').length;
  setTxt('timer-track', trackDone + ' pts GPS');
  setTxt('timer-regs',  regDone + ' registros');
  if (timerIdx > 0) {
    const last = timerEvents[timerIdx - 1];
    const ts   = last.type==='track' ? last.data.ts : (last.data.timestamp||'');
    setTxt('timer-time', ts ? ts.slice(11,19) : '');
  } else {
    setTxt('timer-time', '--:--:--');
  }
}

// ── Filtros panel izquierdo ───────────────────────────────────
async function loadFilters() {
  const { data } = await sb.from('censo_registros').select('empresa').order('empresa');
  if (!data) return;
  const empresas = [...new Set(data.map(r=>r.empresa).filter(Boolean))].sort();
  const sel = $('filter-empresa');
  sel.innerHTML = '<option value="">Todas las empresas</option>';
  empresas.forEach(e => {
    const o = document.createElement('option');
    o.value = e; o.textContent = e; sel.appendChild(o);
  });
}

function applyFilters() {
  const empresa  = $('filter-empresa').value;
  const fechaIni = $('filter-fecha-ini').value;
  const fechaFin = $('filter-fecha-fin').value;
  const texto    = $('filter-texto').value.trim().toLowerCase();
  filteredSessions = allSessions.filter(s => {
    if (empresa  && s.empresa !== empresa)               return false;
    if (fechaIni && fechaToISO(s.fecha) < fechaIni)      return false;
    if (fechaFin && fechaToISO(s.fecha) > fechaFin)      return false;
    if (texto && ![(s.nombre||''),(s.finca||''),(s.lote||'')].join(' ').toLowerCase().includes(texto)) return false;
    return true;
  });
  renderSessionList();
  updateGlobalStats(filteredSessions);
}

// ── Sesiones ──────────────────────────────────────────────────
async function loadSessions() {
  showLoading(true);
  const { data, error } = await sb
    .from('censo_registros')
    .select('sesion_id,nombre,empresa,finca,lote,fecha,hora,enfermedad')
    .order('fecha', { ascending:false }).order('hora', { ascending:false });
  showLoading(false);
  if (error || !data) { $('session-list').innerHTML = '<div class="empty-msg">Error cargando datos</div>'; return; }

  const map = {};
  data.forEach(r => {
    if (!map[r.sesion_id]) map[r.sesion_id] = {
      sesion_id:r.sesion_id, nombre:r.nombre, empresa:r.empresa,
      finca:r.finca, lote:r.lote, fecha:r.fecha, hora:r.hora, total:0, enfs:{}
    };
    map[r.sesion_id].total++;
    map[r.sesion_id].enfs[r.enfermedad] = (map[r.sesion_id].enfs[r.enfermedad]||0)+1;
  });

  allSessions      = Object.values(map).sort((a,b)=>(fechaToISO(b.fecha)+b.hora).localeCompare(fechaToISO(a.fecha)+a.hora));
  filteredSessions = [...allSessions];
  renderSessionList();
  updateGlobalStats(filteredSessions);
}

function renderSessionList() {
  const list = $('session-list');
  if (!filteredSessions.length) { list.innerHTML='<div class="empty-msg">Sin resultados</div>'; return; }
  const selIds = [...selectedSessions];
  list.innerHTML = filteredSessions.map(s => {
    const isSelected = selectedSessions.has(s.sesion_id);
    const selIdx     = selIds.indexOf(s.sesion_id);
    const selColor   = isSelected ? SESSION_COLORS[selIdx % SESSION_COLORS.length] : '';
    const chips = Object.entries(s.enfs).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([e,n]) => `<span class="enf-chip" style="background:${ENF_COLOR[e]||'#6b7c74'}22;color:${ENF_COLOR[e]||'#6b7c74'};border-color:${ENF_COLOR[e]||'#6b7c74'}55">${ENF_ICON[e]||'⚫'} ${n}</span>`).join('');
    const borderStyle = isSelected ? `border-color:${selColor};box-shadow:0 0 0 2px ${selColor}44;background:${selColor}11;` : '';
    return `
      <div class="session-card" style="${borderStyle}" onclick="toggleSession('${s.sesion_id}')">
        <div class="sess-header">
          ${isSelected ? `<span class="sess-sel-dot" style="background:${selColor}"></span>` : '<span class="sess-sel-dot" style="background:transparent;border:1.5px dashed #ccc"></span>'}
          <span class="sess-fecha">${formatFecha(s.fecha)}</span>
          <span class="sess-total">${s.total} plantas</span>
          <button class="sess-del" title="Eliminar sesión" onclick="event.stopPropagation();confirmDelete('${s.sesion_id}','${esc(s.finca)} Lote ${esc(s.lote)}')">🗑</button>
        </div>
        <div class="sess-nombre">${esc(s.nombre||'—')}</div>
        <div class="sess-lugar">${esc(s.empresa||'')} › ${esc(s.finca||'')} › Lote ${esc(s.lote||'')}</div>
        <div class="sess-chips">${chips}</div>
      </div>`;
  }).join('');
}

async function toggleSession(sesionId) {
  timerStop();
  if (selectedSessions.has(sesionId)) {
    selectedSessions.delete(sesionId);
  } else {
    selectedSessions.add(sesionId);
  }
  renderSessionList();

  // Cargar datos de sesiones nuevas
  const toLoad = [...selectedSessions].filter(id => !sessionData[id]);
  if (toLoad.length) {
    showLoading(true);
    await Promise.all(toLoad.map(id => loadSessionData(id)));
    showLoading(false);
  }

  updateDetailPanel();
  timerShowAll();
}

async function loadSessionData(sesionId) {
  const [regRes, trackRes] = await Promise.all([
    sb.from('censo_registros').select('*').eq('sesion_id', sesionId).order('hora'),
    sb.from('censo_track').select('lat,lng,ts,acc').eq('sesion_id', sesionId).order('ts')
  ]);
  sessionData[sesionId] = {
    registros: regRes.data   || [],
    track:     trackRes.data || []
  };
}

function updateDetailPanel() {
  if (selectedSessions.size === 0) {
    hide('detail-panel'); show('detail-empty');
    return;
  }
  show('detail-panel'); hide('detail-empty');

  let allRegs = [], allTracks = [];
  [...selectedSessions].forEach(sid => {
    const d = sessionData[sid];
    if (!d) return;
    allRegs   = allRegs.concat(d.registros);
    allTracks = allTracks.concat(d.track);
  });

  if (selectedSessions.size === 1) {
    const sid = [...selectedSessions][0];
    const s = allSessions.find(x => x.sesion_id === sid);
    if (s) {
      $('detail-nombre').textContent  = s.nombre || '—';
      $('detail-empresa').textContent = `${s.empresa||''} › ${s.finca||''} › Lote ${s.lote||''}`;
      $('detail-fecha').textContent   = `${formatFecha(s.fecha)} · ${s.hora||''}`;
    }
  } else {
    const sesInfo = [...selectedSessions].map(id => allSessions.find(x => x.sesion_id === id)).filter(Boolean);
    $('detail-nombre').textContent  = `${selectedSessions.size} sesiones seleccionadas`;
    $('detail-empresa').textContent = [...new Set(sesInfo.map(s=>`${s.finca} L${s.lote}`))].join(', ');
    $('detail-fecha').textContent   = '';
  }
  $('detail-total').textContent = `${allRegs.length} plantas · ${allTracks.length} pts GPS`;

  const counts = {};
  allRegs.forEach(r => { counts[r.enfermedad] = (counts[r.enfermedad]||0)+1; });
  const total = allRegs.length || 1;
  $('detail-enfs').innerHTML = Object.entries(counts).sort((a,b)=>b[1]-a[1])
    .map(([e,n]) => `
      <div class="detail-enf-row">
        <div class="detail-enf-dot" style="background:${ENF_COLOR[e]||'#6b7c74'}"></div>
        <div class="detail-enf-name">${esc(e)}</div>
        <div class="detail-enf-count">${n}</div>
        <div class="detail-enf-bar"><div class="detail-enf-fill" style="width:${Math.round(n/total*100)}%;background:${ENF_COLOR[e]||'#6b7c74'}"></div></div>
      </div>`).join('');
}

// ── Eliminar sesión ───────────────────────────────────────────
let _delSesion = null;
function confirmDelete(sesionId, label) {
  _delSesion = sesionId;
  $('del-label').textContent = label;
  show('modal-delete');
}
$('del-cancel').addEventListener('click', () => { hide('modal-delete'); _delSesion = null; });
$('del-ok').addEventListener('click', async () => {
  if (!_delSesion) return;
  hide('modal-delete');
  showLoading(true);
  const deletedId = _delSesion;
  _delSesion = null;
  await Promise.all([
    sb.from('censo_registros').delete().eq('sesion_id', deletedId),
    sb.from('censo_track').delete().eq('sesion_id', deletedId)
  ]);
  selectedSessions.delete(deletedId);
  delete sessionData[deletedId];
  showLoading(false);
  await loadSessions();
  updateDetailPanel();
  if (selectedSessions.size > 0) timerShowAll();
  else { clearMapLayers(); timerStop(); updateTimerUI(); }
});

// ── Excel export ──────────────────────────────────────────────
function exportExcel() {
  if (selectedSessions.size === 0) { alert('Seleccione al menos una sesión'); return; }
  const wb = XLSX.utils.book_new();

  // Hoja Registros
  const allRows = [];
  [...selectedSessions].forEach(sid => {
    const data = sessionData[sid];
    if (!data) return;
    const s = allSessions.find(x => x.sesion_id === sid);
    data.registros.forEach(r => {
      allRows.push({
        'Sesión':      sid,
        '#':           r.local_id || r.id,
        'Fecha':       r.fecha,
        'Hora':        r.hora,
        'Operario':    r.nombre,
        'Empresa':     r.empresa,
        'Finca':       r.finca,
        'Lote':        r.lote,
        'Enfermedad':  r.enfermedad,
        'Nota':        r.nota || '',
        'Latitud':     r.lat,
        'Longitud':    r.lng,
        'Precisión m': r.accuracy
      });
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allRows), 'Registros');

  // Hoja Track GPS
  const allTrackRows = [];
  [...selectedSessions].forEach(sid => {
    const data = sessionData[sid];
    if (!data || !data.track.length) return;
    const s = allSessions.find(x => x.sesion_id === sid);
    data.track.forEach(p => {
      allTrackRows.push({
        'Sesión':      sid,
        'Operario':    s ? s.nombre : '',
        'Finca':       s ? s.finca  : '',
        'Lote':        s ? s.lote   : '',
        'Timestamp':   p.ts,
        'Latitud':     p.lat,
        'Longitud':    p.lng,
        'Precisión m': p.acc
      });
    });
  });
  if (allTrackRows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allTrackRows), 'Track GPS');
  }

  const sesInfo = [...selectedSessions].map(id => allSessions.find(x => x.sesion_id === id)).filter(Boolean);
  const fname = sesInfo.length === 1
    ? `censo_${sesInfo[0].finca}_lote${sesInfo[0].lote}_${sesInfo[0].fecha}.xlsx`.replace(/\s+/g,'_')
    : `censo_${sesInfo.length}sesiones_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fname);
}

// ── Stats globales ────────────────────────────────────────────
function updateGlobalStats(sessions) {
  setTxt('total-sesiones', sessions.length);
  const total = sessions.reduce((s,x)=>s+x.total, 0);
  setTxt('total-plantas', total);
  const enfs = {};
  sessions.forEach(s => Object.entries(s.enfs).forEach(([e,n]) => { enfs[e]=(enfs[e]||0)+n; }));
  const top = Object.entries(enfs).sort((a,b)=>b[1]-a[1])[0];
  setTxt('top-enfermedad', top ? `${ENF_ICON[top[0]]||''} ${top[0]}` : '—');
}

// ── Resumen ───────────────────────────────────────────────────
let chartEnf = null, chartFinca = null, chartEnfPct = null;

async function loadResumen() {
  if (!resumenData) {
    $('resumen-content').innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    const [regRes, lotesRes] = await Promise.all([
      sb.from('censo_registros').select('empresa,finca,lote,enfermedad,fecha'),
      sb.from('lotes').select('empresa,finca,nombre,palmas')
    ]);
    resumenData = { registros: regRes.data||[], lotes: lotesRes.data||[] };
  }
  renderResumen();
}

function populateResumenFilters() {
  const { registros } = resumenData;
  const empresas = [...new Set(registros.map(r=>r.empresa).filter(Boolean))].sort();
  const fincas   = [...new Set(registros.map(r=>r.finca).filter(Boolean))].sort();
  const lotes    = [...new Set(registros.map(r=>r.lote).filter(Boolean))].sort();

  const fill = (id, items, allLabel) => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = `<option value="">${allLabel}</option>`;
    items.forEach(v => { const o = document.createElement('option'); o.value=v; o.textContent=v; el.appendChild(o); });
    el.value = prev;
  };
  fill('res-filter-empresa', empresas, 'Todas las empresas');
  fill('res-filter-finca',   fincas,   'Todas las fincas');
  fill('res-filter-lote',    lotes,    'Todos los lotes');
}

function applyResumenFilters() {
  resumenFilters.empresa  = $('res-filter-empresa')   ? $('res-filter-empresa').value   : '';
  resumenFilters.finca    = $('res-filter-finca')      ? $('res-filter-finca').value     : '';
  resumenFilters.lote     = $('res-filter-lote')       ? $('res-filter-lote').value      : '';
  resumenFilters.fechaIni = $('res-filter-fecha-ini')  ? $('res-filter-fecha-ini').value : '';
  resumenFilters.fechaFin = $('res-filter-fecha-fin')  ? $('res-filter-fecha-fin').value : '';
  renderResumen();
}

function limpiarResumenFiltros() {
  resumenFilters = { empresa:'', finca:'', lote:'', fechaIni:'', fechaFin:'' };
  ['res-filter-empresa','res-filter-finca','res-filter-lote','res-filter-fecha-ini','res-filter-fecha-fin']
    .forEach(id => { if ($(id)) $(id).value = ''; });
  renderResumen();
}

function renderResumen() {
  const { registros: allReg, lotes } = resumenData;
  const f = resumenFilters;

  const registros = allReg.filter(r => {
    if (f.empresa && r.empresa !== f.empresa) return false;
    if (f.finca   && r.finca   !== f.finca)   return false;
    if (f.lote    && r.lote    !== f.lote)     return false;
    if (f.fechaIni && fechaToISO(r.fecha) < f.fechaIni) return false;
    if (f.fechaFin && fechaToISO(r.fecha) > f.fechaFin) return false;
    return true;
  });

  const lotesFiltered = lotes.filter(l => {
    if (f.empresa && l.empresa !== f.empresa) return false;
    if (f.finca   && l.finca   !== f.finca)   return false;
    if (f.lote    && l.nombre  !== f.lote)     return false;
    return true;
  });

  const totalCasos  = registros.length;
  const totalPalmas = lotesFiltered.reduce((s,l)=>s+(l.palmas||0), 0);

  // Por enfermedad global
  const porEnf = {};
  ENFERMEDADES.forEach(e => { porEnf[e]=0; });
  registros.forEach(r => { if (porEnf[r.enfermedad]!==undefined) porEnf[r.enfermedad]++; else porEnf['Otras']++; });

  // Por finca/lote
  const porLote = {};
  registros.forEach(r => {
    const k = `${r.empresa}||${r.finca}||${r.lote}`;
    if (!porLote[k]) porLote[k] = { empresa:r.empresa, finca:r.finca, lote:r.lote, total:0, enfs:{} };
    porLote[k].total++;
    porLote[k].enfs[r.enfermedad] = (porLote[k].enfs[r.enfermedad]||0)+1;
  });

  const lotesMap = {};
  lotes.forEach(l => { lotesMap[`${l.empresa}||${l.finca}||${l.nombre}`] = l.palmas||0; });
  const filas = Object.values(porLote).map(row => ({
    ...row,
    palmas: lotesMap[`${row.empresa}||${row.finca}||${row.lote}`] || 0
  })).sort((a,b) => b.total - a.total);

  // ── HTML ──
  $('resumen-content').innerHTML = `
    <div class="res-filters">
      <select id="res-filter-empresa" onchange="applyResumenFilters()"><option value="">Todas las empresas</option></select>
      <select id="res-filter-finca"   onchange="applyResumenFilters()"><option value="">Todas las fincas</option></select>
      <select id="res-filter-lote"    onchange="applyResumenFilters()"><option value="">Todos los lotes</option></select>
      <input type="date" id="res-filter-fecha-ini" title="Desde" onchange="applyResumenFilters()" />
      <input type="date" id="res-filter-fecha-fin" title="Hasta" onchange="applyResumenFilters()" />
      <button class="btn-limpiar" onclick="limpiarResumenFiltros()">✕ Limpiar</button>
    </div>

    <div class="res-kpis">
      <div class="res-kpi"><div class="res-kpi-val">${totalCasos}</div><div class="res-kpi-label">Casos totales</div></div>
      <div class="res-kpi"><div class="res-kpi-val">${totalPalmas.toLocaleString('es-CO')}</div><div class="res-kpi-label">Palmas sembradas</div></div>
      <div class="res-kpi"><div class="res-kpi-val">${totalPalmas?((totalCasos/totalPalmas)*100).toFixed(2)+'%':'—'}</div><div class="res-kpi-label">% Afectación global</div></div>
      <div class="res-kpi"><div class="res-kpi-val">${lotesFiltered.length}</div><div class="res-kpi-label">Lotes censados</div></div>
    </div>

    <div class="res-charts-row">
      <div class="res-chart-box">
        <div class="res-section-title">Casos por enfermedad</div>
        <canvas id="chart-enf" height="220"></canvas>
      </div>
      <div class="res-chart-box">
        <div class="res-section-title">% Infestación por enfermedad</div>
        <canvas id="chart-enf-pct" height="220"></canvas>
      </div>
    </div>
    <div class="res-charts-row" style="margin-top:0">
      <div class="res-chart-box" style="flex:1">
        <div class="res-section-title">Top 10 fincas / lotes por casos</div>
        <canvas id="chart-finca" height="220"></canvas>
      </div>
    </div>

    <div class="res-section-title" style="margin:20px 20px 10px">Detalle por Finca / Lote</div>
    <div class="res-table-wrap">
      <table class="res-table">
        <thead>
          <tr>
            <th>Empresa</th><th>Finca</th><th>Lote</th>
            <th>Palmas</th><th>Total</th><th>% Total</th>
            ${ENFERMEDADES.map(e=>`<th>${e}</th><th>% ${e}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${filas.map(row => {
            const pctTotal = row.palmas ? ((row.total/row.palmas)*100).toFixed(2) : '—';
            const pctNum   = row.palmas ? row.total/row.palmas : 0;
            const pctColor = pctNum>0.05 ? '#e63946' : pctNum>0.02 ? '#f4a261' : '#40916c';
            return `<tr>
              <td>${esc(row.empresa)}</td>
              <td>${esc(row.finca)}</td>
              <td>${esc(row.lote)}</td>
              <td>${row.palmas.toLocaleString('es-CO')}</td>
              <td><strong>${row.total}</strong></td>
              <td><span class="pct-badge" style="background:${pctColor}22;color:${pctColor};border-color:${pctColor}44">${pctTotal}${row.palmas?'%':''}</span></td>
              ${ENFERMEDADES.map(e => {
                const n  = row.enfs[e] || 0;
                const ep = row.palmas ? ((n/row.palmas)*100).toFixed(2) : '—';
                const ec = !row.palmas ? '#6b7c74' : (n/row.palmas>0.05?'#e63946':n/row.palmas>0.02?'#f4a261':'#40916c');
                return `<td>${n}</td><td><span class="pct-badge" style="background:${ec}22;color:${ec};border-color:${ec}44;font-size:.65rem">${ep}${row.palmas?'%':''}</span></td>`;
              }).join('')}
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr class="res-total-row">
            <td colspan="3"><strong>TOTAL</strong></td>
            <td>${totalPalmas.toLocaleString('es-CO')}</td>
            <td><strong>${totalCasos}</strong></td>
            <td>${totalPalmas?((totalCasos/totalPalmas)*100).toFixed(2)+'%':'—'}</td>
            ${ENFERMEDADES.map(e => {
              const n  = porEnf[e]||0;
              const ep = totalPalmas ? ((n/totalPalmas)*100).toFixed(2)+'%' : '—';
              return `<td>${n}</td><td>${ep}</td>`;
            }).join('')}
          </tr>
        </tfoot>
      </table>
    </div>`;

  // Poblar filtros y restaurar valores
  populateResumenFilters();
  if ($('res-filter-empresa'))   $('res-filter-empresa').value   = resumenFilters.empresa;
  if ($('res-filter-finca'))     $('res-filter-finca').value     = resumenFilters.finca;
  if ($('res-filter-lote'))      $('res-filter-lote').value      = resumenFilters.lote;
  if ($('res-filter-fecha-ini')) $('res-filter-fecha-ini').value = resumenFilters.fechaIni;
  if ($('res-filter-fecha-fin')) $('res-filter-fecha-fin').value = resumenFilters.fechaFin;

  // ── Gráficas ──
  if (chartEnf)    { chartEnf.destroy();    chartEnf    = null; }
  if (chartFinca)  { chartFinca.destroy();  chartFinca  = null; }
  if (chartEnfPct) { chartEnfPct.destroy(); chartEnfPct = null; }

  const enfLabels = ENFERMEDADES.filter(e=>porEnf[e]>0);
  const enfVals   = enfLabels.map(e=>porEnf[e]);
  const enfColors = enfLabels.map(e=>ENF_COLOR[e]||'#6b7c74');

  chartEnf = new Chart($('chart-enf'), {
    type:'doughnut',
    data:{ labels:enfLabels, datasets:[{ data:enfVals, backgroundColor:enfColors, borderWidth:2, borderColor:'#fff' }] },
    options:{ plugins:{ legend:{ position:'bottom', labels:{ font:{ size:11 } } } }, cutout:'55%' }
  });

  const pctVals = enfLabels.map(e => totalPalmas ? (porEnf[e]/totalPalmas)*100 : 0);
  chartEnfPct = new Chart($('chart-enf-pct'), {
    type:'bar',
    data:{ labels:enfLabels, datasets:[{ data:pctVals, backgroundColor:enfColors, borderRadius:4, label:'% Infestación' }] },
    options:{
      plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label: ctx => ctx.parsed.y.toFixed(4)+'%' } } },
      scales:{ y:{ ticks:{ callback: v => v.toFixed(3)+'%' }, grid:{ color:'#eee' } }, x:{ ticks:{ font:{ size:10 } } } }
    }
  });

  const topFincas   = filas.slice(0,10);
  const fincaLabels = topFincas.map(f=>`${f.finca} L${f.lote}`);
  const fincaVals   = topFincas.map(f=>f.total);
  const fincaColors = topFincas.map(f=>{
    const pct = f.palmas ? f.total/f.palmas : 0;
    return pct>0.05 ? '#e63946' : pct>0.02 ? '#f4a261' : '#40916c';
  });
  chartFinca = new Chart($('chart-finca'), {
    type:'bar',
    data:{ labels:fincaLabels, datasets:[{ data:fincaVals, backgroundColor:fincaColors, borderRadius:4 }] },
    options:{
      indexAxis:'y',
      plugins:{ legend:{ display:false } },
      scales:{ x:{ grid:{ color:'#eee' } }, y:{ ticks:{ font:{ size:10 } } } }
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────
function fechaToISO(f) {
  if (!f) return '';
  if (f.includes('-')) return f;
  const [d, m, y] = f.split('/');
  return `${y}-${(m||'').padStart(2,'0')}-${(d||'').padStart(2,'0')}`;
}

function formatFecha(f) {
  if (!f) return '—';
  const iso = fechaToISO(f);
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : f;
}

function showLoading(on) { on ? show('loading-overlay') : hide('loading-overlay'); }

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  const { data:{ session } } = await sb.auth.getSession();
  if (session) showApp(); else showLogin();

  $('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') login(); });
  $('login-btn').addEventListener('click', login);
  $('btn-logout').addEventListener('click', logout);
  $('filter-empresa').addEventListener('change', applyFilters);
  $('filter-fecha-ini').addEventListener('change', applyFilters);
  $('filter-fecha-fin').addEventListener('change', applyFilters);
  $('filter-texto').addEventListener('input', applyFilters);
  $('btn-limpiar').addEventListener('click', () => {
    ['filter-empresa','filter-fecha-ini','filter-fecha-fin','filter-texto'].forEach(id=>$(id).value='');
    applyFilters();
  });
  $('btn-play').addEventListener('click',    () => timerPlaying ? timerPause() : timerPlay());
  $('btn-reset').addEventListener('click',   () => { timerReset(); timerShowAll(); });
  $('timer-speed').addEventListener('input', e => { timerSpeed = +e.target.value; $('speed-label').textContent = e.target.value+'x'; });
  $('btn-export').addEventListener('click',  exportExcel);
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
})();
