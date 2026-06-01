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

  if (m) {
    return m[1].trim();
  }

  return s.trim();
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
  // From isPartOf: Journal or Book
  const partOf = firstEl(node, NS.dcterms, 'isPartOf');
  if (partOf) {
    const journal = firstEl(partOf, NS.bib, 'Journal');
    if (journal) {
      const t = firstText(journal, NS.dc, 'title') || firstText(journal, NS.prism, 'publicationName');
      if (t) return t;
    }
    const book = firstEl(partOf, NS.bib, 'Book');
    if (book) {
      const t = firstText(book, NS.dc, 'title');
      if (t) return t;
    }
  }
  // Some exports use prism:publicationName directly
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
  filterAndFill('f-publication', OPTIONS.publications, getSearch('s-publication'), 'publications');
  filterAndFill('f-publisher', OPTIONS.publishers, getSearch('s-publisher'), 'publishers');
}

/* Build option sets from items */
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

/* ========= Events ========= */
function bindEvents() {
  const searchMap = [
    ['s-authors','f-authors','authors'],
    ['s-editors','f-editors','editors'],
    ['s-translators','f-translators','translators'],
    ['s-language','f-language','languages'],
    ['s-place','f-place','places'],
    ['s-type','f-type','types'],
    ['s-tags','f-tags','tags'],
    ['s-publication','f-publication','publications'],
    ['s-publisher','f-publisher','publishers']
  ];
  searchMap.forEach(([sId, fId, key]) => {
    const sEl = document.getElementById(sId);
    if (sEl) sEl.addEventListener('input', () => {
      const currentItems = currentFilteredItems();
      const sets = computeOptionSets(currentItems);
      const allowed = sets[{authors:'authors',editors:'editors',translators:'translators',languages:'languages',places:'places',types:'types',tags:'tags',publications:'publications',publishers:'publishers'}[key]];
      filterAndFill(fId, allowed, sEl.value, key);
    });
  });

  // Apply filters on change
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags','f-publication','f-publisher','f-year-exact','f-year-min','f-year-max']
    .forEach(id => document.getElementById(id).addEventListener('input', applyFilters));

  // Enable click-to-toggle for all multi-selects
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags','f-publication','f-publisher'].forEach(enableToggleMulti);

  // Clickable chips in results (including publisher/publication)
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
      publication: 'f-publication',
      publisher: 'f-publisher',
      year: 'f-year-exact'
    };
    const selId = map[key];
    if (!selId) return;
    if (selId === 'f-year-exact') {
      const yEl = document.getElementById('f-year-exact');
      yEl.value = (yEl.value === String(val)) ? '' : String(val);
    } else {
      toggleSelectValue(selId, val);
    }
    applyFilters();
  });

  // Toggle map
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

  // Active filters bar clicks (remove chip / clear all)
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

/* Toggle multi-select option on click */
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
function getMultiSelectValues(id) {
  const sel = document.getElementById(id);
  return Array.from(sel.selectedOptions).map(o => o.value);
}

