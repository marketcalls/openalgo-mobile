# Zerodha Kite Style Redesign - Complete Plan

## Current Status: In Progress

This document outlines the complete redesign to match Zerodha Kite's minimalist interface.

## Completed ✅

1. **Theme System**
   - Created light/dark theme (Zerodha colors)
   - Theme provider with persistence
   - Theme-aware helper methods

2. **API Endpoints Added**
   - `/api/v1/intervals` - Get supported timeframes
   - `/api/v1/history` - Historical candlestick data
   - `/api/v1/ping` - Broker connection status
   - `/api/v1/optionchain` - Option chain data

3. **Chart Screen**
   - TradingView lightweight-charts integration
   - EMA (20, 50) indicators
   - RSI (14) indicator
   - Multiple timeframes
   - Candle type selection

## Required Changes

### 1. Overview Drawer (Top Priority)

**File:** `lib/widgets/overview_drawer.dart` (NEW)

**Features:**
- Shows when tapping dropdown arrow in app bar
- Display NIFTY 50 and NIFTY BANK with mini charts
- Show available funds
- Slide from top animation

**Implementation:**
```dart
class OverviewDrawer extends StatelessWidget {
  - Fetch NIFTY 50, NIFTY BANK quotes
  - Display mini sparkline charts
  - Show funds from API
  - Close button
}
```

### 2. Simplified Watchlist

**File:** `lib/screens/watchlist_screen.dart` (MODIFY)

**Changes:**
- Remove B/S/Depth buttons
- Simple row layout: Symbol | Price | Change%
- Tap row → Show bottom sheet with BUY/SELL/Chart/Option Chain
- Clean white/dark background
- No cards, just dividers

**New Layout:**
```
BHEL                    285.15
NSE                +8.65 (+3.12%)
─────────────────────────────────
IDEA                     11.64
NSE                +0.39 (+3.46%)
```

### 3. Symbol Bottom Sheet

**File:** `lib/widgets/symbol_bottom_sheet.dart` (NEW)

**Features:**
- Shows when tapping symbol
- Large BUY and SELL buttons
- View Chart button (with chart icon)
- Option Chain button (for derivatives)
- Set Alert, Add Notes, Create GTT

**Layout:**
```
┌─────────────────────────────────┐
│ M&M                             │
│ NSE  3,679.60  +14.40 (+0.39%) │
├─────────────────────────────────┤
│  [  BUY  ]      [  SELL  ]     │
├─────────────────────────────────┤
│ 📊 View chart    ⚡ Option chain│
├─────────────────────────────────┤
│ 🔔 Set alert   📝 Add notes    │
└─────────────────────────────────┘
```

### 4. Chart Screen Updates

**File:** `lib/screens/chart_screen.dart` (MODIFY)

**Changes:**
- Default interval: 'D' (Daily)
- Clean toolbar at top
- Timeframe buttons: 1m, 5m, 15m, 1h, 1D
- Indicators button
- Drawing tools (optional)

**Current Status:** Already created, needs default interval fix

### 5. Option Chain Screen

**File:** `lib/screens/option_chain_screen.dart` (NEW)

**Features:**
- Strike price in center
- Call side (left) and Put side (right)
- OI, Volume, LTP for each
- Strike selection
- Expiry date selector

**Layout:**
```
Call LTP | Call OI | Strike | Put OI | Put LTP
  157    |   6.98% |  3550  | -25.10%|  17.9
 117.3   |   5.67% |  3600  | -24.05%|  28.25
  84.4   |   4.58% |  3650  | -18.36%|  45.8
```

### 6. Theme Switcher

**File:** `lib/screens/settings_screen.dart` (MODIFY)

**Changes:**
- Add theme toggle at top
- Use Provider to manage state
- Persist preference

**Implementation:**
```dart
SwitchListTile(
  title: Text('Dark Mode'),
  value: Provider.of<ThemeProvider>(context).isDarkMode,
  onChanged: (value) {
    Provider.of<ThemeProvider>(context, listen: false).toggleTheme();
  },
)
```

### 7. Main App Updates

**File:** `lib/main.dart` (MODIFY)

