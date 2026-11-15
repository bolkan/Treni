'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  stations: [], live: { generatedAt: null, stations: {} },
  stationId: null, board: 'departures', searchMode: 'station',
  filter: '', favorites: readFavorites(), loaded: false,
  selectedTrain: null, toastTimer: null, requestId: 0
};

function readFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem('treni:favorites') || '[]');
    return Array.isArray(saved) ? saved.filter(id => /^S\d{5}$/.test(id)).slice(0, 40) : [];
  } catch { return []; }
}
function saveFavorites() {
  try { localStorage.setItem('treni:favorites', JSON.stringify(state.favorites)); }
  catch { toast('Il browser non permette di salvare i preferiti.'); }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}
function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim().toUpperCase();
}
function dateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'non disponibile';
  return new Intl.DateTimeFormat('it-IT',{
    timeZone:'Europe/Rome',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'
  }).format(date);
}
function ageMinutes(value) {
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp) ? (Date.now() - stamp)/60000 : Infinity;
}
function snapshotState() {
  if (!state.live?.generatedAt || state.live.status === 'error') return 'error';
  return ageMinutes(state.live.generatedAt) > 40 ? 'stale' : 'fresh';
}
function stationById(id) { return state.stations.find(s => s.id === id); }
function stationData(id) { return state.live?.stations?.[id] || null; }
function isMonitored(id) { return Boolean(stationById(id)?.monitored || stationData(id)); }
function friendly(value) {
  return String(value || '').trim().toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase())
    .replace(/\bS\.m\./gi,'S.M.');
}
function emptyState(title, message, icon = '⌕', action = '') {
  return '<div class="board-empty"><div class="empty-icon" aria-hidden="true">'+icon+'</div>'+
    '<h3>'+escapeHtml(title)+'</h3><p>'+escapeHtml(message)+'</p>'+action+'</div>';
}
function toast(message) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

