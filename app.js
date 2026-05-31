// Load the RDF instead of JSON
const DATA_URL = 'Exported Items.rdf';

/* ========= Helpers ========= */
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

/* ========= State ========= */
let RAW = [];
let VIEW = [];
let OPTIONS = {
  authors: [],
  editors: [],
  translators: [],
  languages: [],
  places: [],
  types: [],
  tags: [],
  publishers: [],
  publications: []
};
let TOKENS = {
  authors: new Map(),
  editors: new Map(),
  translators: new Map(),
  languages: new Map(),
  places: new Map(),
  types: new Map(),
  tags: new Map(),
  publishers: new Map(),
  publications: new Map()
};

// hidden filter state for publisher and publication (chips-only filters)
let hiddenFilters = {
  publishers: new Set(),
  publications: new Set()
};

/* ========= Namespaces ========= */
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
function readPublisherName(node) {
  const pub = firstEl(node, NS.dc, 'publisher');
  if (!pub) return null;
  const org = firstEl(pub, NS.foaf, 'Organization');
  if (!org) return null;
  const name = firstText(org, NS.foaf, 'name');
  return name || null;
}
function readContainerTitle(node) {
  // Try Journal
  const partOf = firstEl(node, NS.dcterms, 'isPartOf');
  if (partOf) {
    const journal = firstEl(partOf, NS.bib, 'Journal');
    if (journal) {
      const t = firstText(journal, NS.dc, 'title');
      if (t) return t;
      const t2 = firstText(journal, NS.prism, 'publicationName');
      if (t2) return t2;
    }
    const book = firstEl(partOf, NS.bib, 'Book');
    if (book) {
      const t = firstText(book, NS.dc, 'title');
      if (t) return t;
    }
  }
  // Some exports use prism:publicationName directly on item
  const p = firstText(node, NS.prism, 'publicationName');
  return p || null;
}
function readPages(node) {
  return firstText(node, NS.bib, 'pages') || null;
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

/* ========= RDF Parse ========= */
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
    const publisherName = readPublisherName(item);
    const containerTitle = readContainerTitle(item) || null;

    const dateStr = firstText(item, NS.dc, 'date') || '';
    const year = getYearFromDateStr(dateStr);

    const url = readURL(item);
    const doi = null;
    const tags = readSubjects(item);
    const pages = readPages(item);
    const libraryCatalog = firstText(item, NS.z, 'libraryCatalog') || null;

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
      publisherName,
      containerTitle,
      pages,
      year,
      url,
      doi,
      libraryCatalog,
      tags,
      _src: null
    });
  }
  return out;
}

/* ========= Load data ========= */
fetch(DATA_URL)
  .then(r => {
    if (!r.ok) throw new Error('Failed to fetch data: ' + r.status + ' ' + r.url);
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
      publisherName: it.publisherName || null,
      containerTitle: it.containerTitle || null,
      pages: it.pages || null,
      year: it.year !== undefined ? it.year : null,
      url: it.url || null,
      doi: it.doi || null,
      libraryCatalog: it.libraryCatalog || null,
      tags: it.tags || [],
      _src: it
    }));
    buildFilters(VIEW);
    render(VIEW);
    bindEvents();
    // Map will be initialized on first Show map click
  })
  .catch(err => {
    document.getElementById('results').innerHTML = '<div class="card">Error: ' + (err && err.message ? err.message : err) + '</div>';
  });

