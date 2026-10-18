/* ============================================================================
 * Visor — What the percentages count
 * ----------------------------------------------------------------------------
 * Each person's percentage is their share of the text added to the document.
 * Two settings decide whether pasted text counts toward it, both on (pastes
 * left out) unless switched off:
 *
 *   visor_share_excl_ext   leave out pastes from outside the document
 *   visor_share_excl_int   leave out text copied or moved within it
 *
 * With both on, the percentages say who wrote the document rather than who
 * brought text into it. Shared by the bar in the document, the AWARE panel and
 * the side panel, so every percentage on screen agrees. The setting lives in
 * chrome.storage.local, so changing it in one place changes it everywhere.
 * ==========================================================================*/

'use strict';

const VISOR_SHARE_EXT_KEY = 'visor_share_excl_ext';
const VISOR_SHARE_INT_KEY = 'visor_share_excl_int';

/** The settings from what's stored: anything but an explicit false is on. */
function visorShareSettings(stored) {
  const s = stored || {};
  return {
    excludeExternal: s[VISOR_SHARE_EXT_KEY] !== false,
    excludeInternal: s[VISOR_SHARE_INT_KEY] !== false
  };
}

/**
 * The contributors with `share` recounted under the settings, largest first.
 * `counted` is the characters that count for each. Copies; the analysis
 * itself is left as it was.
 */
function visorShares(contributors, settings) {
  const o = settings || visorShareSettings();
  const list = contributors || [];
  const counted = list.map((c) => Math.max(0, (c.inserted || 0)
    - (o.excludeExternal ? (c.externalPastedChars || 0) : 0)
    - (o.excludeInternal ? (c.internalPastedChars || 0) : 0)));
  const total = counted.reduce((a, b) => a + b, 0);
  return list
    .map((c, i) => ({ ...c, share: total ? counted[i] / total : 0, counted: counted[i] }))
    .sort((a, b) => b.share - a.share || b.inserted - a.inserted);
}

/** A few words for what the percentages count, for a button's label. */
function visorShareLabel(o) {
  if (o.excludeExternal && o.excludeInternal) return 'Excl. pastes';
  if (o.excludeExternal) return 'Excl. outside pastes';
  if (o.excludeInternal) return 'Excl. pastes from within';
  return 'All text';
}

if (typeof module === 'object' && module.exports) {
  module.exports = { visorShares, visorShareSettings, visorShareLabel, VISOR_SHARE_EXT_KEY, VISOR_SHARE_INT_KEY };
}