async function fetchJson(path, requestId) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'v=' + requestId,
    { cache:'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function refreshData(manual = false) {
  const id = ++state.requestId;
  $('#refresh-button')?.classList.add('loading');
  try {
    const results = await Promise.allSettled([
      fetchJson('./data/stations.json', id),fetchJson('./data/live.json', id)
    ]);
    if (id !== state.requestId) return;
    if (results[0].status === 'fulfilled' && Array.isArray(results[0].value.stations)) {
      state.stations = results[0].value.stations.filter(s => /^S\d{5}$/.test(s.id) && s.name)
        .map(s => ({ id:s.id, name:String(s.name), monitored:Boolean(s.monitored) }));
    }
    if (results[1].status === 'fulfilled' && results[1].value.stations) {
      state.live = results[1].value;
    } else if (manual) {
      toast('Impossibile aggiornare il tabellone. Riprova più tardi.');
    }
    state.loaded = true;
    updateHeader();
    render();
    if (manual && results.every(r => r.status === 'fulfilled')) {
      toast('Hai caricato gli ultimi dati pubblicati su GitHub Pages.');
    }
  } catch(error) {
    console.error('Errore nel caricamento dei dati:', error);
    state.loaded = true;
    updateHeader();
    render();
  } finally { $('#refresh-button')?.classList.remove('loading'); }
}
function updateHeader() {
  const freshness = snapshotState();
  const node = $('#header-status');
  if (!node) return;
  const text = freshness === 'fresh' ? (state.live.status === 'partial' ? 'Dati parziali' : 'Dati recenti') :
    freshness === 'stale' ? 'Dati non recenti' : 'Dati non disponibili';
  node.innerHTML = '<span class="status-dot '+freshness+'"></span> '+text;
}
function renderNotice() {
  const notice = $('#notice-bar');
  const freshness = snapshotState();
  if (freshness === 'fresh') {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.textContent = freshness === 'stale'
    ? 'Attenzione: l’ultima acquisizione risale al '+dateTime(state.live.generatedAt)+'. Le informazioni potrebbero essere superate. Controlla sempre i canali ufficiali.'
    : 'I dati ferroviari non sono ancora disponibili. Il catalogo e i preferiti restano utilizzabili; GitHub Actions recupererà gli orari quando la fonte risponderà.';
}
function updateHash() {
  const params = new URLSearchParams();
  if (state.stationId) {
    params.set('stazione',state.stationId);
    params.set('vista',state.board === 'arrivals' ? 'arrivi' : 'partenze');
  }
  history.replaceState(null,'',params.toString() ? '#'+params : location.pathname+location.search);
}
function loadHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const station = hash.get('stazione');
  if (station && /^S\d{5}$/.test(station)) state.stationId = station;
  if (hash.get('vista') === 'arrivi') state.board = 'arrivals';
}
function favoriteHtml() {
  const favorites = state.favorites.map(stationById).filter(Boolean);
  if (!favorites.length) return '';
  return '<div class="favorite-strip" id="favorites-area"><div class="eyebrow">★ Le tue stazioni</div>'+
    '<div class="favorite-list">'+favorites.map(s =>
      '<button class="pill-button" type="button" data-station="'+escapeHtml(s.id)+'">★ '+escapeHtml(friendly(s.name))+' <span aria-hidden="true">↗</span></button>'
    ).join('')+'</div></div>';
}
function monitoredStations() {
  return state.stations.filter(s => s.monitored || stationData(s.id));
}
function renderHome() {
  const stations = monitoredStations();
  const tiles = stations.map(s => {
    const snap = stationData(s.id);
    const valid = snap && (snap.status === 'ok' || snap.status === 'partial') && Array.isArray(snap.departures);
    const count = valid ? (snap.departures?.length || 0) : null;
    const text = count === null ? 'Dati in attesa' : count + ' partenze disponibili';
    return '<button type="button" class="station-tile" data-station="'+escapeHtml(s.id)+'">'+
      '<span class="tile-left"><span class="tile-symbol" aria-hidden="true">⌁</span>'+
      '<span class="tile-title">'+escapeHtml(friendly(s.name))+'</span>'+
      '<span class="tile-caption">'+escapeHtml(text)+'</span></span>'+
      '<span class="tile-arrow" aria-hidden="true">↗</span></button>';
  }).join('');
  const message = stations.length
    ? '<div class="monitor-grid">'+tiles+'</div>'
    : emptyState('Stazioni in preparazione',
      'Il primo aggiornamento non ha ancora recuperato il catalogo. Controlla GitHub Actions e riprova.', '⚑');
  return '<div class="section-heading"><div><span class="eyebrow">SCOPRI LE STAZIONI</span><h2>Stazioni monitorate</h2>'+
    '<p class="section-description">Scegline una per aprire il tabellone degli arrivi e delle partenze.</p></div>'+
    '<span class="subtle">'+stations.length+' disponibili nel monitoraggio</span></div>'+message;
}
function delayInfo(train) {
  if (train.cancelled) return {css:'cancelled',label:'Soppresso'};
  const delay = train.delay;
  if (delay === null || delay === undefined || !Number.isFinite(Number(delay)))
    return {css:'unknown',label:'Non indicato'};
  const n = Number(delay);
  if (n === 0) return {css:'ok',label:train.notDeparted ? '0 min segnalati' : 'In orario'};
  if (n < 0) return {css:'early',label:Math.abs(n)+' min anticipo'};
  return {css:n>=15?'very-late':'late',label:'+'+n+' min'};
}
function boardTrainRow(t, stationId) {
  const delay = delayInfo(t);
  const platform = t.platform || t.platformPlanned || '—';
  const platformType = t.platform ? 'Confermato' : (t.platformPlanned ? 'Previsto' : 'Da assegnare');
  return '<button class="train-row" type="button" data-train="'+escapeHtml(t.number)+
    '" data-source-station="'+escapeHtml(stationId)+'" aria-label="Apri il treno '+escapeHtml(t.number)+'">'+
    '<span class="time-main">'+escapeHtml(t.scheduled || '—')+'</span>'+
    '<span class="destination"><strong>'+escapeHtml(friendly(t.other || t.destination || t.origin || 'Non indicata'))+'</strong>'+
    '<small>'+escapeHtml(t.category || 'Treno')+' · '+escapeHtml(t.number)+'</small></span>'+
    '<span class="train-num">'+escapeHtml(t.category || 'TRENO')+' '+escapeHtml(t.number)+'</span>'+
    '<span class="delay '+delay.css+'">'+escapeHtml(delay.label)+'</span>'+
    '<span class="track">'+escapeHtml(platform)+'<small>'+platformType+'</small></span>'+
    '<span class="row-chevron" aria-hidden="true">›</span></button>';
}
function renderStation() {
  const station = stationById(state.stationId);
  if (!station) return emptyState('Stazione non trovata',
    'Il codice richiesto non è presente nel catalogo. Prova a cercare il nome della stazione.', '⌕',
    '<div class="empty-actions"><button class="outline-button" data-home>Torna all’inizio</button></div>');
  const snap = stationData(station.id);
  const favorite = state.favorites.includes(station.id);
  const base = '<button class="back-button" type="button" data-home>← Tutte le stazioni</button>'+
    '<div class="station-top"><div><span class="eyebrow">TABELLONE STAZIONE</span>'+
    '<h2 class="station-name">'+escapeHtml(friendly(station.name))+'</h2>'+
    '<div class="station-id">Codice '+escapeHtml(station.id)+' · '+(isMonitored(station.id)?'Monitorata':'Non monitorata')+'</div></div>'+
    '<button type="button" class="outline-button '+(favorite?'is-favorite':'')+
    '" data-fav="'+escapeHtml(station.id)+'" aria-label="'+(favorite?'Rimuovi dai':'Aggiungi ai')+' preferiti">'+
    (favorite?'★ Nei preferiti':'☆ Salva stazione')+'</button></div>';
  if (!isMonitored(station.id)) {
    return base + '<div class="alert-panel"><h3>Questa stazione è nel catalogo, ma non è monitorata.</h3>'+
      '<p>Su GitHub Pages possiamo mostrare aggiornamenti solo per le stazioni configurate in '+
      'config/monitor.json. Puoi aggiungerla al repository e attendere il prossimo aggiornamento automatico.</p></div>'+
      '<button class="outline-button" type="button" data-home>Vedi stazioni monitorate</button>';
  }
  if (!snap || snap.status === 'error') {
    return base + '<div class="panel">'+emptyState('Tabellone temporaneamente indisponibile',
      'Non abbiamo ricevuto dati validi per questa stazione. Non significa che non circolino treni. Riprova più tardi.', '◷')+'</div>';
  }
  const label = state.board === 'departures' ? 'Partenze' : 'Arrivi';
  const data = state.board === 'departures' ? snap.departures : snap.arrivals;
  if (!Array.isArray(data)) {
    return base + '<div class="panel">'+emptyState('Questa sezione non è disponibile',
      'Non sono arrivati dati validi per '+label.toLowerCase()+'. Riprova al prossimo aggiornamento.', '◷')+'</div>'+
      '<button class="outline-button" type="button" data-board="'+(state.board === 'arrivals' ? 'departures' : 'arrivals')+'">Prova l’altro tabellone</button>';
  }
  const filter = normalize(state.filter);
  const filtered = data.filter(t =>
    !filter || normalize([t.number,t.other,t.destination,t.origin,t.category].join(' ')).includes(filter));
  const timeText = dateTime(snap.updatedAt || state.live.generatedAt);
  const old = ageMinutes(snap.updatedAt || state.live.generatedAt) > 40;
  const warning = old ? '<div class="alert-panel"><h3>Dati non recenti</h3><p>Questo tabellone non è stato aggiornato recentemente. Non usarlo come informazione live.</p></div>' : '';
  return base + warning + '<div class="panel"><div class="board-toolbar">'+
    '<div class="board-tabs" role="tablist" aria-label="Tipo di tabellone">'+
    '<button type="button" role="tab" class="board-tab '+(state.board==='departures'?'active':'')+
    '" aria-selected="'+(state.board==='departures')+'" data-board="departures">↗ Partenze</button>'+
    '<button type="button" role="tab" class="board-tab '+(state.board==='arrivals'?'active':'')+
    '" aria-selected="'+(state.board==='arrivals')+'" data-board="arrivals">↙ Arrivi</button></div>'+
    '<span class="board-updated"><span class="status-dot '+(old?'stale':'fresh')+'"></span> Acquisizione '+escapeHtml(timeText)+'</span></div>'+
    '<div class="board-summary"><div><h3>'+label+' in stazione</h3>'+
    '<span class="board-count">'+filtered.length+' treni nel tabellone acquisito</span></div>'+
    '<input type="search" class="filter-input" id="board-filter" placeholder="Filtra treno o destinazione…" aria-label="Filtra il tabellone" value="'+escapeHtml(state.filter)+'"></div>'+
    '<div class="board-head"><span>Ora</span><span>'+(state.board==='departures'?'Destinazione':'Provenienza')+
    '</span><span>Treno</span><span>Stato</span><span>Binario</span><span></span></div>'+
    '<div class="board-list">'+(filtered.length ? filtered.map(t=>boardTrainRow(t,station.id)).join('') :
       emptyState(filter ? 'Nessun treno corrispondente' : 'Nessun treno nel tabellone',
       filter?'Prova un altro numero o rimuovi il filtro.':
       'La fonte ha restituito una lista vuota per questa stazione e fascia oraria.','⌕'))+
    '</div></div><p class="disclaimer">Gli orari, i ritardi e i binari possono cambiare. Questo è uno snapshot, non una connessione live. Verifica sempre gli annunci ufficiali.</p>';
}
function render() {
  renderNotice();
  $('#favorites-section').innerHTML = favoriteHtml();
  $('#content-view').innerHTML = state.stationId ? renderStation() : renderHome();
}
function showSuggestions(query) {
  const container = $('#search-suggestions');
  const input = $('#search-input');
  if (state.searchMode !== 'station') { container.hidden = true; return; }
  const clean = normalize(query);
  if (clean.length < 2) { container.hidden=true;input.setAttribute('aria-expanded','false');return; }
  let matches = state.stations.filter(s => normalize(s.name).includes(clean));
  matches.sort((a,b) => {
    const aScore = (isMonitored(a.id)?0:2) + (normalize(a.name).startsWith(clean)?0:1);
    const bScore = (isMonitored(b.id)?0:2) + (normalize(b.name).startsWith(clean)?0:1);
    return aScore-bScore || a.name.localeCompare(b.name,'it');
  });
  container.innerHTML = matches.length ? matches.slice(0,9).map(s =>
    '<button type="button" role="option" class="suggestion" data-station="'+escapeHtml(s.id)+'">'+
    '<span class="suggestion-icon" aria-hidden="true">⌖</span>'+
    '<span class="suggestion-copy"><strong>'+escapeHtml(friendly(s.name))+'</strong>'+
    '<small>'+ (isMonitored(s.id)?'✓ Tabellone disponibile':'Solo catalogo, senza dati live')+'</small></span>'+
    '<span aria-hidden="true">›</span></button>').join('')+
    (matches.length>9?'<div class="suggestion-more">Altre '+(matches.length-9)+' stazioni: precisa la ricerca.</div>':'')
    : '<div class="suggestion-more">Nessuna stazione trovata nel catalogo. Prova un altro nome.</div>';
  container.hidden = false;
  input.setAttribute('aria-expanded','true');
}
function setMode(mode) {
  state.searchMode = mode;
  $$('.search-tab').forEach(b => {
    const active = b.dataset.searchMode === mode;
    b.classList.toggle('active',active);
    b.setAttribute('aria-selected',String(active));
  });
  const input = $('#search-input');
  input.value = '';
  input.placeholder = mode === 'station'?'Es. Catania, Roma Termini, Milano…':'Es. 12980';
  input.inputMode = mode === 'train' ? 'numeric':'search';
  $('#search-label').textContent = mode === 'train'?'Inserisci il numero del treno':'Cerca una stazione o una città';
  $('#search-tip').textContent = mode === 'train'
    ? 'La ricerca copre solo i treni presenti nei tabelloni monitorati'
    : 'Scrivi una città per scegliere tra più stazioni';
  $('#search-suggestions').hidden = true;
  input.setAttribute('aria-expanded','false');
  input.focus();
}
function openStation(id) {
  if (!stationById(id)) { toast('Stazione non disponibile nel catalogo.'); return; }
  state.stationId = id;state.filter='';state.board='departures';
  $('#search-suggestions').hidden=true;
  $('#search-input').setAttribute('aria-expanded','false');
  $('#search-input').value='';
  updateHash();render();
  $('#main-content').scrollIntoView({behavior:'smooth',block:'start'});
}
function allTrainMatches(number) {
  const found = [];
  const num = String(number).replace(/\D/g,'');
  for (const [stationId,snap] of Object.entries(state.live.stations || {})) {
    if (!snap || snap.status === 'error') continue;
    for (const direction of ['departures','arrivals']) {
      for (const t of snap[direction] || []) {
        if (String(t.number)===num) found.push({...t,stationId,direction});
      }
    }
  }
  return found;
}
function openTrain(number, preferredStationId = '') {
  const num = String(number).replace(/\D/g,'');
  if (!/^\d{1,6}$/.test(num)) { toast('Inserisci un numero di treno valido.'); return; }
  const matches = allTrainMatches(num);
  if (!matches.length) {
    const html = '<div class="modal-backdrop" data-backdrop><article class="modal-card" role="dialog" aria-modal="true" aria-label="Treno non disponibile">'+
      '<div class="modal-header"><div><span class="eyebrow">RICERCA TRENO</span><h2>Treno '+escapeHtml(num)+'</h2></div><button class="close-modal" data-close aria-label="Chiudi">×</button></div>'+
      '<div class="modal-body">'+emptyState('Non presente nello snapshot',
      'Non abbiamo trovato questo numero nei tabelloni monitorati. Non significa che il treno non esista.','⌕')+
      '<p class="disclaimer">La ricerca per numero sarà completa solo dopo l’introduzione di un servizio dati interrogabile su richiesta.</p>'+
      '<a class="primary-link" href="'+officialTrainUrl(num)+'" target="_blank" rel="noopener noreferrer">Cerca su ViaggiaTreno ↗</a></div></article></div>';
    $('#modal-root').innerHTML=html;
    $('.close-modal',$('#modal-root'))?.focus();
    return;
  }
  const chosen = matches.find(m=>m.stationId===preferredStationId) || matches[0];
  const delay = delayInfo(chosen);
  const observations = [...new Map(matches.map(m=>[m.stationId+'-'+m.direction,m])).values()];
  const observedHtml = observations.map(m =>
    '<li><strong>'+escapeHtml(friendly(stationById(m.stationId)?.name || m.stationId))+'</strong>'+
    ' · '+(m.direction==='departures'?'Partenza':'Arrivo')+' '+escapeHtml(m.scheduled||'—')+'</li>'
  ).join('');
  const html = '<div class="modal-backdrop" data-backdrop><article class="modal-card" role="dialog" aria-modal="true" aria-labelledby="train-modal-title">'+
    '<div class="modal-header"><div><span class="eyebrow">SCHEDA TRENO · DATI DISPONIBILI</span>'+
    '<h2 id="train-modal-title">'+escapeHtml(chosen.category || 'Treno')+' '+escapeHtml(num)+'</h2>'+
    '<span class="subtle">Informazioni dai tabelloni monitorati</span></div><button class="close-modal" data-close aria-label="Chiudi">×</button></div>'+
    '<div class="modal-body"><div class="detail-route">'+
    '<div><small>Origine</small><strong>'+escapeHtml(friendly(chosen.origin||'Non disponibile'))+'</strong></div><span aria-hidden="true">⟶</span>'+
    '<div><small>Destinazione</small><strong>'+escapeHtml(friendly(chosen.destination||'Non disponibile'))+'</strong></div></div>'+
    '<div class="detail-stats"><div class="detail-stat"><small>Ritardo</small><strong>'+escapeHtml(delay.label)+'</strong></div>'+
    '<div class="detail-stat"><small>Binario</small><strong>'+escapeHtml(chosen.platform||chosen.platformPlanned||'—')+'</strong></div>'+
    '<div class="detail-stat"><small>Ora rilevata</small><strong>'+escapeHtml(chosen.scheduled||'—')+'</strong></div></div>'+
    '<h3 class="detail-title">Presenze nei tabelloni monitorati</h3>'+
    '<ul class="observed-list">'+observedHtml+'</ul>'+
    '<p class="disclaimer">Queste NON sono tutte le fermate del percorso: comprendono soltanto le stazioni monitorate dove il treno compare. Il binario mostrato si riferisce alla prima rilevazione disponibile.</p>'+
    '<a class="primary-link" href="'+officialTrainUrl(num)+'" target="_blank" rel="noopener noreferrer">Apri la scheda ufficiale ↗</a></div></article></div>';
  $('#modal-root').innerHTML=html;
  $('.close-modal',$('#modal-root'))?.focus();
}
function officialTrainUrl(number) {
  return 'https://www.viaggiatreno.it/vt_pax_internet/mobile/numero?numeroTreno='+encodeURIComponent(number);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function submitSearch(event) {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) { toast('Scrivi una stazione, una città o un numero di treno.');return; }
  if (state.searchMode === 'train') { openTrain(query);return; }
  const matches = state.stations.filter(s => normalize(s.name).includes(normalize(query)));
  if (matches.length === 1) openStation(matches[0].id);
  else if (matches.length) { showSuggestions(query);toast('Scegli una stazione dall’elenco.'); }
  else toast('Non ho trovato stazioni con questo nome.');
}