/* ========= Filters build/fill ========= */
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
  TOKENS.publishers = new Map(OPTIONS.publishers.map(v => [v, extractTokens(v)]));
  TOKENS.publications = new Map(OPTIONS.publications.map(v => [v, extractTokens(v)]));

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
    places: uniqueSorted(items.map(x => x.place).filter(Boolean)),
    types: uniqueSorted(items.map(x => x.type)),
    tags: uniqueSorted(items.flatMap(x => x.tags)),
    publishers: uniqueSorted(items.map(x => x.publisherName).filter(Boolean)),
    publications: uniqueSorted(items.map(x => x.containerTitle).filter(Boolean))
  };
}
function getSearch(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}
function filterAndFill(selectId, allValues, query, key) {
  const el = document.getElementById(selectId);
  if (!el) return;
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

/* ========= Events ========= */
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
    .forEach(id => document.getElementById(id).addEventListener('input', () => {
      applyFilters();
    }));

  // Enable click-to-toggle behavior for all multi-selects
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags'].forEach(enableToggleMulti);

  // Clickable chips in results to toggle filters (including publisher and publication)
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
    if (key === 'publisher') {
      toggleHiddenFilter('publishers', val);
      applyFilters();
      return;
    }
    if (key === 'publication') {
      toggleHiddenFilter('publications', val);
      applyFilters();
      return;
    }
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
    btnMap.addEventListener('click', () => {
      const panel = document.getElementById('map-panel');
      const isHidden = panel.hasAttribute('hidden');
      if (isHidden) {
        panel.removeAttribute('hidden');
        btnMap.textContent = 'Hide map';
        requestAnimationFrame(() => {
          ensureMap();
          setTimeout(() => {
            if (map) map.invalidateSize();
            updateMap(currentFilteredItems());
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 50);
        });
      } else {
        panel.setAttribute('hidden', '');
        btnMap.textContent = 'Show map';
      }
    });
  }

  document.getElementById('btn-clear').addEventListener('click', clearFilters);

  // Active filters bar clicks (remove chip)
  document.getElementById('active-filters').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.classList.contains('x')) {
      const chip = t.closest('.active-chip');
      if (!chip) return;
      const fkey = chip.getAttribute('data-filter');
      const fval = chip.getAttribute('data-value');
      removeFilterChip(fkey, fval);
    } else if (t.id === 'af-clear-all' || t.classList.contains('clear-all')) {
      clearFilters();
    }
  });
}

/* ========= Filtering mechanics ========= */
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
function toggleHiddenFilter(key, value) {
  const set = hiddenFilters[key];
  if (!set) return;
  if (set.has(value)) set.delete(value); else set.add(value);
}
function getMultiSelectValues(id) {
  const sel = document.getElementById(id);
  return Array.from(sel.selectedOptions).map(o => o.value);
}

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

  const selPublishers = Array.from(hiddenFilters.publishers);
  const selPublications = Array.from(hiddenFilters.publications);

  return VIEW.filter(it => {
    if (selAuthors.length && !selAuthors.some(v => it.authors.includes(v))) return false;
    if (selEditors.length && !selEditors.some(v => it.editors.includes(v))) return false;
    if (selTranslators.length && !selTranslators.some(v => it.translators.includes(v))) return false;
    if (selLangs.length && !selLangs.includes(it.language)) return false;
    if (selPlaces.length && !selPlaces.includes(it.place)) return false;
    if (selTypes.length && !selTypes.includes(it.type)) return false;
    if (selTags.length && !selTags.every(v => it.tags.includes(v))) return false;
    if (selPublishers.length && !selPublishers.includes(it.publisherName)) return false;
    if (selPublications.length && !selPublications.includes(it.containerTitle)) return false;

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

  // Update dependent options
  const sets = computeOptionSets(filtered);
  filterAndFill('f-authors', sets.authors, getSearch('s-authors'), 'authors');
  filterAndFill('f-editors', sets.editors, getSearch('s-editors'), 'editors');
  filterAndFill('f-translators', sets.translators, getSearch('s-translators'), 'translators');
  filterAndFill('f-language', sets.languages, getSearch('s-language'), 'languages');
  filterAndFill('f-place', sets.places, getSearch('s-place'), 'places');
  filterAndFill('f-type', sets.types, getSearch('s-type'), 'types');
  filterAndFill('f-tags', sets.tags, getSearch('s-tags'), 'tags');

  render(filtered);
  renderActiveFilters();
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
  hiddenFilters.publishers.clear();
  hiddenFilters.publications.clear();
  buildFilters(VIEW);
  render(VIEW);
  renderActiveFilters();
  if (mapVisible()) updateMap(VIEW);
}

/* ========= Rendering ========= */
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

    // New fields
    const pubNameLine = it.publisherName ? `Publisher: ${chips([it.publisherName], 'publisher')}` : '';
    const containerLine = it.containerTitle ? `Publication: ${chips([it.containerTitle], 'publication')}` : '';
    const pagesLine = it.pages ? `Pages: ${escapeHTML(it.pages)}` : '';
    const catalogLine = it.libraryCatalog ? `Library catalog: ${escapeHTML(it.libraryCatalog)}` : '';

    const hMeta = [authorsLine, editorsLine, translatorsLine, typeLine, langLine, placeLine, yearLine, pubNameLine, containerLine, pagesLine, catalogLine]
      .filter(Boolean)
      .map(x => `<div class="meta">${x}</div>`).join('');

    const badges = (it.tags || []).map(t => `<span class="badge filter-chip" data-filter="tags" data-value="${escapeAttr(t)}">${escapeHTML(t)}</span>`).join('');

    const links = [
      it.url ? `<a href="${escapeAttr(it.url)}" target="_blank" rel="noopener">Link</a>` : ''
    ].filter(Boolean).join(' | ');

    // Citation toggle + panel
    const citePanel = `
      <div class="cite">
        <button class="cite-toggle" type="button" data-cite-key="${escapeAttr(it.key || '')}">Show citation suggestions</button>
        <div class="cite-panel" hidden data-cite-panel="${escapeAttr(it.key || '')}">
          ${renderCitations(it)}
        </div>
      </div>`;

    return `<div class="card">
      ${hTitle}
      ${hMeta}
      ${badges ? `<div class="badges">${badges}</div>` : ''}
      ${links ? `<div class="meta">${links}</div>` : ''}
      ${citePanel}
    </div>`;
  }).join('');

  container.innerHTML = html;

  // Bind citation toggles
  container.querySelectorAll('.cite-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-cite-key') || '';
      const panel = container.querySelector(`.cite-panel[data-cite-panel="${CSS.escape(key)}"]`);
      if (!panel) return;
      const isHidden = panel.hasAttribute('hidden');
      if (isHidden) {
        panel.removeAttribute('hidden');
        btn.textContent = 'Hide citation suggestions';
      } else {
        panel.setAttribute('hidden', '');
        btn.textContent = 'Show citation suggestions';
      }
    });
  });

  // Bind copy buttons
  container.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.getAttribute('data-copy') || '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = 'Copy', 1200);
      }).catch(() => {});
    });
  });

  // Render active filters bar
  renderActiveFilters();
}

