// Load the RDF instead of JSON
const DATA_URL = 'Exported Items.rdf';

// Helpers
function nameStr(p) {
  if (!p || typeof p !== 'object') return '';
  const fam = p.family || '';
  const giv = p.given || '';
  const parts = [fam, giv].filter(Boolean);
  return parts.join(', ').trim();
}
function listNames(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(nameStr).filter(Boolean);
}
function uniqueSorted(values) {
  return Array.from(new Set(values.filter(v => v !== undefined && v !== null && v !== '')))
    .sort((a,b) => (''+a).localeCompare(''+b, undefined, {sensitivity:'base'}));
}
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
function extractTokens(label) {
  if (!label) return [];
  const tokens = new Set();
  const add = (t) => {
    const f = fold(t).trim();
    if (f) tokens.add(f);
  };
  add(label);
  const bracketMatches = Array.from(label.matchAll(/\[([^\]]+)\]/g));
  bracketMatches.forEach(m => add(m[1]));
  const base = label.replace(/\[[^\]]*\]/g, ' ');
  const parts = base.split(/[\s,;:/()]+/g).filter(Boolean);
  parts.forEach(add);
  parts.forEach(p => p.split(/[-'’]+/g).forEach(add));
  return Array.from(tokens);
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
function canonicalPlace(s) {
  if (!s) return '';
  const m = s.match(/\[([^\]]+)\]/);
  return (m ? m[1] : s).trim();
}

let RAW = [];
let VIEW = [];
let OPTIONS = {
  authors: [],
  editors: [],
  translators: [],
  languages: [],
  places: [],
  types: [],
  tags: []
};
let TOKENS = {
  authors: new Map(),
  editors: new Map(),
  translators: new Map(),
  languages: new Map(),
  places: new Map(),
  types: new Map(),
  tags: new Map()
};

// Namespaces
const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  z: 'http://www.zotero.org/namespaces/export#',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  bib: 'http://purl.org/net/biblio#',
  foaf: 'http://xmlns.com/foaf/0.1/',
  vcard: 'http://nwalsh.com/rdf/vCard#',
  prism: 'http://prismstandard.org/namespaces/1.2/basic/'
};

function firstEl(node, ns, local) {
  const list = node.getElementsByTagNameNS(ns, local);
  return list && list.length ? list[0] : null;
}
function firstText(node, ns, local) {
  const el = firstEl(node, ns, local);
  return el ? el.textContent.trim() : '';
}
function allEls(node, ns, local) {
  return Array.from(node.getElementsByTagNameNS(ns, local) || []);
}
function getYearFromDateStr(str) {
  if (!str) return null;
  const m = String(str).match(/\b(\d{4})\b/);
  return m ? Number(m[1]) : null;
}
function readPeopleFromContainer(node, containerNS, containerLocal) {
  const container = firstEl(node, containerNS, containerLocal);
  if (!container) return [];
  const persons = container.getElementsByTagNameNS(NS.foaf, 'Person');
  const out = [];
  Array.from(persons).forEach(p => {
    const fam = firstText(p, NS.foaf, 'surname');
    const giv = firstText(p, NS.foaf, 'givenName');
    const label = [fam, giv].filter(Boolean).join(', ').trim();
    if (label) out.push(label);
  });
  return uniqueSorted(out);
}
function readSubjects(node) {
  const subs = Array.from(node.childNodes)
    .filter(n => n.nodeType === 1 && n.namespaceURI === NS.dc && n.localName === 'subject')
    .map(el => el.textContent.trim())
    .filter(Boolean);
  return uniqueSorted(subs);
}
function readPlace(node) {
  const pub = firstEl(node, NS.dc, 'publisher');
  if (!pub) return null;
  const org = firstEl(pub, NS.foaf, 'Organization');
  if (!org) return null;
  const adr = firstEl(org, NS.vcard, 'adr');
  if (!adr) return null;
  const addr = firstEl(adr, NS.vcard, 'Address');
  if (!addr) return null;
  const loc = firstEl(addr, NS.vcard, 'locality');
  return loc ? loc.textContent.trim() : null;
}
function readURL(node) {
  const about = node.getAttributeNS(NS.rdf, 'about') || node.getAttribute('rdf:about') || '';
  if (about && /^(https?:|urn:)/i.test(about)) return about;
  const ident = firstEl(node, NS.dc, 'identifier');
  if (ident) {
    const uri = firstEl(ident, NS.dcterms, 'URI');
    if (uri) {
      const val = firstEl(uri, NS.rdf, 'value');
      if (val) return val.textContent.trim();
    }
  }
  const anyURI = firstEl(node, NS.dcterms, 'URI');
  if (anyURI) {
    const val = firstEl(anyURI, NS.rdf, 'value');
    if (val) return val.textContent.trim();
  }
  return null;
}
function parseRDFItems(xmlDoc) {
  const candidates = [];
  const withItemType = allEls(xmlDoc, NS.z, 'itemType').map(el => el.parentNode).filter((v, i, a) => a.indexOf(v) === i);
  candidates.push(...withItemType);
  ['Article', 'Book', 'BookSection', 'Journal'].forEach(local => {
    candidates.push(...Array.from(xmlDoc.getElementsByTagNameNS(NS.bib, local)));
  });
  const items = Array.from(new Set(candidates));

  const out = [];
  for (const item of items) {
    const localName = (item.localName || '').toLowerCase();
    if (localName === 'memo' || localName === 'attachment') continue;

    const title = firstText(item, NS.dc, 'title');
    if (!title) continue;

    const typeRaw = firstText(item, NS.z, 'itemType') || localName || '';
    const type = String(typeRaw).toLowerCase();

    const authors = readPeopleFromContainer(item, NS.bib, 'authors');
    const editors = readPeopleFromContainer(item, NS.bib, 'editors');
    const translators = readPeopleFromContainer(item, NS.z, 'translators');

    const language = firstText(item, NS.z, 'language') || '';
    const place = readPlace(item);
    const dateStr = firstText(item, NS.dc, 'date') || '';
    const year = getYearFromDateStr(dateStr);

    const url = readURL(item);
    const doi = null;
    const tags = readSubjects(item);

    const key = firstText(item, NS.z, 'citationKey') || item.getAttributeNS(NS.rdf, 'about') || item.getAttribute('rdf:about') || null;

    out.push({
      key,
      type,
      title,
      authors,
      editors,
      translators,
      language,
      place,
      year,
      url,
      doi,
      tags,
      _src: null
    });
  }
  return out;
}

// Load data and initialize
fetch(DATA_URL)
  .then(r => {
    if (!r.ok) throw new Error('Failed to fetch data: ' + r.status);
    return r.text();
  })
  .then(txt => {
    const parser = new DOMParser();
    const xml = parser.parseFromString(txt, 'application/xml');
    const parserError = xml.getElementsByTagName('parsererror')[0];
    if (parserError) throw new Error('Failed to parse RDF');
    RAW = parseRDFItems(xml);
    VIEW = RAW.map(it => ({
      key: it.key || null,
      type: (it.type || '').toLowerCase(),
      title: it.title || '',
      authors: it.authors || [],
      editors: it.editors || [],
      translators: it.translators || [],
      language: it.language || '',
      place: it.place || null,
      year: it.year !== undefined ? it.year : null,
      url: it.url || null,
      doi: it.doi || null,
      tags: it.tags || [],
      _src: it
    }));
    buildFilters(VIEW);
    render(VIEW);
    bindEvents();
    // Map init is deferred until user shows it the first time
  })
  .catch(err => {
    document.getElementById('results').innerHTML = '<div class="card">Error: ' + (err && err.message ? err.message : err) + '</div>';
  });

// Build full option lists from items
function buildFilters(items) {
  const sets = computeOptionSets(items);
  OPTIONS = sets;

  TOKENS.authors = new Map(OPTIONS.authors.map(v => [v, extractTokens(v)]));
  TOKENS.editors = new Map(OPTIONS.editors.map(v => [v, extractTokens(v)]));
  TOKENS.translators = new Map(OPTIONS.translators.map(v => [v, extractTokens(v)]));
  TOKENS.languages = new Map(OPTIONS.languages.map(v => [v, extractTokens(v)]));
  TOKENS.places = new Map(OPTIONS.places.map(v => [v, extractTokens(v)]));
  TOKENS.types = new Map(OPTIONS.types.map(v => [v, extractTokens(v)]));
  TOKENS.tags = new Map(OPTIONS.tags.map(v => [v, extractTokens(v)]));

  filterAndFill('f-authors', OPTIONS.authors, getSearch('s-authors'), 'authors');
  filterAndFill('f-editors', OPTIONS.editors, getSearch('s-editors'), 'editors');
  filterAndFill('f-translators', OPTIONS.translators, getSearch('s-translators'), 'translators');
  filterAndFill('f-language', OPTIONS.languages, getSearch('s-language'), 'languages');
  filterAndFill('f-place', OPTIONS.places, getSearch('s-place'), 'places');
  filterAndFill('f-type', OPTIONS.types, getSearch('s-type'), 'types');
  filterAndFill('f-tags', OPTIONS.tags, getSearch('s-tags'), 'tags');
}
function computeOptionSets(items) {
  return {
    authors: uniqueSorted(items.flatMap(x => x.authors)),
    editors: uniqueSorted(items.flatMap(x => x.editors)),
    translators: uniqueSorted(items.flatMap(x => x.translators)),
    languages: uniqueSorted(items.map(x => x.language)),
    places: uniqueSorted(items.map(x => x.place)),
    types: uniqueSorted(items.map(x => x.type)),
    tags: uniqueSorted(items.flatMap(x => x.tags))
  };
}

function getSearch(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

// Keep selection where still visible; drop those that are not in new options
function filterAndFill(selectId, allValues, query, key) {
  const el = document.getElementById(selectId);
  const prevSelected = new Set(Array.from(el.selectedOptions).map(o => o.value));
  const q = fold(query || '');
  const vals = q === ''
    ? allValues
    : allValues.filter(v => {
        const toks = TOKENS[key].get(v) || [];
        return toks.some(tok => tok.startsWith(q));
      });

  el.innerHTML = '';
  vals.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    if (prevSelected.has(v)) opt.selected = true;
    el.appendChild(opt);
  });
}

