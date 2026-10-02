/**
 * themes.js - AionDX's two themes, in AionUi's own theme format (common/theme/types.ts: id, name,
 * appearance, tokens, css). Installed into `theme.userThemes` by install.js, they show in AionUi's
 * Settings > Appearance gallery beside Light and Dark, and AionUi's own theme editor can change them.
 *
 * a request of 2026-09-25.
 *
 * Everything accent-coloured reads one variable, --aiondx-accent (default teal #2dd4bf, the colour
 * of the AionDX mark). The accent picker AionDX adds to Settings > Appearance overrides it (and its
 * RGB forms, which Arco's colour scales need) with a higher-specificity rule; switching "accent
 * dividing lines" off points the divider variables back at a neutral grey.
 *
 * No `cover`: AionUi turns a user theme's cover into the app's background image
 * (CssThemeSettings ensureBackgroundCss). Without one the gallery draws a preview from the tokens.
 *
 * AionDX Dark's neutrals are plain greys (a request of 2026-09-25). They were a navy tint (#0c1017 and kin); each became the grey of the same
 * lightness, CIE L*.
 *
 * Baselines for "darker" (AionUi 2.2.2's default scheme): dark #0e0e0e / #1a1a1a / #262626 with
 * #333333 dividers; light #ffffff / #f9fafb / #f2f3f5 with #e5e6eb dividers.
 */
'use strict';

const ACCENT = '#2dd4bf';
const ACCENT_RGB = '45, 212, 191';
const ACCENT_STRONG_RGB = '31, 148, 134';   // 70% of the accent, for text and fills on the light theme

const DARK = {
  id: 'aiondx-dark',
  name: 'AionDX Dark',
  appearance: 'dark',
  builtin: false,
  tokens: {
    dark: {
      '--bg-base': '#090909',
      '--bg-1': '#101010',
      '--bg-2': '#181818',
      '--bg-3': 'var(--aiondx-divider)',
      '--bg-6': '#444444',
      '--bg-hover': '#1b1b1b',
      '--bg-active': '#232323',
      '--text-primary': '#eaeaea',
      '--text-secondary': '#aeaeae',
      '--text-disabled': '#606060',
      '--border-base': 'var(--aiondx-divider)',
      '--border-light': 'var(--aiondx-divider-soft)',
      '--border-special': 'var(--aiondx-divider)',
      '--primary': 'var(--aiondx-accent)',
      '--brand': 'var(--aiondx-accent)',
      '--brand-light': 'color-mix(in srgb, var(--aiondx-accent) 16%, #101010)',
      '--brand-hover': 'color-mix(in srgb, var(--aiondx-accent) 70%, #ffffff)',
      '--message-user-bg': 'color-mix(in srgb, var(--aiondx-accent) 14%, #101010)',
      '--message-tips-bg': '#161616',
      '--workspace-btn-bg': '#181818',
      '--thought-gradient': 'linear-gradient(180deg, #141414 0%, #101010 100%)',
      '--fill': '#101010',
      '--fill-0': 'rgba(255, 255, 255, 0.05)',
      '--dialog-fill-0': '#181818',
    },
  },
  css: [
    ':root {',
    `  --aiondx-accent: ${ACCENT};`,
    `  --aiondx-accent-rgb: ${ACCENT_RGB};`,
    `  --aiondx-accent-strong-rgb: ${ACCENT_STRONG_RGB};`,
    '  --aiondx-divider: color-mix(in srgb, var(--aiondx-accent) 50%, #101010);',
    '  --aiondx-divider-soft: color-mix(in srgb, var(--aiondx-accent) 26%, #101010);',
    '}',
    ":root[data-theme='dark'] {",
    '  --bg-4: #232323;',
    '  --bg-5: #2c2c2c;',
    '  --bg-8: #767676;',
    '  --bg-9: #aeaeae;',
    '  --bg-10: #dcdcdc;',
    '}',
    "body[arco-theme='dark'] {",
    '  --color-bg-1: #101010;',
    '  --color-bg-2: #181818;',
    '  --color-bg-3: #1d1d1d;',
    '  --color-bg-4: #232323;',
    '  --color-bg-5: #2a2a2a;',
    '  --color-bg-white: #181818;',
    '  --color-bg-popup: #181818;',
    '  --color-border: var(--aiondx-divider);',
    '  --color-border-1: var(--aiondx-divider-soft);',
    '  --color-border-2: var(--aiondx-divider);',
    '  --color-border-3: var(--aiondx-divider);',
    '  --color-border-4: var(--aiondx-accent);',
    '  --color-neutral-3: var(--aiondx-divider-soft);',
    '  --color-fill-1: #171717;',
    '  --color-fill-2: #1d1d1d;',
    '  --color-fill-3: #242424;',
    '  --primary-5: var(--aiondx-accent-rgb);',
    '  --primary-6: var(--aiondx-accent-rgb);',
    '  --primary-7: var(--aiondx-accent-rgb);',
    '  --arcoblue-6: var(--aiondx-accent-rgb);',
    '}',
  ].join('\n'),
};