function renderActiveFilters() {
  const bar = document.getElementById('active-filters');

  // Collect active filters
  const af = [];

  // Multi selects
  const map = [
    ['authors','f-authors'],
    ['editors','f-editors'],
    ['translators','f-translators'],
    ['language','f-language'],
    ['place','f-place'],
    ['type','f-type'],
    ['tags','f-tags']
  ];
  map.forEach(([key, selId]) => {
    const vals = getMultiSelectValues(selId);
    vals.forEach(v => af.push({key, val: v}));
  });

  // Hidden publisher/publication
  Array.from(hiddenFilters.publishers).forEach(v => af.push({key: 'publisher', val: v}));
  Array.from(hiddenFilters.publications).forEach(v => af.push({key: 'publication', val: v}));

  // Year
  const yExact = document.getElementById('f-year-exact').value.trim();
  const yMin = document.getElementById('f-year-min').value.trim();
  const yMax = document.getElementById('f-year-max').value.trim();
  if (yExact) af.push({key:'year-exact', val: yExact});
  if (yMin || yMax) af.push({key:'year-range', val: `${yMin || '…'}–${yMax || '…'}`});

  if (!af.length) {
    bar.setAttribute('hidden','');
    bar.innerHTML = '';
    return;
  }

  bar.removeAttribute('hidden');
  const html = af.map(x => {
    const label = `${x.key}: ${x.val}`;
    return `<span class="active-chip" data-filter="${escapeAttr(x.key)}" data-value="${escapeAttr(x.val)}">
      ${escapeHTML(label)} <span class="x" title="Remove">×</span>
    </span>`;
  }).join('') + `<button id="af-clear-all" class="clear-all" type="button">Clear all</button>`;
  bar.innerHTML = html;
}

function removeFilterChip(key, val) {
  // Remove from UI selections or hidden filters
  const map = {
    authors: 'f-authors',
    editors: 'f-editors',
    translators: 'f-translators',
    language: 'f-language',
    place: 'f-place',
    type: 'f-type',
    tags: 'f-tags'
  };
  if (key === 'publisher') {
    hiddenFilters.publishers.delete(val);
  } else if (key === 'publication') {
    hiddenFilters.publications.delete(val);
  } else if (key === 'year-exact') {
    document.getElementById('f-year-exact').value = '';
  } else if (key === 'year-range') {
    document.getElementById('f-year-min').value = '';
    document.getElementById('f-year-max').value = '';
  } else if (map[key]) {
    const sel = document.getElementById(map[key]);
    const opt = Array.from(sel.options).find(o => o.value === val);
    if (opt) opt.selected = false;
  }
  applyFilters();
}

/* ========= Citation suggestions ========= */

