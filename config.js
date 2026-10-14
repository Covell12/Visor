/* ============================================================================
 * Visor — Configuration
 * ----------------------------------------------------------------------------
 * Where the Visor web app lives, and the list of AI sites a writing session
 * flags or blocks.
 *
 * VISOR_WEB_ORIGINS must match the "matches" of the site-bridge.js content
 * script in manifest.json, origin for origin. If Visor moves to another
 * address (a custom domain, a school's own copy), change BOTH places, then
 * reload the extension. The service worker loads this file with importScripts;
 * the session panel and blocked page load it with a <script> tag.
 *
 * DEFAULT_AI_SITES is a copy of web-app/lib/sites.js. Keep them the same. A
 * teacher can edit the list per assignment; the session uses theirs.
 * ==========================================================================*/

'use strict';

(function (root) {
  const VISOR_WEB_ORIGINS = [
    'http://localhost:3000',
    'https://visor-ed.web.app',
    'https://visor-ed.firebaseapp.com'
  ];

  // Used when the extension isn't connected yet (formatting a citation outside a session)
  const VISOR_DEFAULT_ORIGIN = 'https://visor-ed.web.app';

  const DEFAULT_AI_SITES = [
    'chatgpt.com', 'chat.openai.com', 'openai.com', 'gemini.google.com', 'aistudio.google.com', 'claude.ai',
    'perplexity.ai', 'copilot.microsoft.com', 'poe.com', 'character.ai', 'deepseek.com', 'chat.deepseek.com',
    'meta.ai', 'you.com', 'phind.com', 'quillbot.com', 'chat.mistral.ai', 'grok.com', 'x.ai', 'huggingface.co/chat',
    'jasper.ai', 'writesonic.com', 'rytr.me', 'copy.ai', 'hix.ai', 'undetectable.ai', 'stealthgpt.ai',
    'studocu.com', 'coursehero.com', 'chegg.com', 'brainly.com', 'gptzero.me',
    'duck.ai', 'notebooklm.google.com', 'pi.ai', 'chat.qwen.ai', 'kimi.com', 'wordtune.com'
  ];

  // Is this page part of Visor itself? (Never recorded as research.)
  function isVisorOrigin(url) {
    try { return VISOR_WEB_ORIGINS.includes(new URL(url).origin); } catch (_) { return false; }
  }

  root.VisorConfig = { VISOR_WEB_ORIGINS, VISOR_DEFAULT_ORIGIN, DEFAULT_AI_SITES, isVisorOrigin };
})(typeof self !== 'undefined' ? self : this);