function bindEvents() {
  const searchMap = [
    ['s-authors','f-authors','authors'],
    ['s-editors','f-editors','editors'],
    ['s-translators','f-translators','translators'],
    ['s-language','f-language','languages'],
    ['s-place','f-place','places'],
    ['s-type','f-type','types'],
    ['s-tags','f-tags','tags']
  ];
  searchMap.forEach(([sId, fId, key]) => {
    const sEl = document.getElementById(sId);
    if (sEl) sEl.addEventListener('input', () => {
      const currentItems = currentFilteredItems();
      const sets = computeOptionSets(currentItems);
      const allowed = sets[{authors:'authors',editors:'editors',translators:'translators',languages:'languages',places:'places',types:'types',tags:'tags'}[key]];
      filterAndFill(fId, allowed, sEl.value, key);
    });
  });

  // Apply filters when selections or year inputs change
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags','f-year-exact','f-year-min','f-year-max']
    .forEach(id => document.getElementById(id).addEventListener('input', applyFilters));

  // Enable click-to-toggle behavior for all multi-selects (no Ctrl needed), and allow unselect on second click
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags'].forEach(enableToggleMulti);

  // Clickable chips in results to toggle filters (authors, editors, translators, type, language, place, year, tags)
  document.getElementById('results').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const key = t.getAttribute('data-filter');
    const val = t.getAttribute('data-value');
    if (!key || !val) return;
    const map = {
      authors: 'f-authors',
      editors: 'f-editors',
      translators: 'f-translators',
      language: 'f-language',
      place: 'f-place',
      type: 'f-type',
      tags: 'f-tags',
      year: 'f-year-exact'
    };
    const selId = map[key];
    if (!selId) return;
    if (selId === 'f-year-exact') {
      const yEl = document.getElementById('f-year-exact');
      if (yEl.value === String(val)) yEl.value = '';
      else yEl.value = String(val);
    } else {
      toggleSelectValue(selId, val);
    }
    applyFilters();
  });

  // Toggle map show/hide
  const btnMap = document.getElementById('btn-toggle-map');
  if (btnMap) {
   btnMap.addEventListener('click', () => { const panel = document.getElementById('map-panel'); const isHidden = panel.hasAttribute('hidden'); if (isHidden) { panel.removeAttribute('hidden'); btnMap.textContent = 'Hide map'; // Defer init/resize until the panel is visible in layout requestAnimationFrame(() => { ensureMap(); // Give the browser one frame to lay out the newly visible panel setTimeout(() => { if (map) { map.invalidateSize(); } updateMap(currentFilteredItems()); // Optional: scroll into view panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50); }); } else { panel.setAttribute('hidden', ''); btnMap.textContent = 'Show map'; } });
    });
  }

  document.getElementById('btn-clear').addEventListener('click', clearFilters);
}