/* Armenian transliteration map (HBM) */
const ARM_HBM = {
  "Ա":"A","ա":"a","Բ":"B","բ":"b","Գ":"G","գ":"g","Դ":"D","դ":"d","Ե":"E","ե":"e",
  "Զ":"Z","զ":"z","Է":"Ē","է":"ē","Ը":"Ə","ը":"ə","Թ":"Tʿ","թ":"tʿ","Ժ":"Ž","ժ":"ž",
  "Ի":"I","ի":"i","Լ":"L","լ":"l","Խ":"X","խ":"x","Ծ":"C","ծ":"c","Կ":"K","կ":"k",
  "Հ":"H","հ":"h","Ձ":"J","ձ":"j","Ղ":"Ł","ղ":"ł","Ճ":"Č","ճ":"č","Մ":"M","մ":"m",
  "Յ":"Y","յ":"y","Ն":"N","ն":"n","Շ":"Š","շ":"š","Ո":"O","ո":"o","Չ":"Čʿ","չ":"čʿ",
  "Պ":"P","պ":"p","Ջ":"ǰ","ջ":"ǰ","Ռ":"Ṙ","ռ":"ṙ","Ս":"S","ս":"s","Վ":"V","վ":"v",
  "Տ":"T","տ":"t","Ր":"R","ր":"r","Ց":"Cʿ","ց":"cʿ","Ւ":"W","ւ":"w","Փ":"Pʿ","փ":"pʿ",
  "Ք":"Kʿ","ք":"kʿ","Օ":"Ō","օ":"ō","Ֆ":"F","ֆ":"f","և":"ew"
};
// No special "ու" digraph rule is added; we use the exact per-character map above.

function transliterateHBM(str) {
  if (!str) return '';
  let out = '';
  for (const ch of str) {
    out += (ARM_HBM[ch] !== undefined) ? ARM_HBM[ch] : ch;
  }
  return out;
}
function hasArmenian(s) {
  // detect Armenian characters or the word "հայ" or "armenian" in language
  return /[\u0530-\u058F]/.test(s || '');
}
function needsArmenianVariants(lang) {
  const f = fold(lang || '');
  return hasArmenian(lang) || f.includes('armenian') || f.includes('hye') || f.includes('հայ');
}
function joinPersons(arr) {
  if (!arr || !arr.length) return '';
  return arr.join('; ');
}

