/* ============================================================================
 * Visor — Theme
 * ----------------------------------------------------------------------------
 * Light is the default. The system preference is never consulted: it would
 * override a choice the user made explicitly, and the extension is asked to
 * open light regardless of what the OS is doing.
 *
 * Shared by the side panel, the replay window and the injected HUD so all
 * three stay in step.
 * ==========================================================================*/

'use strict';

const VISOR_THEME_KEY = 'visor_theme';
const VISOR_THEME_DEFAULT = 'light';

function visorApplyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
  return t;
}

/** Resolve the stored theme, falling back to light. */
function visorLoadTheme() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(VISOR_THEME_KEY, (res) => {
        if (chrome.runtime.lastError) return resolve(VISOR_THEME_DEFAULT);
        resolve(res && res[VISOR_THEME_KEY] === 'dark' ? 'dark' : VISOR_THEME_DEFAULT);
      });
    } catch (_) {
      resolve(VISOR_THEME_DEFAULT);
    }
  });
}

function visorSaveTheme(theme) {
  try { chrome.storage.local.set({ [VISOR_THEME_KEY]: theme }); } catch (_) { /* no-op */ }
}

/** Paint the stored theme before first paint to avoid a flash of the wrong one. */
async function visorInitTheme() {
  const t = await visorLoadTheme();
  return visorApplyTheme(t);
}

/**
 * Switch themes.
 *
 * This used to expand a coloured wash from the point clicked. It looked like a
 * screensaver, and it put a full-window animated overlay over the panel for a
 * second every time. The palette simply changes; the short colour transition
 * in the stylesheet is what keeps it from being a hard cut.
 */
function visorToggleTheme() {
  const from = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = from === 'dark' ? 'light' : 'dark';
  visorApplyTheme(next);
  visorSaveTheme(next);
  return next;
}

// Apply light immediately so nothing renders in the wrong palette while the
// stored preference is being read.
visorApplyTheme(VISOR_THEME_DEFAULT);