// Toggle selection on mousedown so no Ctrl is required; clicking again unselects
function enableToggleMulti(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.addEventListener('mousedown', (e) => {
    if (e.target && e.target.tagName === 'OPTION') {
      e.preventDefault();
      const opt = e.target;
      opt.selected = !opt.selected;
      sel.dispatchEvent(new Event('input', {bubbles: true}));
    }
  });
}

// Programmatically toggle a value in a multi-select
function toggleSelectValue(selectId, value) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  let opt = Array.from(sel.options).find(o => o.value === value);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    sel.appendChild(opt);
  }
  opt.selected = !opt.selected;
}

function getMultiSelectValues(id) {
  const sel = document.getElementById(id);
  return Array.from(sel.selectedOptions).map(o => o.value);
}

// Compute filtered items based on current selections
function currentFilteredItems() {
  const selAuthors = getMultiSelectValues('f-authors');
  const selEditors = getMultiSelectValues('f-editors');
  const selTranslators = getMultiSelectValues('f-translators');
  const selLangs = getMultiSelectValues('f-language');
  const selPlaces = getMultiSelectValues('f-place');
  const selTypes = getMultiSelectValues('f-type');
  const selTags = getMultiSelectValues('f-tags');
  const yearExact = document.getElementById('f-year-exact').value.trim();
  const yearMin = document.getElementById('f-year-min').value.trim();
  const yearMax = document.getElementById('f-year-max').value.trim();

  return VIEW.filter(it => {
    if (selAuthors.length && !selAuthors.some(v => it.authors.includes(v))) return false;
    if (selEditors.length && !selEditors.some(v => it.editors.includes(v))) return false;
    if (selTranslators.length && !selTranslators.some(v => it.translators.includes(v))) return false;
    if (selLangs.length && !selLangs.includes(it.language)) return false;
    if (selPlaces.length && !selPlaces.includes(it.place)) return false;
    if (selTypes.length && !selTypes.includes(it.type)) return false;
    if (selTags.length && !selTags.every(v => it.tags.includes(v))) return false;

    const y = (it.year !== null && it.year !== undefined) ? Number(it.year) : null;
    if (yearExact !== '') {
      if (y === null || y !== Number(yearExact)) return false;
    } else {
      if (yearMin !== '' && (y === null || y < Number(yearMin))) return false;
      if (yearMax !== '' && (y === null || y > Number(yearMax))) return false;
    }
    return true;
  });
}