function buildChicago(it, variant) {
  // variant: 'a' Armenian only, 'b' Armenian + Latin in [], 'c' Latin only
  const A = (s)=>s||'';
  const T = (s)=>transliterateHBM(s||'');
  const isArm = needsArmenianVariants(it.language);
  const person = (names) => {
    const joined = joinPersons(names);
    if (!isArm) return joined;
    if (variant==='a') return joined;
    if (variant==='b') return joined + ' [' + T(joined) + ']';
    return T(joined);
  };
  const title = (txt) => {
    if (!isArm) return txt;
    if (variant==='a') return txt;
    if (variant==='b') return `${txt} [${T(txt)}]`;
    return T(txt);
  };
  const place = (pl) => {
    if (!pl) return '';
    if (!isArm) return pl;
    if (variant==='a') return pl;
    if (variant==='b') return `${pl} [${T(pl)}]`;
    return T(pl);
  };
  const publisher = (p) => {
    if (!p) return '';
    if (!isArm) return p;
    if (variant==='a') return p;
    if (variant==='b') return `${p} [${T(p)}]`;
    return T(p);
  };
  const container = (c) => {
    if (!c) return '';
    if (!isArm) return c;
    if (variant==='a') return c;
    if (variant==='b') return `${c} [${T(c)}]`;
    return T(c);
  };

  const people = person(it.authors.length ? it.authors : it.editors);
  const t = title(it.title);
  const cont = container(it.containerTitle || '');
  const placeTxt = place(it.place || '');
  const pubTxt = publisher(it.publisherName || '');
  const pagesTxt = it.pages ? `, ${it.pages}` : '';
  const y = it.year ? String(it.year) : '';

  if (it.type === 'journalarticle' || it.type === 'article') {
    // Author. "Title." Container (Place: Publisher, Year), pages.
    const bits = [];
    if (people) bits.push(people + '.');
    if (t) bits.push(`“${t}.”`);
    if (cont) {
      const paren = (placeTxt || pubTxt || y) ? ` (${[placeTxt, pubTxt].filter(Boolean).join(': ')}, ${y})` : '';
      bits.push(`${cont}${paren}${pagesTxt}.`);
    } else {
      const paren = (placeTxt || pubTxt || y) ? ` (${[placeTxt, pubTxt].filter(Boolean).join(': ')}, ${y})` : '';
      bits.push(`${paren}${pagesTxt}.`);
    }
    return bits.join(' ');
  } else {
    // Book or section fallback
    const bits = [];
    if (people) bits.push(people + '.');
    if (t) bits.push(`“${t}.”`);
    if (cont) bits.push(`${cont}.`);
    if (placeTxt || pubTxt || y) bits.push(`(${[placeTxt, pubTxt].filter(Boolean).join(': ')}, ${y}).`);
    if (it.pages) bits.push(it.pages + '.');
    return bits.join(' ').replace(/\s+/g,' ').trim();
  }
}
function buildAPA(it, variant) {
  const A = (s)=>s||'';
  const T = (s)=>transliterateHBM(s||'');
  const isArm = needsArmenianVariants(it.language);
  const person = (names) => {
    const joined = joinPersons(names);
    if (!isArm) return joined;
    if (variant==='a') return joined;
    if (variant==='b') return `${joined} [${T(joined)}]`;
    return T(joined);
  };
  const title = (txt) => {
    if (!isArm) return txt;
    if (variant==='a') return txt;
    if (variant==='b') return `${txt} [${T(txt)}]`;
    return T(txt);
  };
  const container = (c) => {
    if (!c) return '';
    if (!isArm) return c;
    if (variant==='a') return c;
    if (variant==='b') return `${c} [${T(c)}]`;
    return T(c);
  };
  const place = (pl) => {
    if (!pl) return '';
    if (!isArm) return pl;
    if (variant==='a') return pl;
    if (variant==='b') return `${pl} [${T(pl)}]`;
    return T(pl);
  };
  const publisher = (p) => {
    if (!p) return '';
    if (!isArm) return p;
    if (variant==='a') return p;
    if (variant==='b') return `${p} [${T(p)}]`;
    return T(p);
  };

  const people = person(it.authors.length ? it.authors : it.editors);
  const t = title(it.title);
  const cont = container(it.containerTitle || '');
  const y = it.year ? `(${it.year}).` : '(n.d.).';
  const pagesTxt = it.pages ? `, ${it.pages}` : '';
  const pubPlace = place(it.place || '');
  const pubTxt = publisher(it.publisherName || '');

  if (it.type === 'journalarticle' || it.type === 'article') {
    // Author. (Year). Title. Container, pages. Place: Publisher.
    const bits = [];
    if (people) bits.push(people + '.');
    bits.push(y);
    if (t) bits.push(t + '.');
    if (cont) bits.push(`${cont}${pagesTxt}.`);
    if (pubPlace || pubTxt) bits.push(`${pubPlace}: ${pubTxt}.`);
    return bits.join(' ').replace(/\s+/g,' ').trim();
  } else {
    // Book/Section APA-like fallback
    const bits = [];
    if (people) bits.push(people + '.');
    bits.push(y);
    if (t) bits.push(t + '.');
    if (cont) bits.push(`${cont}.`);
    if (pubPlace || pubTxt) bits.push(`${pubPlace}: ${pubTxt}.`);
    if (it.pages) bits.push(it.pages + '.');
    return bits.join(' ').replace(/\s+/g,' ').trim();
  }
}
function buildMLA(it, variant) {
  const T = (s)=>transliterateHBM(s||'');
  const isArm = needsArmenianVariants(it.language);
  const person = (names) => {
    const joined = joinPersons(names);
    if (!isArm) return joined;
    if (variant==='a') return joined;
    if (variant==='b') return `${joined} [${T(joined)}]`;
    return T(joined);
  };
  const title = (txt) => {
    if (!isArm) return txt;
    if (variant==='a') return txt;
    if (variant==='b') return `${txt} [${T(txt)}]`;
    return T(txt);
  };
  const container = (c) => {
    if (!c) return '';
    if (!isArm) return c;
    if (variant==='a') return c;
    if (variant==='b') return `${c} [${T(c)}]`;
    return T(c);
  };
  const place = (pl) => {
    if (!pl) return '';
    if (!isArm) return pl;
    if (variant==='a') return pl;
    if (variant==='b') return `${pl} [${T(pl)}]`;
    return T(pl);
  };
  const publisher = (p) => {
    if (!p) return '';
    if (!isArm) return p;
    if (variant==='a') return p;
    if (variant==='b') return `${p} [${T(p)}]`;
    return T(p);
  };

  const people = person(it.authors.length ? it.authors : it.editors);
  const t = title(it.title);
  const cont = container(it.containerTitle || '');
  const y = it.year ? String(it.year) : '';
  const pagesTxt = it.pages ? `, pp. ${it.pages}` : '';
  const pubPlace = place(it.place || '');
  const pubTxt = publisher(it.publisherName || '');

  // Author. "Title." Container, Year, pp. X–Y. Place: Publisher.
  const bits = [];
  if (people) bits.push(people + '.');
  if (t) bits.push(`«${t}».`);
  if (cont) bits.push(`${cont},`);
  if (y) bits.push(`${y},`);
  if (it.pages) bits.push(`էջ. ${it.pages}.`); // Armenian page label for variant (we'll let it stand for all)
  if (pubPlace || pubTxt) bits.push(`${pubPlace}: ${pubTxt}.`);
  return bits.join(' ').replace(/\s+/g,' ').trim();
}