function installEvents() {
  $('#search-form').addEventListener('submit',submitSearch);
  $('#search-input').addEventListener('input',event=>showSuggestions(event.target.value));
  $('#search-input').addEventListener('focus',event=>showSuggestions(event.target.value));
  $('#refresh-button').addEventListener('click',()=>refreshData(true));
  $('#favorites-link').addEventListener('click',()=>{
    if (state.stationId) {state.stationId=null;updateHash();render();}
    const section = $('#favorites-area');
    if (section) section.scrollIntoView({behavior:'smooth',block:'center'});
    else toast('Non hai ancora salvato stazioni preferite.');
  });
  document.addEventListener('click', event => {
    const target = event.target.closest('button,[data-backdrop]');
    if (!target) {
      if (!event.target.closest('#search-panel')) {
        $('#search-suggestions').hidden=true;$('#search-input').setAttribute('aria-expanded','false');
      }
      return;
    }
    if (target.dataset.backdrop !== undefined && event.target===target) {closeModal();return;}
    if (target.hasAttribute('data-close')) {closeModal();return;}
    if (target.dataset.searchMode) {setMode(target.dataset.searchMode);return;}
    if (target.hasAttribute('data-home')) {
      state.stationId=null;state.filter='';updateHash();render();
      $('#main-content').scrollIntoView({behavior:'smooth'});return;
    }
    if (target.dataset.station) {openStation(target.dataset.station);return;}
    if (target.dataset.board) {
      state.board=target.dataset.board;state.filter='';updateHash();render();return;
    }
    if (target.dataset.fav) {
      const id = target.dataset.fav;
      state.favorites = state.favorites.includes(id)
        ? state.favorites.filter(v=>v!==id):[...state.favorites,id];
      saveFavorites();render();return;
    }
    if (target.dataset.train) {openTrain(target.dataset.train,target.dataset.sourceStation);return;}
  });
  document.addEventListener('input',event=>{
    if (event.target.id==='board-filter') {
      state.filter=event.target.value;
      // Ridisegna soltanto le righe per non perdere il focus durante la digitazione.
      const st=stationData(state.stationId);
      const list=state.board==='departures'?st?.departures:st?.arrivals;
      const filter=normalize(state.filter);
      const filtered=(list||[]).filter(t=>!filter||
        normalize([t.number,t.other,t.destination,t.origin,t.category].join(' ')).includes(filter));
      $('.board-list').innerHTML=filtered.length
        ? filtered.map(t=>boardTrainRow(t,state.stationId)).join('')
        : emptyState('Nessun risultato','Prova a modificare il filtro.');
      $('.board-count').textContent=filtered.length+' treni nel tabellone acquisito';
    }
  });
  document.addEventListener('keydown',event=>{
    if (event.key==='Escape') {
      closeModal();$('#search-suggestions').hidden=true;
      $('#search-input').setAttribute('aria-expanded','false');
    }
  });
}
loadHash();
installEvents();
refreshData();
