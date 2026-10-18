/* ============================================================================
 * Visor — Which Visor this is
 * ----------------------------------------------------------------------------
 *   'classroom'  this source tree: Google Docs history plus the Visor Classroom
 *                companion (writing sessions, research log, locked sessions,
 *                cite, sending reports to Visor).
 *   'docs'       the Docs-only build, made by tools/build-docs.js, which
 *                rewrites this file: Google Docs history only.
 *
 * Shared code checks globalThis.VISOR_EDITION before anything that belongs to
 * Visor Classroom. Extension pages also get it on <html data-edition>, so
 * their stylesheets can hide what an edition doesn't have.
 * ==========================================================================*/

globalThis.VISOR_EDITION = 'classroom';

try {
  if (location.protocol === 'chrome-extension:' && document.documentElement) {
    document.documentElement.setAttribute('data-edition', globalThis.VISOR_EDITION);
  }
} catch (_) { /* the service worker has no page */ }