function renderCitations(it) {
  const isArm = needsArmenianVariants(it.language);
  const variants = isArm ? ['a','b','c'] : ['c']; // non-Armenian: just Latin (c)
  const out = [];

  variants.forEach(v => {
    const label = (v==='a') ? 'Armenian only' : (v==='b' ? 'Armenian + Latin' : 'Latin transliteration');
    // Chicago
    const ch = buildChicago(it, v);
    out.push(`
      <div class="cite-style">Chicago (${label})</div>
      <div class="cite-entry">
        <div class="cite-text">${escapeHTML(ch)}</div>
        <button class="btn-copy" type="button" data-copy="${escapeAttr(ch)}">Copy</button>
      </div>
    `);
    // APA
    const ap = buildAPA(it, v);
    out.push(`
      <div class="cite-style">APA (${label})</div>
      <div class="cite-entry">
        <div class="cite-text">${escapeHTML(ap)}</div>
        <button class="btn-copy" type="button" data-copy="${escapeAttr(ap)}">Copy</button>
      </div>
    `);
    // MLA
    const ml = buildMLA(it, v);
    out.push(`
      <div class="cite-style">MLA (${label})</div>
      <div class="cite-entry">
        <div class="cite-text">${escapeHTML(ml)}</div>
        <button class="btn-copy" type="button" data-copy="${escapeAttr(ml)}">Copy</button>
      </div>
    `);
  });

  return out.join('');
}

/* ========= Map (Leaflet) ========= */
let map, markersLayer;

function ensureMap() {
  if (map) return;
  initMap();
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
function mapVisible() {
  const panel = document.getElementById('map-panel');
  return panel && !panel.hasAttribute('hidden');
}

function updateMap(items) {
  if (!map || !markersLayer) return;
  markersLayer.clearLayers();

  const byPlace = new Map();
  items.forEach(it => {
    if (!it.place) return;
    const canon = canonicalPlace(it.place);
    if (!canon) return;
    if (!byPlace.has(canon)) byPlace.set(canon, { label: canon, items: [] });
    byPlace.get(canon).items.push(it);
  });

  const bounds = [];
  const promises = [];

  byPlace.forEach((obj, place) => {
    const p = geocode(place).then(coord => {
      if (!coord) return;
      const count = obj.items.length;
      const sample = obj.items.slice(0, 6).map(x => `• ${escapeHTML(x.title)}`).join('<br>');
      const popup = `<strong>${escapeHTML(place)}</strong><br>${count} item(s)<br>${sample}${obj.items.length>6?'<br>…':''}`;
      const marker = L.marker([coord.lat, coord.lon]).bindPopup(popup);
      markersLayer.addLayer(marker);
      bounds.push([coord.lat, coord.lon]);
    }).catch(() => {});
    promises.push(p);
  });

  Promise.all(promises).then(() => {
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [20, 20] });
      setTimeout(() => map.invalidateSize(), 50);
    }
  });
}
function geocode(place) {
  const key = 'geo:' + place.toLowerCase();
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (obj && typeof obj.lat === 'number' && typeof obj.lon === 'number') {
        return Promise.resolve(obj);
      }
    } catch (_) {}
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(place);
  return fetch(url, { headers: { 'Accept': 'application/json' }})
    .then(r => r.json())
    .then(arr => {
      if (Array.isArray(arr) && arr[0]) {
        const coord = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
        localStorage.setItem(key, JSON.stringify(coord));
        return coord;
      }
      return null;
    })
    .catch(() => null);
}
