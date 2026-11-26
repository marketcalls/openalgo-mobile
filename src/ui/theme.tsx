import { createContext, type ReactNode, useContext } from 'react'
import { useColorScheme } from 'react-native'
import { usePrefs } from '~/core/config/prefs'
import { type Palette, type StatusPalette, type TradePalette, tokens } from './tokens'

// The tokens are literal-typed per scheme; the theme exposes plain colour strings.
type Colors<T> = { [K in keyof T]: string }

export type Scheme = 'light' | 'dark'

export type Theme = {
  scheme: Scheme
  /** The palette for the resolved scheme. */
  c: Colors<Palette>
  trade: Colors<TradePalette>
  /** The warning colours for the resolved scheme. */
  status: Colors<StatusPalette>
  /** The indigo palette the analyzer (sandbox) mode shows. */
  analyzer: Colors<Palette>
}

export function buildTheme(scheme: Scheme): Theme {
  return {
    scheme,
    c: tokens[scheme],
    trade: tokens.trade[scheme],
    status: tokens.status[scheme],
    analyzer: tokens.analyzer,
  }
}

/** `system` follows the device, and falls back to dark when the device reports nothing. */
export function resolveScheme(
  pref: 'system' | 'dark' | 'light',
  system: string | null | undefined,
) {
  if (pref === 'light' || pref === 'dark') return pref
  return system === 'light' ? 'light' : 'dark'
}

const ThemeContext = createContext<Theme>(buildTheme('dark'))

export function ThemeProvider({ children }: { children: ReactNode }) {
  const pref = usePrefs((s) => s.theme)
  const system = useColorScheme()
  return (
    <ThemeContext.Provider value={buildTheme(resolveScheme(pref, system))}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
