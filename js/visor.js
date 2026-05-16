'use strict';
/* ============================================================
   Visor de Enfermedades v2 — Grupo Palmicultor
   ============================================================ */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Colores / íconos por enfermedad ───────────────────────────
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

// ── Estado ────────────────────────────────────────────────────
let MAP = null;
let mapLayers = { trackDots:[], markers:[], start:null, end:null };
let currentSession = null;
let currentRegistros = [];
let currentTrack = [];
let allSessions = [];
let filteredSessions = [];

// Timer
let timerInterval = null;
let timerIdx = 0;
let timerSpeed = 5; // puntos por tick
let timerPlaying = false;
let timerEvents = []; // eventos ordenados por tiempo

// Resumen
let resumenData = null;

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
  mapLayers.trackDots.forEach(d => MAP.removeLayer(d)); mapLayers.trackDots = [];
  mapLayers.markers.forEach(m => MAP.removeLayer(m));   mapLayers.markers   = [];
  if (mapLayers.start) { MAP.removeLayer(mapLayers.start); mapLayers.start = null; }
  if (mapLayers.end)   { MAP.removeLayer(mapLayers.end);   mapLayers.end   = null; }
}

function addTrackPoint(p, idx, total) {
  if (!p.lat || !p.lng) return null;
  const isFirst = idx === 0;
  const isLast  = idx === total - 1;
  let dot;
  if (isFirst) {
    dot = L.circleMarker([p.lat, p.lng], {
      radius:8, fillColor:'#1b4332', color:'#fff', weight:2, fillOpacity:1
    }).bindPopup('Inicio de recorrido').addTo(MAP);
  } else if (isLast) {
    dot = L.circleMarker([p.lat, p.lng], {
      radius:8, fillColor:'#e63946', color:'#fff', weight:2, fillOpacity:1
    }).bindPopup('Fin de recorrido').addTo(MAP);
  } else {
    dot = L.circleMarker([p.lat, p.lng], {
      radius:3, fillColor:'#40916c', color:'#40916c', weight:1, fillOpacity:0.7
    }).bindPopup(`Track · ${p.ts||''} · ±${p.acc||'?'}m`).addTo(MAP);
  }
  return dot;
}

function addDiseaseMarker(r) {
  if (!r.lat || !r.lng) return null;
  const color = ENF_COLOR[r.enfermedad] || '#6b7c74';
  return L.circleMarker([r.lat, r.lng], {
    radius:10, fillColor:color, color:'#fff', weight:2, fillOpacity:0.92
  }).bindPopup(`<b>${esc(r.enfermedad)}</b>${r.nota?'<br><em>'+esc(r.nota)+'</em>':''}<br><small>${r.fecha} ${r.hora} · ±${r.accuracy||'?'}m</small>`)
    .addTo(MAP);
}

// ── Timer / reproducción ──────────────────────────────────────
function buildTimerEvents(track, registros) {
  const evts = [];
  track.forEach((p, i) => { if (p.lat&&p.lng) evts.push({ type:'track', data:p, idx:i, total:track.length }); });
  registros.forEach(r => { if (r.lat&&r.lng) evts.push({ type:'reg', data:r }); });
  evts.sort((a,b) => {
    const ta = a.type==='track' ? (a.data.ts||'') : (a.data.timestamp||a.data.fecha+'T'+a.data.hora||'');
    const tb = b.type==='track' ? (b.data.ts||'') : (b.data.timestamp||b.data.fecha+'T'+b.data.hora||'');
    return ta.localeCompare(tb);
  });
  return evts;
}

function timerInit(track, registros) {
  timerStop();
  clearMapLayers();
  timerEvents = buildTimerEvents(track, registros);
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
        const dot = addTrackPoint(ev.data, ev.idx, ev.total);
        if (dot) mapLayers.trackDots.push(dot);
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
  timerIdx = 0;
  updateTimerUI();
}