function applyFilters() {
  const filtered = currentFilteredItems();

  // Update dependent option lists based on the currently filtered items
  const sets = computeOptionSets(filtered);
  filterAndFill('f-authors', sets.authors, getSearch('s-authors'), 'authors');
  filterAndFill('f-editors', sets.editors, getSearch('s-editors'), 'editors');
  filterAndFill('f-translators', sets.translators, getSearch('s-translators'), 'translators');
  filterAndFill('f-language', sets.languages, getSearch('s-language'), 'languages');
  filterAndFill('f-place', sets.places, getSearch('s-place'), 'places');
  filterAndFill('f-type', sets.types, getSearch('s-type'), 'types');
  filterAndFill('f-tags', sets.tags, getSearch('s-tags'), 'tags');

  render(filtered);
  if (mapVisible()) updateMap(filtered);
}

function clearFilters() {
  ['s-authors','s-editors','s-translators','s-language','s-place','s-type','s-tags'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags'].forEach(id => {
    const el = document.getElementById(id);
    Array.from(el.options).forEach(o => o.selected = false);
  });
  ['f-year-exact','f-year-min','f-year-max'].forEach(id => document.getElementById(id).value = '');
  buildFilters(VIEW);
  render(VIEW);
  if (mapVisible()) updateMap(VIEW);
}

