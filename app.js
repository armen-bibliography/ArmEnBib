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
  filterAndFill('f-type', OPTIONS.types, getSearch('