function timerShowAll() {
  timerStop();
  clearMapLayers();
  timerIdx = timerEvents.length;
  const bounds = [];
  currentTrack.forEach((p, i) => {
    const dot = addTrackPoint(p, i, currentTrack.length);
    if (dot) { mapLayers.trackDots.push(dot); if (p.lat&&p.lng) bounds.push([p.lat,p.lng]); }
  });
  currentRegistros.forEach(r => {
    const m = addDiseaseMarker(r);
    if (m) { mapLayers.markers.push(m); if (r.lat&&r.lng) bounds.push([r.lat,r.lng]); }
  });
  if (bounds.length) MAP.fitBounds(bounds, { padding:[30,30] });
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

// ── Filtros ───────────────────────────────────────────────────
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
    if (empresa  && s.empresa !== empresa)      return false;
    if (fechaIni && s.fecha < fechaIni)         return false;
    if (fechaFin && s.fecha > fechaFin)         return false;
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

  allSessions       = Object.values(map).sort((a,b)=>(b.fecha+b.hora).localeCompare(a.fecha+a.hora));
  filteredSessions  = [...allSessions];
  renderSessionList();
  updateGlobalStats(filteredSessions);
}

function renderSessionList() {
  const list = $('session-list');
  if (!filteredSessions.length) { list.innerHTML='<div class="empty-msg">Sin resultados</div>'; return; }
  list.innerHTML = filteredSessions.map(s => {
    const chips = Object.entries(s.enfs).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([e,n]) => `<span class="enf-chip" style="background:${ENF_COLOR[e]||'#6b7c74'}22;color:${ENF_COLOR[e]||'#6b7c74'};border-color:${ENF_COLOR[e]||'#6b7c74'}55">${ENF_ICON[e]||'⚫'} ${n}</span>`).join('');
    return `
      <div class="session-card ${currentSession===s.sesion_id?'active':''}" onclick="selectSession('${s.sesion_id}')">
        <div class="sess-header">
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

async function selectSession(sesionId) {
  timerStop();
  currentSession = sesionId;
  renderSessionList();

  show('detail-panel'); hide('detail-empty');
  $('detail-nombre').textContent  = '...';
  $('detail-empresa').textContent = '';
  $('detail-fecha').textContent   = '';
  $('detail-total').textContent   = '';
  $('detail-enfs').innerHTML      = '<div class="loading-sm">Cargando...</div>';
  clearMapLayers();
  timerReset();

  const [regRes, trackRes] = await Promise.all([
    sb.from('censo_registros').select('*').eq('sesion_id', sesionId).order('hora'),
    sb.from('censo_track').select('lat,lng,ts,acc').eq('sesion_id', sesionId).order('ts')
  ]);

  currentRegistros = regRes.data   || [];
  currentTrack     = trackRes.data || [];
  const s = allSessions.find(x => x.sesion_id === sesionId);

  if (s) {
    $('detail-nombre').textContent  = s.nombre || '—';
    $('detail-empresa').textContent = `${s.empresa||''} › ${s.finca||''} › Lote ${s.lote||''}`;
    $('detail-fecha').textContent   = `${formatFecha(s.fecha)} · ${s.hora||''}`;
    $('detail-total').textContent   = `${currentRegistros.length} plantas · ${currentTrack.length} pts GPS`;
  }

  // Desglose enfermedades
  const counts = {};
  currentRegistros.forEach(r => { counts[r.enfermedad] = (counts[r.enfermedad]||0)+1; });
  const total = currentRegistros.length || 1;
  $('detail-enfs').innerHTML = Object.entries(counts).sort((a,b)=>b[1]-a[1])
    .map(([e,n]) => `
      <div class="detail-enf-row">
        <div class="detail-enf-dot" style="background:${ENF_COLOR[e]||'#6b7c74'}"></div>
        <div class="detail-enf-name">${esc(e)}</div>
        <div class="detail-enf-count">${n}</div>
        <div class="detail-enf-bar"><div class="detail-enf-fill" style="width:${Math.round(n/total*100)}%;background:${ENF_COLOR[e]||'#6b7c74'}"></div></div>
      </div>`).join('');

  // Inicializar timer (no reproduce, solo prepara)
  timerInit(currentTrack, currentRegistros);
  // Mostrar todo directo
  timerShowAll();
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
  await Promise.all([
    sb.from('censo_registros').delete().eq('sesion_id', _delSesion),
    sb.from('censo_track').delete().eq('sesion_id', _delSesion)
  ]);
  _delSesion = null;
  if (currentSession === _delSesion) {
    currentSession = null; clearMapLayers(); timerStop();
    hide('detail-panel'); show('detail-empty');
  }
  showLoading(false);
  await loadSessions();
});

// ── Excel export ──────────────────────────────────────────────
function exportExcel() {
  if (!currentRegistros.length) { alert('Seleccione una sesión primero'); return; }
  const s = allSessions.find(x => x.sesion_id === currentSession);
  const rows = currentRegistros.map(r => ({
    '#':          r.local_id || r.id,
    'Fecha':      r.fecha,
    'Hora':       r.hora,
    'Operario':   r.nombre,
    'Empresa':    r.empresa,
    'Finca':      r.finca,
    'Lote':       r.lote,
    'Enfermedad': r.enfermedad,
    'Nota':       r.nota||'',
    'Latitud':    r.lat,
    'Longitud':   r.lng,
    'Precisión m':r.accuracy
  }));
  const ws  = XLSX.utils.json_to_sheet(rows);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Registros');

  // Track sheet
  if (currentTrack.length) {
    const trackRows = currentTrack.map(p => ({
      'Timestamp':p.ts, 'Latitud':p.lat, 'Longitud':p.lng, 'Precisión m':p.acc
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trackRows), 'Track GPS');
  }

  const fname = s ? `censo_${s.finca}_lote${s.lote}_${s.fecha}.xlsx`.replace(/\s+/g,'_') : 'censo.xlsx';
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
let chartEnf = null, chartFinca = null;

async function loadResumen() {
  if (resumenData) { renderResumen(); return; }
  $('resumen-content').innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const [regRes, lotesRes] = await Promise.all([
    sb.from('censo_registros').select('empresa,finca,lote,enfermedad'),
    sb.from('lotes').select('empresa,finca,nombre,palmas')
  ]);

  resumenData = { registros: regRes.data||[], lotes: lotesRes.data||[] };
  renderResumen();
}

function renderResumen() {
  const { registros, lotes } = resumenData;

  // ── Totales globales ──
  const totalCasos = registros.length;
  const totalPalmas = lotes.reduce((s,l)=>s+(l.palmas||0),0);

  // ── Por enfermedad ──
  const porEnf = {};
  ENFERMEDADES.forEach(e => { porEnf[e]=0; });
  registros.forEach(r => { if(porEnf[r.enfermedad]!==undefined) porEnf[r.enfermedad]++; else porEnf['Otras']++; });

  // ── Por finca/lote ──
  const porLote = {};
  registros.forEach(r => {
    const k = `${r.empresa}||${r.finca}||${r.lote}`;
    if (!porLote[k]) porLote[k] = { empresa:r.empresa, finca:r.finca, lote:r.lote, total:0, enfs:{} };
    porLote[k].total++;
    porLote[k].enfs[r.enfermedad] = (porLote[k].enfs[r.enfermedad]||0)+1;
  });

  // Joinear con lotes para palmas
  const lotesMap = {};
  lotes.forEach(l => { lotesMap[`${l.empresa}||${l.finca}||${l.nombre}`]=l.palmas||0; });

  const filas = Object.values(porLote).map(f => ({
    ...f,
    palmas: lotesMap[`${f.empresa}||${f.finca}||${f.lote}`] || 0
  })).sort((a,b)=>b.total-a.total);

  // ── Render HTML ──
  $('resumen-content').innerHTML = `
    <div class="res-kpis">
      <div class="res-kpi"><div class="res-kpi-val">${totalCasos}</div><div class="res-kpi-label">Casos totales</div></div>
      <div class="res-kpi"><div class="res-kpi-val">${totalPalmas.toLocaleString('es-CO')}</div><div class="res-kpi-label">Palmas sembradas</div></div>
      <div class="res-kpi"><div class="res-kpi-val">${totalPalmas?((totalCasos/totalPalmas)*100).toFixed(2)+'%':'—'}</div><div class="res-kpi-label">% Afectación global</div></div>
      <div class="res-kpi"><div class="res-kpi-val">${lotes.length}</div><div class="res-kpi-label">Lotes censados</div></div>
    </div>

    <div class="res-charts-row">
      <div class="res-chart-box">
        <div class="res-section-title">Casos por enfermedad</div>
        <canvas id="chart-enf" height="220"></canvas>
      </div>
      <div class="res-chart-box">
        <div class="res-section-title">Top 10 fincas por casos</div>
        <canvas id="chart-finca" height="220"></canvas>
      </div>
    </div>

    <div class="res-section-title" style="margin:20px 20px 10px">Detalle por Finca / Lote</div>
    <div class="res-table-wrap">
      <table class="res-table">
        <thead>
          <tr>
            <th>Empresa</th><th>Finca</th><th>Lote</th>
            <th>Palmas</th><th>Casos</th><th>% Afectación</th>
            ${ENFERMEDADES.map(e=>`<th>${e}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${filas.map(f => {
            const pct = f.palmas ? ((f.total/f.palmas)*100).toFixed(2) : '—';
            const pctNum = f.palmas ? f.total/f.palmas : 0;
            const pctColor = pctNum>0.05 ? '#e63946' : pctNum>0.02 ? '#f4a261' : '#40916c';
            return `<tr>
              <td>${esc(f.empresa)}</td>
              <td>${esc(f.finca)}</td>
              <td>${esc(f.lote)}</td>
              <td>${f.palmas.toLocaleString('es-CO')}</td>
              <td><strong>${f.total}</strong></td>
              <td><span class="pct-badge" style="background:${pctColor}22;color:${pctColor};border-color:${pctColor}44">${pct}${f.palmas?'%':''}</span></td>
              ${ENFERMEDADES.map(e=>`<td>${f.enfs[e]||0}</td>`).join('')}
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr class="res-total-row">
            <td colspan="3"><strong>TOTAL</strong></td>
            <td>${totalPalmas.toLocaleString('es-CO')}</td>
            <td><strong>${totalCasos}</strong></td>
            <td>${totalPalmas?((totalCasos/totalPalmas)*100).toFixed(2)+'%':'—'}</td>
            ${ENFERMEDADES.map(e=>`<td>${porEnf[e]||0}</td>`).join('')}
          </tr>
        </tfoot>
      </table>
    </div>`;

  // ── Gráficas Chart.js ──
  if (chartEnf)   { chartEnf.destroy();   chartEnf   = null; }
  if (chartFinca) { chartFinca.destroy(); chartFinca = null; }

  // Doughnut enfermedades
  const enfLabels = ENFERMEDADES.filter(e=>porEnf[e]>0);
  const enfVals   = enfLabels.map(e=>porEnf[e]);
  const enfColors = enfLabels.map(e=>ENF_COLOR[e]||'#6b7c74');
  chartEnf = new Chart($('chart-enf'), {
    type:'doughnut',
    data:{ labels:enfLabels, datasets:[{ data:enfVals, backgroundColor:enfColors, borderWidth:2, borderColor:'#fff' }] },
    options:{ plugins:{ legend:{ position:'bottom', labels:{ font:{ size:11 } } } }, cutout:'55%' }
  });

  // Bar top fincas
  const topFincas = filas.slice(0,10);
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
function formatFecha(f) {
  if (!f) return '—';
  const [y,m,d] = f.split('-');
  return `${d}/${m}/${y}`;
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
