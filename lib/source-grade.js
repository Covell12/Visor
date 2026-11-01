/* Visor — a reliability grade for each source, A to D, with its reasons.

   One file, two places: the browser loads public/source-grade.js; the server
   requires lib/source-grade.js, an identical copy kept in step by
   `npm run sync-engine` (test/source-grade.test.js checks they match). Edit
   public/source-grade.js, then run the sync.

   No AI and no lookups: the grade comes from what kind of site the source is
   on (its address, or a DOI or ISBN) and what the source lists (an author, a
   date), by the rules below. So it's instant, free, the same every time, and
   every point of it is a reason the student can read and check.

   grade(source, { now }) -> null for a source Visor can't grade (a written
   citation with no link or DOI in it), else
     { letter: 'A'..'D', word, score, kind, label, why, host, notes: [{ text, effect }] }
       kind/label  what kind of source it is ("news", "News outlet")
       why         what that kind means for trusting it, in a sentence or two
       notes       what moved the grade (effect +1 or -1) and things to check (0)

   Score: the kind's base, then author and date for the kinds where they say
   something (a blog with no author, a news story with no date). A >= 85,
   B >= 70, C >= 50, D below. */

(function (root) {
  'use strict';

  const KINDS = {
    scholarly: { base: 90, label: 'Scholarly journal', why: 'Research checked by other experts before it was published (peer review). The most reliable kind of source.' },
    gov: { base: 88, label: 'Government', why: 'An official government site. Very reliable for facts and data. On political questions it speaks for the government of the day.' },
    intl: { base: 86, label: 'International organization', why: 'An organization run by many countries together, like the UN or the World Health Organization. Very reliable for facts and data.' },
    reference: { base: 78, label: 'Encyclopedia, dictionary or museum', why: 'An edited reference written and checked by experts. Good for background; for an argument, look for the research it’s based on too.' },
    news: { base: 75, label: 'News outlet', why: 'An established news organization, with editors who check facts. Opinion pieces on news sites are someone’s view, not reporting.' },
    edu: { base: 75, label: 'School or university', why: 'A school or university site. Pages by researchers and departments are usually reliable; student and club pages less so.' },
    org: { base: 72, label: 'Research or health organization', why: 'A well-known research, health or data organization. Check whether it argues for a cause; if it does, look for another side too.' },
    book: { base: 72, label: 'Book', why: 'Published books are edited before they’re printed. Check who wrote it and when.' },
    preprint: { base: 62, label: 'Preprint', why: 'A research paper that hasn’t been checked by other experts yet (peer review). Use it carefully, and say it’s a preprint.' },
    web: { base: 55, label: 'Website', why: 'Visor doesn’t know this site. Check who runs it (look for an About page), whether it names an author, and whether reliable sources agree with it.' },
    upload: { base: 50, label: 'Paper uploaded by its author', why: 'Researchers upload their own papers here, and some were never checked by other experts. Look for the published version (with a DOI) and cite that.' },
    wiki: { base: 50, label: 'Wikipedia', why: 'A good place to start, but anyone can edit it. Read the sources listed at the bottom of the article, and cite those instead.' },
    video: { base: 45, label: 'Video', why: 'Anyone can post a video. Check who made it: a museum, university or news channel is more reliable than a personal channel.' },
    selfpub: { base: 40, label: 'Blog or self-published page', why: 'Anyone can publish here, and nobody checks it first. It can still help, but check its facts somewhere more reliable.' },
    social: { base: 25, label: 'Social media or forum', why: 'Anyone can post here, and posts aren’t checked before they go up.' },
    study: { base: 20, label: 'Study-help or essay site', why: 'Homework-help and essay sites are written by students or anonymous writers and aren’t checked. Use them to understand, then cite the original sources.' },
    search: { base: 10, label: 'Search page', why: 'This is a page of search results, not a source. Open the result you used and cite that page.' },
    ai: { base: 5, label: 'AI chatbot or writing tool', why: 'Text from an AI tool isn’t a source: it can be wrong, and it doesn’t say where it came from. Find where the information really comes from and cite that.' },
    satire: { base: 5, label: 'Satire', why: 'This site publishes jokes written to look like news. It isn’t meant to be true.' }
  };

  const GRADES = [
    { letter: 'A', min: 85, word: 'Very reliable' },
    { letter: 'B', min: 70, word: 'Reliable' },
    { letter: 'C', min: 50, word: 'Use with care' },
    { letter: 'D', min: -Infinity, word: 'Not reliable' }
  ];

  // Hostnames match themselves and their subdomains; "host/path" entries
  // match that path and below. The first list a host is in wins, in this order.
  // The AI and study entries are the same sites as DEFAULT_AI_SITES in lib/sites.js.
  const SITES = [
    ['ai', ['chatgpt.com', 'chat.openai.com', 'openai.com', 'gemini.google.com', 'bard.google.com', 'aistudio.google.com', 'notebooklm.google.com', 'claude.ai', 'perplexity.ai', 'copilot.microsoft.com', 'poe.com', 'character.ai', 'deepseek.com', 'meta.ai', 'you.com', 'phind.com', 'quillbot.com', 'chat.mistral.ai', 'grok.com', 'x.ai', 'huggingface.co/chat', 'jasper.ai', 'writesonic.com', 'rytr.me', 'copy.ai', 'hix.ai', 'undetectable.ai', 'stealthgpt.ai', 'gptzero.me', 'duck.ai', 'pi.ai', 'chat.qwen.ai', 'kimi.com', 'wordtune.com']],
    ['satire', ['theonion.com', 'babylonbee.com', 'clickhole.com', 'thebeaverton.com', 'newsthump.com', 'waterfordwhispersnews.com', 'thehardtimes.net', 'reductress.com']],
    ['search', ['google.com/search', 'scholar.google.com', 'news.google.com', 'bing.com/search', 'duckduckgo.com', 'search.yahoo.com', 'search.brave.com', 'ecosia.org/search', 'startpage.com', 'yandex.com/search', 'baidu.com/s']],
    ['study', ['studocu.com', 'coursehero.com', 'chegg.com', 'brainly.com', 'quizlet.com', 'sparknotes.com', 'cliffsnotes.com', 'enotes.com', 'shmoop.com', 'gradesaver.com', 'litcharts.com', 'study.com', 'ukessays.com', 'ivypanda.com', 'papersowl.com', '123helpme.com', 'studymode.com', 'ipl.org', 'kibin.com', 'edubirdie.com', 'studycorgi.com', 'bartleby.com/essay', 'gauthmath.com', 'numerade.com', 'slader.com', 'essaypro.com', 'samploon.com']],
    ['social', ['reddit.com', 'quora.com', 'answers.com', 'answers.yahoo.com', 'stackexchange.com', 'stackoverflow.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'threads.net', 'threads.com', 'bsky.app', 'pinterest.com', 'tumblr.com', 'linkedin.com', 'discord.com', 'snapchat.com', '4chan.org', 'mastodon.social', 'truthsocial.com', 'goodreads.com', 'imdb.com', 'yelp.com', 'tripadvisor.com']],
    ['upload', ['researchgate.net', 'academia.edu', 'scribd.com', 'slideshare.net', 'issuu.com']],
    ['selfpub', ['medium.com', 'substack.com', 'blogspot.com', 'blogger.com', 'wordpress.com', 'wixsite.com', 'wix.com', 'weebly.com', 'sites.google.com', 'docs.google.com', 'drive.google.com', 'fandom.com', 'wikia.com', 'wikihow.com', 'hubpages.com', 'ezinearticles.com', 'livejournal.com', 'github.io', 'neocities.org', 'ghost.io', 'beehiiv.com', 'forbes.com/sites', 'tripod.com', 'angelfire.com', 'carrd.co', 'notion.site', 'canva.site']],
    ['gov', ['nhs.uk', 'parliament.uk', 'gov.uk', 'canada.ca', 'gc.ca']],
    ['news', ['nature.com/articles/d', 'science.org/content']],
    ['video', ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'rumble.com']],
    ['wiki', ['wikipedia.org']],
    ['preprint', ['arxiv.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'papers.ssrn.com', 'osf.io', 'researchsquare.com', 'preprints.org', 'psyarxiv.com', 'chemrxiv.org', 'eartharxiv.org']],
    ['scholarly', ['doi.org', 'jstor.org', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov/pmc', 'europepmc.org', 'sciencedirect.com', 'link.springer.com', 'springer.com', 'nature.com', 'science.org', 'cell.com', 'thelancet.com', 'nejm.org', 'jamanetwork.com', 'bmj.com', 'plos.org', 'onlinelibrary.wiley.com', 'tandfonline.com', 'journals.sagepub.com', 'academic.oup.com', 'cambridge.org/core', 'muse.jhu.edu', 'frontiersin.org', 'pnas.org', 'ieeexplore.ieee.org', 'dl.acm.org', 'psycnet.apa.org', 'journals.aps.org', 'pubs.acs.org', 'iopscience.iop.org', 'royalsocietypublishing.org', 'annualreviews.org', 'jstage.jst.go.jp', 'scielo.org', 'semanticscholar.org', 'core.ac.uk', 'aeaweb.org', 'journals.uchicago.edu', 'mdpi.com', 'biomedcentral.com', 'elifesciences.org', 'jbc.org', 'ahajournals.org', 'jahonline.org']],
    ['intl', ['un.org', 'unesco.org', 'unicef.org', 'unhcr.org', 'undp.org', 'worldbank.org', 'imf.org', 'oecd.org', 'wto.org', 'europa.eu', 'icrc.org', 'fao.org', 'ipcc.ch']],
    ['reference', ['britannica.com', 'merriam-webster.com', 'oed.com', 'oxfordreference.com', 'worldbookonline.com', 'encyclopedia.com', 'khanacademy.org', 'metmuseum.org', 'britishmuseum.org', 'moma.org', 'amnh.org', 'nhm.ac.uk', 'getty.edu', 'books.google.com', 'gutenberg.org', 'poetryfoundation.org', 'folger.edu', 'avalon.law.yale.edu', 'worldhistory.org', 'dictionary.cambridge.org', 'oxfordlearnersdictionaries.com']],
    ['news', ['apnews.com', 'reuters.com', 'bbc.com', 'bbc.co.uk', 'npr.org', 'pbs.org', 'nytimes.com', 'washingtonpost.com', 'wsj.com', 'latimes.com', 'usatoday.com', 'chicagotribune.com', 'bostonglobe.com', 'sfchronicle.com', 'theguardian.com', 'economist.com', 'ft.com', 'bloomberg.com', 'cnn.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'abc.net.au', 'cbc.ca', 'aljazeera.com', 'theatlantic.com', 'newyorker.com', 'time.com', 'propublica.org', 'politico.com', 'axios.com', 'csmonitor.com', 'theglobeandmail.com', 'independent.co.uk', 'telegraph.co.uk', 'thetimes.co.uk', 'dw.com', 'france24.com', 'lemonde.fr', 'spiegel.de', 'scientificamerican.com', 'newscientist.com', 'smithsonianmag.com', 'nationalgeographic.com', 'voanews.com', 'forbes.com', 'cnbc.com', 'marketwatch.com', 'businessinsider.com', 'vox.com', 'theverge.com', 'wired.com', 'arstechnica.com', 'sciencenews.org', 'pewresearch.org', 'factcheck.org', 'snopes.com', 'politifact.com', 'thehill.com', 'foxnews.com', 'nypost.com', 'newsweek.com', 'japantimes.co.jp', 'scmp.com', 'straitstimes.com', 'hindustantimes.com', 'thehindu.com', 'smh.com.au']],
    ['org', ['mayoclinic.org', 'clevelandclinic.org', 'hopkinsmedicine.org', 'webmd.com', 'kidshealth.org', 'heart.org', 'cancer.org', 'sleepfoundation.org', 'rand.org', 'kff.org', 'gallup.com', 'statista.com', 'ourworldindata.org', 'redcross.org', 'nationalacademies.org', 'aaas.org', 'apa.org', 'ama-assn.org', 'aap.org', 'healthychildren.org', 'nami.org', 'alz.org', 'diabetes.org', 'urban.org', 'brookings.edu', 'cfr.org', 'worldwildlife.org', 'audubon.org', 'nature.org']]
  ];

  // Government, international and school addresses by their ending
  const GOV = [/\.(gov|mil)$/, /\.(gov|gob|gouv|govt|gv|go|mil)\.[a-z]{2}$/, /(^|\.)(gc|canada)\.ca$/, /\.state\.[a-z]{2}\.us$/, /(^|\.)gov\.[a-z]{2}\.[a-z]{2}$/];
  const INTL = [/\.int$/];
  const EDU = [/\.edu$/, /\.(edu|ac|sch)\.[a-z]{2}$/, /\.k12\.[a-z]{2}\.us$/];

  // Opinion on a news site, by its address
  const OPINION = /\/(opinion|opinions|op-?ed|commentary|editorials?|columnists?|blogs?)(\/|$)/i;

  const squash = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  function parseUrl(raw) {
    const s = squash(raw);
    if (!s) return null;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return { host: u.hostname.toLowerCase().replace(/^www\d?\./, '').replace(/\.$/, ''), path: u.pathname.toLowerCase(), href: u.href };
    } catch (_) { return null; }
  }
  function inList(u, list) {
    for (const entry of list) {
      const slash = entry.indexOf('/');
      const eh = slash < 0 ? entry : entry.slice(0, slash);
      const ep = slash < 0 ? '' : entry.slice(slash);
      // "google.com/search" also covers google.co.uk/search and the like
      const hostOk = u.host === eh || u.host.endsWith('.' + eh) || (eh === 'google.com' && /(^|\.)google\.[a-z.]+$/.test(u.host));
      if (hostOk && (!ep || u.path === ep || u.path.startsWith(ep + '/') || (ep.endsWith('/d') && u.path.startsWith(ep)))) return true;
    }
    return false;
  }
  // The kind of site an address is on, or null if Visor doesn't know it
  function kindOfUrl(u) {
    for (const [kind, list] of SITES) if (inList(u, list)) return kind;
    if (GOV.some(r => r.test(u.host))) return 'gov';
    if (INTL.some(r => r.test(u.host))) return 'intl';
    if (EDU.some(r => r.test(u.host))) return 'edu';
    return null;
  }

  // "https://web.archive.org/web/2019…/https://example.com/x" -> the page it saved
  function unarchive(u) {
    if (u.host !== 'web.archive.org' && u.host !== 'archive.org') return null;
    const m = /\/web\/[^/]+\/(.+)$/.exec(u.href);
    if (!m) return null;
    try { return parseUrl(decodeURIComponent(m[1])); } catch { return parseUrl(m[1]); } // a stray % isn't an escape
  }

  function yearOf(published) {
    const m = /^(\d{4})/.exec(squash(published));
    return m ? Number(m[1]) : null;
  }

  // A written citation: a DOI or a link in its text, if it has one
  function fromWritten(text) {
    const t = squash(text).replace(/\*([^*]+)\*/g, '$1');
    const doi = /\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)])/.exec(t);
    const url = /\bhttps?:\/\/[^\s"<>]+[^\s"<>.,;)]/i.exec(t) || /\b(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s"<>]*[^\s"<>.,;)])?/i.exec(t);
    if (!doi && !url) return null;
    return { type: 'webpage', doi: doi ? doi[1] : '', url: url ? url[0] : '', authors: [], published: '', fromWritten: true };
  }

  function letterFor(score) {
    return GRADES.find(g => score >= g.min);
  }

  function grade(source, opts = {}) {
    let s = source || {};
    if (s.type === 'written') {
      s = fromWritten(s.written);
      if (!s) return null;
    }
    const nowYear = new Date(opts.now || Date.now()).getFullYear();
    const notes = [];
    let u = parseUrl(s.canonicalUrl || s.url);
    if (u) {
      const saved = unarchive(u);
      if (saved) { u = saved; notes.push({ text: 'An archived copy: graded by the page it saved.', effect: 0 }); }
    }
    const doi = squash(s.doi) || (u && u.host === 'doi.org' ? u.path.slice(1) : '');
    const publisher = squash(s.publisher);
    const univPress = /\buniversity press\b|\bpress of\b.*\buniversity\b|^(mit|harvard|yale|princeton|oxford|cambridge|stanford|chicago|columbia|cornell|duke|johns hopkins) /i.test(publisher);

    // What kind of source it is: a site Visor knows, else a DOI, a journal,
    // a book with a publisher, or a video, else a website Visor doesn't know
    let kind = u ? kindOfUrl(u) : null;
    if (doi && (!kind || ['edu', 'org', 'reference'].includes(kind))) kind = 'scholarly';
    else if (!kind || (kind === 'reference' && s.type === 'book')) {
      if (s.type === 'journal' && squash(s.journal)) kind = 'scholarly';
      else if (s.type === 'book' && (publisher || squash(s.siteName))) kind = 'book';
      else if (s.type === 'video' && u) kind = 'video';
      else if (u) kind = 'web';
      else return null;   // no link, DOI or publisher: nothing to grade from
    }

    const K = KINDS[kind];
    // A university press is held to a scholarly standard
    const base = kind === 'book' && univPress ? 85 : K.base;
    let score = base;
    const add = (n, text) => { score += n; notes.push({ text, effect: n > 0 ? 1 : n < 0 ? -1 : 0 }); };

    if (kind === 'scholarly' && doi) notes.push({ text: 'Has a DOI, the ID published research gets.', effect: 0 });
    if (base !== K.base) notes.push({ text: 'Published by a university press.', effect: 1 });
    if (kind === 'book' && !publisher && !squash(s.siteName)) add(-5, 'No publisher listed.');

    // Who wrote it and when matter most where the site itself doesn't vouch for it
    const hasAuthor = (Array.isArray(s.authors) ? s.authors : []).some(a => squash(a));
    const year = yearOf(s.published);
    const authorCounts = ['web', 'selfpub', 'video', 'news', 'book'].includes(kind);
    const dateCounts = ['web', 'selfpub', 'video', 'news'].includes(kind);
    if (!s.fromWritten) {
      if (authorCounts) {
        if (hasAuthor && kind !== 'news' && kind !== 'book') add(5, 'Names an author.');
        else if (!hasAuthor) add(kind === 'book' ? -5 : -10, 'No author named.');
      }
      if (dateCounts) {
        if (year && kind !== 'news') add(5, 'Has a date.');
        else if (!year) add(-5, 'No date: you can’t tell how current it is.');
      }
    }
    if (year && nowYear - year > 10 && ['web', 'selfpub', 'video', 'news', 'org', 'edu', 'reference'].includes(kind)) add(-5, `From ${year}: check it’s still up to date.`);
    else if (year && nowYear - year > 20 && (kind === 'scholarly' || kind === 'book')) notes.push({ text: `From ${year}: look for newer research on the same question.`, effect: 0 });
    if (kind === 'news' && u && OPINION.test(u.path)) add(-10, 'An opinion piece: one writer’s view, not news reporting.');
    const tld = kind === 'web' && u && /\.(xyz|top|click|buzz|info|biz|live|news)$/.exec(u.host);
    if (tld) notes.push({ text: `Its address ends in ${tld[0]}, which many ad and fake-news sites use: check who runs it.`, effect: 0 });
    if (s.fromWritten) notes.push({ text: `Graded from the ${doi ? 'DOI' : 'link'} in your citation.`, effect: 0 });

    // An author and a date can't lift a source out of its kind's grade (a
    // website with both is still a C); below C, they can lift it to a low C
    score = Math.max(0, Math.min(score, base >= 85 ? 100 : base >= 70 ? 84 : base >= 50 ? 69 : 54));
    const g = letterFor(score);
    return { letter: g.letter, word: g.word, score, kind, label: K.label, why: K.why, host: u ? u.host : '', notes };
  }

  // The same for a bare address (the extension, while the student browses)
  const gradeUrl = (url, opts) => grade({ type: 'webpage', url, authors: [] }, opts);

  const api = { grade, gradeUrl, KINDS, GRADES, SITES };
  root.VisorSourceGrade = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
