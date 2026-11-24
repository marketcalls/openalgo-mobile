// GENERATED from openalgo c8b2896ca8e9cb2d0200be29fbb3e9a162ac5276 (frontend/src/index.css) by scripts/gen-tokens.mjs. Do not edit.
export const tokens = {
  light: {
    background: '#ffffff',
    foreground: '#0a0a0a',
    card: '#ffffff',
    cardForeground: '#0a0a0a',
    popover: '#ffffff',
    popoverForeground: '#0a0a0a',
    primary: '#171717',
    primaryForeground: '#fafafa',
    secondary: '#f5f5f5',
    secondaryForeground: '#171717',
    muted: '#f5f5f5',
    mutedForeground: '#737373',
    accent: '#f5f5f5',
    accentForeground: '#171717',
    destructive: '#e7000b',
    border: '#e5e5e5',
    input: '#e5e5e5',
    ring: '#a1a1a1'
  },
  dark: {
    background: '#0a0a0a',
    foreground: '#fafafa',
    card: '#171717',
    cardForeground: '#fafafa',
    popover: '#171717',
    popoverForeground: '#fafafa',
    primary: '#e5e5e5',
    primaryForeground: '#171717',
    secondary: '#262626',
    secondaryForeground: '#fafafa',
    muted: '#262626',
    mutedForeground: '#a1a1a1',
    accent: '#262626',
    accentForeground: '#fafafa',
    destructive: '#ff6467',
    border: '#ffffff1a',
    input: '#ffffff26',
    ring: '#737373'
  },
  analyzer: {
    background: '#0b0c16',
    foreground: '#ebedfc',
    card: '#141521',
    cardForeground: '#ebedfc',
    popover: '#141521',
    popoverForeground: '#ebedfc',
    primary: '#8b8cff',
    primaryForeground: '#f8f8f8',
    secondary: '#262738',
    secondaryForeground: '#ebedfc',
    muted: '#262835',
    mutedForeground: '#9a9db1',
    accent: '#262738',
    accentForeground: '#ebedfc',
    destructive: '#f14d4c',
    border: '#36384f',
    input: '#36384f',
    ring: '#8b8cff'
  },
  trade: {
    light: {
      profit: '#00a63e',
      loss: '#e7000b',
      buy: '#00a63e',
      sell: '#e7000b',
      onBuy: '#ffffff',
      onSell: '#ffffff'
    },
    dark: {
      profit: '#05df72',
      loss: '#ff6467',
      buy: '#00a63e',
      sell: '#e7000b',
      onBuy: '#ffffff',
      onSell: '#ffffff'
    }
  }
} as const

export type Palette = typeof tokens.light
export type TradePalette = typeof tokens.trade.light
