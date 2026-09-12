/**
 * THEMES — one palette source shared by the editor, the print view, and PPTX
 * export. Slide styling reads CSS variables, so a theme switch is a single
 * attribute change rather than a per-component repaint.
 *
 * `accent` in the schema is a TOKEN NAME (e.g. 'accent', 'accent2'), never a
 * hex value. That is what keeps AI-authored slides theme-compatible: the model
 * picks a semantic role and the theme decides the colour.
 */
export interface Theme {
  name: string;
  label: string;
  /** CSS custom properties applied to the slide surface. */
  vars: Record<string, string>;
  /** Recharts needs real colour values, not CSS vars, for SVG fills. */
  chartColors: string[];
  /** Used by the PPTX exporter, which cannot read CSS. */
  pptx: { bg: string; title: string; body: string; accent: string };
}

// `satisfies` (not `:`) so the keys stay literal and callers get the
// ThemeName union rather than a widened `string`.
export const THEMES = {
  sunrise: {
    name: 'sunrise',
    label: 'Sunrise',
    vars: {
      '--slide-bg': '#fffbf5',
      '--slide-bg-alt': '#fdf1e3',
      '--slide-fg': '#2b1a10',
      '--slide-muted': '#8a6a53',
      '--slide-accent': '#c2410c',
      '--slide-accent-2': '#9d174d',
      '--slide-border': '#f2e2d0',
      '--slide-font-title': "'Inter', system-ui, sans-serif",
      '--slide-font-body': "'Inter', system-ui, sans-serif",
    },
    chartColors: ['#c2410c', '#9d174d', '#a16207', '#0f766e'],
    pptx: { bg: 'FFFBF5', title: '2B1A10', body: '6B4A33', accent: 'C2410C' },
  },
  paper: {
    name: 'paper',
    label: 'Paper',
    vars: {
      '--slide-bg': '#fdfdfc',
      '--slide-bg-alt': '#f4f4f2',
      '--slide-fg': '#1a1a1c',
      '--slide-muted': '#71717a',
      '--slide-accent': '#4f46e5',
      '--slide-accent-2': '#0d9488',
      '--slide-border': '#e6e6e4',
      '--slide-font-title': "'Inter', system-ui, sans-serif",
      '--slide-font-body': "'Inter', system-ui, sans-serif",
    },
    chartColors: ['#4f46e5', '#0d9488', '#f59e0b', '#e11d48'],
    pptx: { bg: 'FDFDFC', title: '1A1A1C', body: '52525B', accent: '4F46E5' },
  },
  midnight: {
    name: 'midnight',
    label: 'Midnight',
    vars: {
      '--slide-bg': '#16161a',
      '--slide-bg-alt': '#212127',
      '--slide-fg': '#f4f4f5',
      '--slide-muted': '#a1a1aa',
      '--slide-accent': '#818cf8',
      '--slide-accent-2': '#2dd4bf',
      '--slide-border': '#32323a',
      '--slide-font-title': "'Inter', system-ui, sans-serif",
      '--slide-font-body': "'Inter', system-ui, sans-serif",
    },
    chartColors: ['#818cf8', '#2dd4bf', '#fbbf24', '#fb7185'],
    pptx: { bg: '16161A', title: 'F4F4F5', body: 'C4C4CC', accent: '818CF8' },
  },
} satisfies Record<string, Theme>;

export type ThemeKey = keyof typeof THEMES;

export function getTheme(name: string): Theme {
  return (THEMES as Record<string, Theme>)[name] ?? THEMES.sunrise;
}

/** Resolve a schema accent token to a concrete colour for a given theme. */
export function resolveAccent(theme: Theme, token?: string): string {
  if (!token) return theme.vars['--slide-accent'];
  if (token === 'accent-2' || token === 'accent2') return theme.vars['--slide-accent-2'];
  if (token.startsWith('#')) return token; // tolerate a hex if the model insists
  return theme.vars['--slide-accent'];
}
