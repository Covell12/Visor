/* ============================================================================
 * Visor — Theme
 * ----------------------------------------------------------------------------
 * Three choices: Light, Dark, and System (follow the computer's appearance,
 * and keep following it when it changes). Light is the default: the system
 * setting is only consulted once the user has picked System, so the extension
 * still opens light regardless of what the OS is doing until asked otherwise.
 *
 * The stored value is the *choice*; what the page shows is the *resolved*
 * theme (always 'light' or 'dark'). `data-theme` carries the resolved one, so
 * every stylesheet keeps keying off light/dark only; `data-theme-choice`
 * carries the choice, for the control that shows it.
 *
 * Shared by the side panel, the replay window and the injected HUD so all
 * three stay in step.
 * ==========================================================================*/

'use strict';

const VISOR_THEME_KEY = 'visor_theme';
const VISOR_THEME_DEFAULT = 'light';
const VISOR_THEME_CHOICES = ['light', 'dark', 'system'];

/** A stored or passed value, made into a known choice. */
function visorThemeChoice(v) {
  return VISOR_THEME_CHOICES.includes(v) ? v : VISOR_THEME_DEFAULT;
}

function visorSystemDark() {
  try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) { return false; }
}

/** The theme a choice shows right now: light or dark. */
function visorResolveTheme(choice) {
  const c = visorThemeChoice(choice);
  if (c === 'system') return visorSystemDark() ? 'dark' : 'light';
  return c;
}

let visorThemeCurrent = VISOR_THEME_DEFAULT;   // the choice in force on this page

function visorApplyTheme(choice) {
  visorThemeCurrent = visorThemeChoice(choice);
  const t = visorResolveTheme(visorThemeCurrent);
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.setAttribute('data-theme-choice', visorThemeCurrent);
  document.documentElement.style.colorScheme = t;
  return t;
}

/** The stored choice, falling back to light. */
function visorLoadTheme() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(VISOR_THEME_KEY, (res) => {
        if (chrome.runtime.lastError) return resolve(VISOR_THEME_DEFAULT);
        resolve(visorThemeChoice(res && res[VISOR_THEME_KEY]));
      });
    } catch (_) {
      resolve(VISOR_THEME_DEFAULT);
    }
  });
}

function visorSaveTheme(choice) {
  try { chrome.storage.local.set({ [VISOR_THEME_KEY]: visorThemeChoice(choice) }); } catch (_) { /* no-op */ }
}

/** Paint the stored theme before first paint to avoid a flash of the wrong one. */
async function visorInitTheme() {
  const c = await visorLoadTheme();
  visorApplyTheme(c);
  return c;
}

/** The choice after this one: Light → Dark → System → Light. */
function visorNextTheme(choice) {
  const i = VISOR_THEME_CHOICES.indexOf(visorThemeChoice(choice));
  return VISOR_THEME_CHOICES[(i + 1) % VISOR_THEME_CHOICES.length];
}

/**
 * Move to the next choice and remember it.
 *
 * This used to expand a coloured wash from the point clicked. It looked like a
 * screensaver, and it put a full-window animated overlay over the panel for a
 * second every time. The palette simply changes; the short colour transition
 * in the stylesheet is what keeps it from being a hard cut.
 */
function visorCycleTheme() {
  const next = visorNextTheme(visorThemeCurrent);
  visorApplyTheme(next);
  visorSaveTheme(next);
  return next;
}
// (the older name, for anything still calling it)
const visorToggleTheme = visorCycleTheme;

// With System chosen, follow the computer when its appearance changes, and
// follow a choice made in another Visor window (the side panel, say).
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (visorThemeCurrent === 'system') visorApplyTheme('system');
  });
} catch (_) { /* no matchMedia: light it is */ }
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[VISOR_THEME_KEY]) visorApplyTheme(changes[VISOR_THEME_KEY].newValue);
  });
} catch (_) { /* not in an extension page */ }

// Apply light immediately so nothing renders in the wrong palette while the
// stored preference is being read.
visorApplyTheme(VISOR_THEME_DEFAULT);
