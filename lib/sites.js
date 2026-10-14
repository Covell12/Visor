// Sites Visor treats as AI writing tools or answer sites. Writing assignments
// start with this list in blockedSites; a teacher can edit it per assignment.
// The extension keeps the same list in extension/config.js: change both.
//
// Entries are hostnames (matched with their subdomains) or host + path
// prefixes like "huggingface.co/chat".
const DEFAULT_AI_SITES = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'gemini.google.com', 'aistudio.google.com', 'claude.ai',
  'perplexity.ai', 'copilot.microsoft.com', 'poe.com', 'character.ai', 'deepseek.com', 'chat.deepseek.com',
  'meta.ai', 'you.com', 'phind.com', 'quillbot.com', 'chat.mistral.ai', 'grok.com', 'x.ai', 'huggingface.co/chat',
  'jasper.ai', 'writesonic.com', 'rytr.me', 'copy.ai', 'hix.ai', 'undetectable.ai', 'stealthgpt.ai',
  'studocu.com', 'coursehero.com', 'chegg.com', 'brainly.com', 'gptzero.me',
  'duck.ai', 'notebooklm.google.com', 'pi.ai', 'chat.qwen.ai', 'kimi.com', 'wordtune.com'
];

// "https://www.Example.com/path?q" -> "www.example.com/path" style site entry.
// Keeps an optional path prefix; drops scheme, port, query and trailing slash.
function normalizeSite(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const slash = s.indexOf('/');
  let host = slash < 0 ? s : s.slice(0, slash);
  const path = slash < 0 ? '' : s.slice(slash);
  host = host.replace(/:\d+$/, '').replace(/^\*\./, '');
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host)) return '';
  return (host + path).slice(0, 200);
}

function normalizeSiteList(list, max = 300) {
  const arr = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[\s,]+/) : [];
  return [...new Set(arr.map(normalizeSite).filter(Boolean))].slice(0, max);
}

// Does a URL (or bare hostname) fall under any entry? "chat.openai.com"
// matches "openai.com"; "huggingface.co/chat/x" matches "huggingface.co/chat".
function siteMatches(urlOrHost, list) {
  let host = '', path = '/';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`);
    host = u.hostname.toLowerCase(); path = u.pathname.toLowerCase();
  } catch { return null; }
  for (const entry of list || []) {
    const slash = entry.indexOf('/');
    const eh = slash < 0 ? entry : entry.slice(0, slash);
    const ep = slash < 0 ? '' : entry.slice(slash);
    if ((host === eh || host.endsWith('.' + eh)) && (!ep || path === ep || path.startsWith(ep + '/'))) return entry;
  }
  return null;
}

module.exports = { DEFAULT_AI_SITES, normalizeSite, normalizeSiteList, siteMatches };