function chips(values, key) {
  if (!values || !values.length) return '';
  return values.map(v => `<span class="filter-chip" data-filter="${key}" data-value="${escapeAttr(v)}">${escapeHTML(v)}</span>`).join(' ');
}

function render(items) {
  const container = document.getElementById('results');
  const count = document.getElementById('count');
  count.textContent = items.length.toString();

  if (!items.length) {
    container.innerHTML = '<div class="card">No items match your filters.</div>';
    return;
  }

  const html = items.map(it => {
    const hTitle = it.title ? `<div class="title">${escapeHTML(it.title)}</div>` : '';

    const authorsLine = it.authors.length ? `Authors: ${chips(it.authors, 'authors')}` : '';
    const editorsLine = it.editors.length ? `Editors: ${chips(it.editors, 'editors')}` : '';
    const translatorsLine = it.translators.length ? `Translators: ${chips(it.translators, 'translators')}` : '';
    const typeLine = it.type ? `Type: ${chips([it.type], 'type')}` : '';
    const langLine = it.language ? `Language: ${chips([it.language], 'language')}` : '';
    const placeLine = it.place ? `Place: ${chips([it.place], 'place')}` : '';
    const yearLine = (it.year !== null && it.year !== undefined) ? `Year: ${chips([String(it.year)], 'year')}` : '';

    const hMeta = [authorsLine, editorsLine, translatorsLine, typeLine, langLine, placeLine, yearLine]
      .filter(Boolean)
      .map(x => `<div class="meta">${x}</div>`).join('');

    const badges = (it.tags || []).map(t => `<span class="badge filter-chip" data-filter="tags" data-value="${escapeAttr(t)}">${escapeHTML(t)}</span>`).join('');

    const links = [
      it.url ? `<a href="${escapeAttr(it.url)}" target="_blank" rel="noopener">Link</a>` : ''
    ].filter(Boolean).join(' | ');

    return `<div class="card">
      ${hTitle}
      ${hMeta}
      ${badges ? `<div class="badges">${badges}</div>` : ''}
      ${links ? `<div class="meta">${links}</div>` : ''}
    </div>`;
  }).join('');

  container.innerHTML = html;
}

/* ========= Map (Leaflet) ========= */
let map, markersLayer;

function initMap() { const mapEl = document.getElementById('map'); if (!mapEl) return; map = L.map('map', { scrollWheelZoom: true }); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map); markersLayer = L.layerGroup().addTo(map); map.setView([40.3, 45.3], 6); }
}
function initMap() {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  map = L.map('map', { scrollWheelZoom: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  map.setView([40.3, 45.3], 6);
}
function mapVisible()
