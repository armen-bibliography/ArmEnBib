// Load the JSON (keeps your original data; no changes written back)
const DATA_URL = 'Exported%20Items.json';

// Helpers to read CSL JSON fields without changing the file
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
function yearFromIssued(issued) {
  try {
    const dp = (issued && issued['date-parts']) || [];
    return (Array.isArray(dp) && dp[0] && dp[0][0]) || null;
  } catch (_) { return null; }
}
function uniqueSorted(values) {
  return Array.from(new Set(values.filter(v => v !== undefined && v !== null && v !== '')))
    .sort((a,b) => (''+a).localeCompare(''+b, undefined, {sensitivity:'base'}));
}
function getTags(it) {
  const tags = Array.isArray(it.tags) ? it.tags : [];
  return tags.map(t => (t && t.tag) ? t.tag : null).filter(Boolean);
}
function getPlace(it) {
  return it['publisher-place'] || it['event-place'] || it['jurisdiction'] || it['original-publisher-place'] || null;
}
// Accent/case-insensitive folding
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

let RAW = [];
let VIEW = []; // normalized for filtering only (not saved)
let OPTIONS = {
  authors: [],
  editors: [],
  translators: [],
  languages: [],
  places: [],
  types: [],
  tags: []
};

// Load data and initialize
fetch(DATA_URL)
  .then(r => {
    if (!r.ok) throw new Error('Failed to fetch data: ' + r.status);
    return r.json();
  })
  .then(data => {
    RAW = Array.isArray(data) ? data : [data];
    VIEW = RAW.map(it => ({
      key: it.id || it.key || null,
      type: (it.type || '').toLowerCase(),
      title: it.title || '',
      authors: listNames(it.author),
      editors: listNames(it.editor),
      translators: listNames(it.translator),
      language: it.language || '',
      place: getPlace(it),
      year: yearFromIssued(it.issued),
      url: it.URL || null,
      doi: it.DOI || null,
      tags: getTags(it),
      _src: it
    }));
    buildFilters(VIEW);
    render(VIEW);
    bindEvents();
  })
  .catch(err => {
    document.getElementById('results').innerHTML = '<div class="card">Error: ' + (err && err.message ? err.message : err) + '</div>';
  });

function buildFilters(items) {
  OPTIONS.authors = uniqueSorted(items.flatMap(x => x.authors));
  OPTIONS.editors = uniqueSorted(items.flatMap(x => x.editors));
  OPTIONS.translators = uniqueSorted(items.flatMap(x => x.translators));
  OPTIONS.languages = uniqueSorted(items.map(x => x.language));
  OPTIONS.places = uniqueSorted(items.map(x => x.place));
  OPTIONS.types = uniqueSorted(items.map(x => x.type));
  OPTIONS.tags = uniqueSorted(items.flatMap(x => x.tags));

  filterAndFill('f-authors', OPTIONS.authors, getSearch('s-authors'));
  filterAndFill('f-editors', OPTIONS.editors, getSearch('s-editors'));
  filterAndFill('f-translators', OPTIONS.translators, getSearch('s-translators'));
  filterAndFill('f-language', OPTIONS.languages, getSearch('s-language'));
  filterAndFill('f-place', OPTIONS.places, getSearch('s-place'));
  filterAndFill('f-type', OPTIONS.types, getSearch('s-type'));
  filterAndFill('f-tags', OPTIONS.tags, getSearch('s-tags'));
}

function getSearch(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

// Populate a <select> based on a query; show only values that START WITH the query (case/diacritic-insensitive)
function filterAndFill(selectId, allValues, query) {
  const el = document.getElementById(selectId);
  const prevSelected = new Set(Array.from(el.selectedOptions).map(o => o.value));
  const q = fold(query || '');
  const vals = q === '' ? allValues : allValues.filter(v => fold(v).startsWith(q));
  el.innerHTML = '';
  vals.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    if (prevSelected.has(v)) opt.selected = true; // keep selection if still visible
    el.appendChild(opt);
  });
}

function bindEvents() {
  // Filter option lists as the user types (live)
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
    if (sEl) sEl.addEventListener('input', () => filterAndFill(fId, OPTIONS[key], sEl.value));
  });

  // Apply item filters when selections or year inputs change
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags','f-year-exact','f-year-min','f-year-max']
    .forEach(id => document.getElementById(id).addEventListener('input', applyFilters));

  document.getElementById('btn-clear').addEventListener('click', clearFilters);
}

function getMultiSelectValues(id) {
  const sel = document.getElementById(id);
  return Array.from(sel.selectedOptions).map(o => o.value);
}

function applyFilters() {
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

  const filtered = VIEW.filter(it => {
    if (selAuthors.length && !selAuthors.some(v => it.authors.includes(v))) return false;
    if (selEditors.length && !selEditors.some(v => it.editors.includes(v))) return false;
    if (selTranslators.length && !selTranslators.some(v => it.translators.includes(v))) return false;
    if (selLangs.length && !selLangs.includes(it.language)) return false;
    if (selPlaces.length && !selPlaces.includes(it.place)) return false;
    if (selTypes.length && !selTypes.includes(it.type)) return false;
    if (selTags.length && !selTags.every(v => it.tags.includes(v))) return false; // AND for tags

    const y = (it.year !== null && it.year !== undefined) ? Number(it.year) : null;
    if (yearExact !== '') {
      if (y === null || y !== Number(yearExact)) return false;
    } else {
      if (yearMin !== '' && (y === null || y < Number(yearMin))) return false;
      if (yearMax !== '' && (y === null || y > Number(yearMax))) return false;
    }
    return true;
  });

  render(filtered);
}

function clearFilters() {
  ['s-authors','s-editors','s-translators','s-language','s-place','s-type','s-tags'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Rebuild all option lists to full
  buildFilters(VIEW);

  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags'].forEach(id => {
    const el = document.getElementById(id);
    Array.from(el.options).forEach(o => o.selected = false);
  });
  ['f-year-exact','f-year-min','f-year-max'].forEach(id => document.getElementById(id).value = '');
  render(VIEW);
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
    const hMeta = [
      it.authors.length ? `Authors: ${it.authors.join('; ')}` : '',
      it.editors.length ? `Editors: ${it.editors.join('; ')}` : '',
      it.translators.length ? `Translators: ${it.translators.join('; ')}` : '',
      it.type ? `Type: ${it.type}` : '',
      it.language ? `Language: ${it.language}` : '',
      it.place ? `Place: ${it.place}` : '',
      (it.year !== null && it.year !== undefined) ? `Year: ${it.year}` : ''
    ].filter(Boolean).map(x => `<div class="meta">${escapeHTML(x)}</div>`).join('');

    const badges = (it.tags || []).map(t => `<span class="badge">${escapeHTML(t)}</span>`).join('');

    const links = [
      it.url ? `<a href="${escapeAttr(it.url)}" target="_blank" rel="noopener">Link</a>` : '',
      it.doi ? `<a href="https://doi.org/${encodeURIComponent(it.doi)}" target="_blank" rel="noopener">DOI</a>` : ''
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

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
