/* ============================================================================
 * Concept art: shared scaffolding.
 * ----------------------------------------------------------------------------
 * Each concept is a self-contained page that draws the three surfaces side by
 * side — the side panel, the in-document bar, and the collapsed button — from
 * the same fictional document, so the directions can be compared like for like
 * rather than by imagination.
 *
 *   node tests/concepts/render.js            # all of them
 *   node tests/concepts/render.js console    # one
 * ==========================================================================*/

'use strict';

const DOC = {
  title: 'Thesis — Chapter 3 draft',
  words: '1,996',
  edits: '9,000',
  writing: '1h 52m',
  pastes: '24',
  deleted: '4,776',
  span: '1 day',
  externalPct: 4,
  people: [
    { name: 'Ethan Bernstein', first: 'Ethan', initials: 'EB', share: 58, chars: '8,997', mins: '56m', typed: 46, colour: '#2F6FC4' },
    { name: 'Sam Reyes',       first: 'Sam',   initials: 'SR', share: 26, chars: '4,025', mins: '34m', typed: 63, colour: '#118A7E' },
    { name: 'Maya Okonkwo',    first: 'Maya',  initials: 'MO', share: 17, chars: '2,581', mins: '22m', typed: 65, colour: '#B4603A' }
  ],
  // A plausible growth curve, as percentages of the final length.
  growth: [2, 5, 9, 12, 18, 21, 27, 33, 36, 42, 47, 51, 58, 61, 66, 72, 74, 79, 85, 88, 92, 95, 98, 100],
  hours: [0, 0, 0, 0, 2, 5, 9, 3, 6, 8, 7, 5, 9, 6, 2, 0, 0, 1, 4, 6, 3, 1, 0, 0]
};

/** A path through the growth curve, for an inline chart of width×height. */
function growthPath(w, h, pad = 2) {
  const pts = DOC.growth.map((v, i) => [
    pad + (i / (DOC.growth.length - 1)) * (w - pad * 2),
    h - pad - (v / 100) * (h - pad * 2)
  ]);
  return {
    line: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
    area: `${pad},${h - pad} ${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} ${w - pad},${h - pad}`
  };
}

module.exports = { DOC, growthPath };