const LIGHT = {
  id: 'aiondx-light',
  name: 'AionDX Light',
  appearance: 'light',
  builtin: false,
  tokens: {
    light: {
      '--bg-base': '#eef1f5',
      '--bg-1': '#e6eaf0',
      '--bg-2': '#dde2ea',
      '--bg-3': 'var(--aiondx-divider)',
      '--bg-6': '#aab4c2',
      '--bg-hover': '#e1e6ee',
      '--bg-active': '#d5dce6',
      '--text-primary': '#111827',
      '--text-secondary': '#4b5563',
      '--text-disabled': '#9ca3af',
      '--border-base': 'var(--aiondx-divider)',
      '--border-light': 'var(--aiondx-divider-soft)',
      '--border-special': 'var(--aiondx-divider)',
      '--primary': 'rgb(var(--aiondx-accent-strong-rgb))',
      '--brand': 'rgb(var(--aiondx-accent-strong-rgb))',
      '--brand-light': 'color-mix(in srgb, var(--aiondx-accent) 18%, #eef1f5)',
      '--brand-hover': 'color-mix(in srgb, var(--aiondx-accent) 80%, #000000)',
      '--message-user-bg': 'color-mix(in srgb, var(--aiondx-accent) 16%, #eef1f5)',
      '--message-tips-bg': '#e3e8ef',
      '--workspace-btn-bg': '#e6eaf0',
      '--fill': '#e6eaf0',
      '--fill-0': '#f4f6f9',
      '--dialog-fill-0': '#eef1f5',
    },
  },
  css: [
    ':root {',
    `  --aiondx-accent: ${ACCENT};`,
    `  --aiondx-accent-rgb: ${ACCENT_RGB};`,
    `  --aiondx-accent-strong-rgb: ${ACCENT_STRONG_RGB};`,
    '  --aiondx-divider: color-mix(in srgb, var(--aiondx-accent) 60%, #dde2ea);',
    '  --aiondx-divider-soft: color-mix(in srgb, var(--aiondx-accent) 32%, #e6eaf0);',
    '}',
    "body[arco-theme='light'] {",
    '  --color-bg-1: #eef1f5;',
    '  --color-bg-2: #e6eaf0;',
    '  --color-bg-3: #dde2ea;',
    '  --color-bg-4: #d5dce6;',
    '  --color-bg-5: #ccd4df;',
    '  --color-bg-white: #f4f6f9;',
    '  --color-bg-popup: #f4f6f9;',
    '  --color-border: var(--aiondx-divider);',
    '  --color-border-1: var(--aiondx-divider-soft);',
    '  --color-border-2: var(--aiondx-divider);',
    '  --color-border-3: var(--aiondx-divider);',
    '  --color-border-4: rgb(var(--aiondx-accent-strong-rgb));',
    '  --color-neutral-3: var(--aiondx-divider-soft);',
    '  --color-fill-1: #e3e8ef;',
    '  --color-fill-2: #dae0e8;',
    '  --color-fill-3: #d0d8e2;',
    '  --primary-5: var(--aiondx-accent-strong-rgb);',
    '  --primary-6: var(--aiondx-accent-strong-rgb);',
    '  --primary-7: var(--aiondx-accent-strong-rgb);',
    '  --arcoblue-6: var(--aiondx-accent-strong-rgb);',
    '}',
  ].join('\n'),
};

module.exports = { THEMES: [DARK, LIGHT], ACCENT };