/* ========= Compute filtered items ========= */
function currentFilteredItems() {
  const selAuthors = getMultiSelectValues('f-authors');
  const selEditors = getMultiSelectValues('f-editors');
  const selTranslators = getMultiSelectValues('f-translators');
  const selLangs = getMultiSelectValues('f-language');
  const selPlaces = getMultiSelectValues('f-place');
  const selTypes = getMultiSelectValues('f-type');
  const selTags = getMultiSelectValues('f-tags');
  const selPublications = getMultiSelectValues('f-publication');
  const selPublishers = getMultiSelectValues('f-publisher');

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
    if (selPublications.length && !selPublications.includes(it.containerTitle)) return false;
    if (selPublishers.length && !selPublishers.includes(it.publisherName)) return false;

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

/* ========= Apply/Clear filters ========= */
function applyFilters() {
  const filtered = currentFilteredItems();

  const sets = computeOptionSets(filtered);
  filterAndFill('f-authors', sets.authors, getSearch('s-authors'), 'authors');
  filterAndFill('f-editors', sets.editors, getSearch('s-editors'), 'editors');
  filterAndFill('f-translators', sets.translators, getSearch('s-translators'), 'translators');
  filterAndFill('f-language', sets.languages, getSearch('s-language'), 'languages');
  filterAndFill('f-place', sets.places, getSearch('s-place'), 'places');
  filterAndFill('f-type', sets.types, getSearch('s-type'), 'types');
  filterAndFill('f-tags', sets.tags, getSearch('s-tags'), 'tags');
  filterAndFill('f-publication', sets.publications, getSearch('s-publication'), 'publications');
  filterAndFill('f-publisher', sets.publishers, getSearch('s-publisher'), 'publishers');

  render(filtered);
  renderActiveFilters();
  if (mapVisible()) updateMap(filtered);
}

function clearFilters() {
  ['s-authors','s-editors','s-translators','s-language','s-place','s-type','s-tags','s-publication','s-publisher'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['f-authors','f-editors','f-translators','f-language','f-place','f-type','f-tags','f-publication','f-publisher'].forEach(id => {
    const el = document.getElementById(id);
    Array.from(el.options).forEach(o => o.selected = false);
  });
  ['f-year-exact','f-year-min','f-year-max'].forEach(id => document.getElementById(id).value = '');
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

  renderActiveFilters();
}

/* ========= Active filters ========= */
function renderActiveFilters() {
  const bar = document.getElementById('active-filters');

  const af = [];
  const map = [
    ['authors','f-authors'],
    ['editors','f-editors'],
    ['translators','f-translators'],
    ['language','f-language'],
    ['place','f-place'],
    ['type','f-type'],
    ['tags','f-tags'],
    ['publication','f-publication'],
    ['publisher','f-publisher']
  ];
  map.forEach(([key, selId]) => {
    const vals = getMultiSelectValues(selId);
    vals.forEach(v => af.push({key, val: v}));
  });

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
  const map = {
    authors: 'f-authors',
    editors: 'f-editors',
    translators: 'f-translators',
    language: 'f-language',
    place: 'f-place',
    type: 'f-type',
    tags: 'f-tags',
    publication: 'f-publication',
    publisher: 'f-publisher'
  };
  if (key === 'year-exact') {
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
function transliterateHBM(str) {
  if (!str) return '';
  let out = '';
  for (const ch of str) out += (ARM_HBM[ch] !== undefined) ? ARM_HBM[ch] : ch;
  return out;
}
function hasArmenian(s) { return /[\u0530-\u058F]/.test(s || ''); }
function needsArmenianVariants(lang) {
  const f = fold(lang || '');
  return hasArmenian(lang) || f.includes('armenian') || f.includes('hye') || f.includes('հայ');
}
function joinPersonsPlain(arr) {
  if (!arr || !arr.length) return '';
  // RDF produced "Surname, Given"; convert to "Surname Given"
  return arr.map(n => {
    const parts = n.split(',').map(x => x.trim());
    if (parts.length === 2) return `${parts[0]} ${parts[1]}`;
    return n;
  }).join('; ');
}
function translitIfDiff(txt) {
  const t = transliterateHBM(txt || '');
  return (t && t !== txt) ? t : null;
}
function qArm(s) { return `«${s}»`; }
function qEng(s) { return `“${s}”`; }

function buildChicago(it, variant) {
  const isArm = needsArmenianVariants(it.language);
  const persons = joinPersonsPlain(it.authors.length ? it.authors : it.editors);
  const tRaw = it.title || '';
  const contRaw = it.containerTitle || '';
  const placeRaw = it.place || '';
  const pubRaw = it.publisherName || '';
  const y = it.year ? String(it.year) : '';
  const pagesTxt = it.pages ? `, ${it.pages}` : '';

  const nameA = persons;
  const nameB = isArm && variant==='b'
    ? persons + (translitIfDiff(persons) ? ` [${translitIfDiff(persons)}]` : '')
    : (variant==='c' ? transliterateHBM(persons) : persons);

  const titleA = isArm && variant!=='c' ? qArm(tRaw) : qEng(transliterateHBM(tRaw));
  const titleB = (variant==='b' && isArm)
    ? `${qArm(tRaw)}${translitIfDiff(tRaw) ? ` [${qEng(transliterateHBM(tRaw))}]` : ''}`
    : (variant==='c' ? qEng(transliterateHBM(tRaw)) : qArm(tRaw));

  const contA = isArm && variant!=='c' ? contRaw : transliterateHBM(contRaw);
  const contB = (variant==='b' && isArm)
    ? `${contRaw}${translitIfDiff(contRaw) ? ` [${transliterateHBM(contRaw)}]` : ''}`
    : (variant==='c' ? transliterateHBM(contRaw) : contRaw);

  const placeA = isArm && variant!=='c' ? placeRaw : transliterateHBM(placeRaw);
  const placeB = (variant==='b' && isArm)
    ? `${placeRaw}${translitIfDiff(placeRaw) ? ` [${transliterateHBM(placeRaw)}]` : ''}`
    : (variant==='c' ? transliterateHBM(placeRaw) : placeRaw);

  const pubA = isArm && variant!=='c' ? pubRaw : transliterateHBM(pubRaw);
  const pubB = (variant==='b' && isArm)
    ? `${pubRaw}${translitIfDiff(pubRaw) ? ` [${transliterateHBM(pubRaw)}]` : ''}`
    : (variant==='c' ? transliterateHBM(pubRaw) : pubRaw);

  const name = (variant==='a') ? nameA : (variant==='b' ? nameB : transliterateHBM(persons));
  const title = (variant==='a') ? titleA : (variant==='b' ? titleB : qEng(transliterateHBM(tRaw)));
  const cont = (variant==='a') ? contA : (variant==='b' ? contB : transliterateHBM(contRaw));
  const place = (variant==='a') ? placeA : (variant==='b' ? placeB : transliterateHBM(placeRaw));
  const pub = (variant==='a') ? pubA : (variant==='b' ? pubB : transliterateHBM(pubRaw));

  // Format: Name. “Title.” (Place: Publisher, Year), pages.
  const paren = (place || pub || y) ? ` (${[place, pub].filter(Boolean).join(': ')}, ${y})` : '';
  const bits = [];
  if (name) bits.push(name + '.');
  if (title) bits.push(title + '.');
  bits.push(`${paren}${pagesTxt}.`);
  if (cont) bits.splice(2, 0, `${cont}.`); // if there is a container, place it before paren
  return bits.join(' ').replace(/\s+/g,' ').trim();
}


function buildAPA(it, variant) {
  const isArm = needsArmenianVariants(it.language);
  const persons = joinPersonsPlain(it.authors.length ? it.authors : it.editors);
  const tRaw = it.title || '';
  const contRaw = it.containerTitle || '';
  const placeRaw = it.place || '';
  const pubRaw = it.publisherName || '';
  const y = it.year ? `(${it.year}).` : '(n.d.).';
  const pagesTxt = it.pages ? `, ${it.pages}` : '';
  const url = it.url || '';

  const nameB = isArm && variant === 'b'
    ? persons + (translitIfDiff(persons) ? ` [${transliterateHBM(persons)}]` : '')
    : (variant === 'c' ? transliterateHBM(persons) : persons);

  const titleB = (variant === 'b' && isArm)
    ? `${tRaw}${translitIfDiff(tRaw) ? ` [${transliterateHBM(tRaw)}]` : ''}`
    : (variant === 'c' ? transliterateHBM(tRaw) : tRaw);

  const contB = (variant === 'b' && isArm)
    ? `${contRaw}${translitIfDiff(contRaw) ? ` [${transliterateHBM(contRaw)}]` : ''}`
    : (variant === 'c' ? transliterateHBM(contRaw) : contRaw);

  const placeB = (variant === 'b' && isArm)
    ? `${placeRaw}${translitIfDiff(placeRaw) ? ` [${transliterateHBM(placeRaw)}]` : ''}`
    : (variant === 'c' ? transliterateHBM(placeRaw) : placeRaw);

  const pubB = (variant === 'b' && isArm)
    ? `${pubRaw}${translitIfDiff(pubRaw) ? ` [${transliterateHBM(pubRaw)}]` : ''}`
    : (variant === 'c' ? transliterateHBM(pubRaw) : pubRaw);

  const name = (variant === 'a') ? persons : nameB;
  const title = (variant === 'a') ? tRaw : titleB;
  const cont = (variant === 'a') ? contRaw : contB;
  const place = (variant === 'a') ? placeRaw : placeB;
  const pub = (variant === 'a') ? pubRaw : pubB;

  // Simple APA-ish shaping (no italics for plain text):
  // Article/chapter: Name. (Year). Title. Container, pages. URL
  // Book: Name. (Year). Title. Place: Publisher. URL
  const bits = [];
  if (name) bits.push(`${name}.`);
  bits.push(y);
  if (title) bits.push(`${title}.`);

  if (cont) {
    // If it looks like an article/chapter
    let contPart = cont;
    if (it.pages) contPart += pagesTxt;
    bits.push(`${contPart}.`);
    if (place || pub) {
      const pubPart = [place, pub].filter(Boolean).join(': ');
      if (pubPart) bits.push(`${pubPart}.`);
    }
  } else {
    // Book-like
    if (place || pub) {
      const pubPart = [place, pub].filter(Boolean).join(': ');
      if (pubPart) bits.push(`${pubPart}.`);
    }
  }
  if (url) bits.push(url);

  return bits.join(' ').replace(/\s+/g, ' ').trim();
}

/* Render citation suggestions block */
function renderCitations(it) {
  const chicagoA = buildChicago(it, 'a');
  const chicagoB = buildChicago(it, 'b');
  const chicagoC = buildChicago(it, 'c');

  const apaA = buildAPA(it, 'a');
  const apaB = buildAPA(it, 'b');
  const apaC = buildAPA(it, 'c');

  const row = (label, text) => `
    <div class="cite-row">
      <div class="cite-label">${escapeHTML(label)}</div>
      <div class="cite-text">${escapeHTML(text)}</div>
      <button type="button" class="btn-copy" data-copy="${escapeAttr(text)}">Copy</button>
    </div>`;

  return `
    <div class="cite-group">
      <div class="cite-head">Chicago (notes-bibliography, plain text)</div>
      ${row('A. Native/English as needed', chicagoA)}
      ${row('B. Native [+ transliteration in brackets]', chicagoB)}
      ${row('C. Transliteration only', chicagoC)}
    </div>
    <div class="cite-group">
      <div class="cite-head">APA (plain text)</div>
      ${row('A. Native/English as needed', apaA)}
      ${row('B. Native [+ transliteration in brackets]', apaB)}
      ${row('C. Transliteration only', apaC)}
    </div>`;
}

/* ========= Filter option populate with search ========= */
function getSearch(id) {
  const el = document.getElementById(id);
  return el ? el.value || '' : '';
}

function filterAndFill(selectId, allowedValues, search, tokenKey) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const prevSelected = new Set(Array.from(sel.selectedOptions).map(o => o.value));
  const tokens = (search || '').trim() ? extractTokens(search) : [];
  const tokenMap = TOKENS[tokenKey] || new Map();

  let values = Array.isArray(allowedValues) ? allowedValues.slice() : [];
  if (tokens.length) {
    const must = tokens.map(fold);
    values = values.filter(v => {
      const toks = tokenMap.get(v) || extractTokens(v);
      const folded = new Set(toks.map(fold));
      return must.every(t => folded.has(t));
    });
  }

  // Rebuild options
  sel.innerHTML = '';
  values.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    // preserve previous selection if still present
    opt.selected = prevSelected.has(v);
    sel.appendChild(opt);
  });
}

/* ========= Map handling (safe no-ops if Leaflet absent) ========= */
let map = null;
let placeMarkers = new Map(); // place -> marker
const PLACE_COORDS_CACHE = new Map(); // place -> [lat, lng]

function mapVisible() {
  const panel = document.getElementById('map-panel');
  const mapDiv = document.getElementById('map');
  if (!panel || !mapDiv) return false;
  return !panel.hasAttribute('hidden');
}

function ensureMap() {
  const mapDiv = document.getElementById('map');
  if (!mapDiv) return;

  if (window.L && !map) {
    map = L.map(mapDiv).setView([40.0, 0.0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
  }
}

async function updateMap(items) {
  if (!map) return;

  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers.clear();

  const counts = new Map();

  items.forEach(it => {
    const p = canonicalPlace(it.place);
    if (!p) return;
    counts.set(p, (counts.get(p) || 0) + 1);
  });

  for (const [place, cnt] of counts.entries()) {

    let coords = PLACE_COORDS_CACHE.get(place);

    if (!coords) {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place)}`
        );

        const results = await response.json();

        if (results.length) {
          coords = [
            parseFloat(results[0].lat),
            parseFloat(results[0].lon)
          ];

          PLACE_COORDS_CACHE.set(place, coords);
        }
      } catch (err) {
        console.error("Geocoding failed:", place, err);
      }
    }

    if (!coords) continue;

    const marker = L.marker(coords)
      .addTo(map)
      .bindPopup(`${place}: ${cnt}`);

    placeMarkers.set(place, marker);
  }

  const latlngs = Array.from(placeMarkers.values())
    .map(m => m.getLatLng());

  if (latlngs.length) {
    map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
  }
}

/* Optional: preload a few common places (adjust to your data) */
// PLACE_COORDS_CACHE.set('Yerevan', [40.1772, 44.50349]);
// PLACE_COORDS_CACHE.set('Tbilisi', [41.6938, 44.8015]);
// PLACE_COORDS_CACHE.set('Istanbul', [41.0082, 28.9784]);
// PLACE_COORDS_CACHE.set('Beirut', [33.8938, 35.5018]);
// PLACE_COORDS_CACHE.set('Moscow', [55.7558, 37.6173]);
// PLACE_COORDS_CACHE.set('Paris', [48.8566, 2.3522]);
// PLACE_COORDS_CACHE.set('London', [51.5074, -0.1278]);

/* ========= End ========= */