**Changes:**
- Wrap with ChangeNotifierProvider
- Use theme from ThemeProvider
- Support both light and dark themes

**Code:**
```dart
ChangeNotifierProvider(
  create: (_) => ThemeProvider(),
  child: Consumer<ThemeProvider>(
    builder: (context, themeProvider, _) {
      return MaterialApp(
        theme: AppTheme.lightTheme,
        darkTheme: AppTheme.darkTheme,
        themeMode: themeProvider.themeMode,
        // ...
      );
    },
  ),
)
```

### 8. Index Header Bar

**File:** `lib/widgets/index_header.dart` (NEW)

**Features:**
- Shows NIFTY 50 and SENSEX at top
- Always visible
- Tapping opens Overview drawer
- Small, compact design

**Layout:**
```
┌────────────────────────────────────┐
│ NIFTY 50  26,046.95  ▲ +148.40   │
│ SENSEX    59,389.95  ▲ +180.10   │
└────────────────────────────────────┘
```

### 9. Add Provider Dependency

**File:** `pubspec.yaml` (MODIFY)

```yaml
dependencies:
  provider: 6.1.5+1
```

## Implementation Priority

### Phase 1 (Critical - 2 hours)
1. ✅ Theme system (DONE)
2. Add Provider to pubspec.yaml
3. Update main.dart with ThemeProvider
4. Create Overview drawer
5. Simplify watchlist UI

### Phase 2 (Important - 1.5 hours)
6. Create Symbol bottom sheet
7. Update Chart screen default to 'D'
8. Add theme switcher to settings

### Phase 3 (Nice to have - 2 hours)
9. Create Option Chain screen
10. Add Index header bar
11. Polish and test

## Key Files Structure

```
lib/
├── main.dart (UPDATE - add Provider)
├── providers/
│   └── theme_provider.dart (CREATED ✅)
├── screens/
│   ├── watchlist_screen.dart (UPDATE - simplify)
│   ├── chart_screen.dart (UPDATE - default 'D')
│   ├── option_chain_screen.dart (CREATE)
│   └── settings_screen.dart (UPDATE - add theme toggle)
├── widgets/
│   ├── overview_drawer.dart (CREATE)
│   ├── symbol_bottom_sheet.dart (CREATE)
│   └── index_header.dart (CREATE)
└── utils/
    └── app_theme.dart (UPDATED ✅)
```

## Testing Checklist

- [ ] Light/Dark theme switch works
- [ ] Overview drawer shows indices and funds
- [ ] Watchlist simple rows display correctly
- [ ] Symbol bottom sheet shows on tap
- [ ] Chart opens with 'D' timeframe
- [ ] Option chain displays properly
- [ ] Theme persists after app restart
- [ ] All colors match Zerodha Kite

## Design Specifications

### Colors (Light Theme)
- Background: #FFFFFF
- Text Primary: #424242
- Text Secondary: #666666
- Border: #E0E3EB
- Profit: #00C48C
- Loss: #FF5B5B
- Accent: #4B7BEC

### Colors (Dark Theme)
- Background: #1F2933
- Surface: #2A3442
- Text Primary: #FFFFFF
- Text Secondary: #9CA3AF
- Border: #3E4C59
- Profit: #00C48C
- Loss: #FF5B5B
- Accent: #4B7BEC

### Typography
- Title: 18px, weight 500
- Body: 14px, weight 400
- Small: 12px, weight 400
- Numbers: Monospace font recommended

### Spacing
- Small: 4px
- Medium: 8px
- Large: 16px
- Card Padding: 12px
- Border Radius: 4px

## References

- Zerodha Kite Web: https://kite.zerodha.com
- TradingView Charts: https://www.tradingview.com/lightweight-charts/
- Material Design 3: https://m3.material.io

## Next Steps

1. Run `flutter pub add provider` to add dependency
2. Implement Phase 1 changes
3. Test theme switching
4. Build Overview drawer and Symbol bottom sheet
5. Polish UI to match Zerodha exactly

---

**Note:** This is a comprehensive redesign. Implement phase by phase to ensure stability.
