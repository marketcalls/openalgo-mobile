# 🎨 Analyzer Mode & Broker Display - UI Guide

## 📱 Settings Screen Layout

The Settings screen now displays three key sections with your requested features:

```
┌─────────────────────────────────────────┐
│  Settings                    [Logout 🚪]│
├─────────────────────────────────────────┤
│                                         │
│  📊 Header Indices                      │
│  ├─ ☑ NIFTY 50                         │
│  ├─ ☐ BANK NIFTY                       │
│  ├─ ☐ INDIA VIX                        │
│  └─ ☑ SENSEX                           │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  🔬/📈 Trading Mode              [🎚️]  │  ✅ NEW: Analyzer Toggle
│  ├─ Analyze Mode / Live Mode           │
│  └─ Virtual trading / Real trading     │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  💰 Account Funds                       │
│  ├─ Available Cash:    ₹500,000.00     │
│  ├─ Used Margin:       ₹100,000.00     │
│  ├─ M2M Realized:      ₹5,000.00       │
│  └─ M2M Unrealized:    ₹-2,000.00      │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  🔗 Connection                          │
│  ├─ Connected Broker: Zerodha          │  ✅ NEW: Broker Display
│  ├─ Host URL: https://api.example.com  │
│  ├─ WebSocket URL: wss://ws.example... │
│  └─ API Key: •••••••••••••••           │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  ℹ️ About                                │
│  ├─ OpenAlgo Terminal                  │
│  ├─ Version 1.0.0                      │
│  ├─ [API Status Check]                 │
│  └─ [Toggle Theme]                     │
│                                         │
└─────────────────────────────────────────┘
```

---

## 🎯 Feature 1: Analyzer Mode Toggle

### Visual States

#### Live Mode (Default)
```
┌─────────────────────────────────────────┐
│  📈 Trading Mode              [──○]     │  ← Green icon, switch OFF
│  ├─ Live Mode                           │  ← Text in primary color
│  └─ Real trading with actual funds      │  ← Gray subtitle
└─────────────────────────────────────────┘
```

#### Analyze Mode (Active)
```
┌─────────────────────────────────────────┐
│  🔬 Trading Mode              [●──]     │  ← Orange icon, switch ON
│  ├─ Analyze Mode                        │  ← Text in primary color
│  └─ Virtual trading with ₹1 Crore...   │  ← Gray subtitle
└─────────────────────────────────────────┘
```

#### Loading State
```
┌─────────────────────────────────────────┐
│  📈/🔬 Trading Mode           [⏳]      │  ← Spinner during API call
│  ├─ [Current Mode]                      │
│  └─ [Description]                       │
└─────────────────────────────────────────┘
```

### Interaction Flow

**Step 1: User Taps Switch**
```
User: *Taps toggle switch*
  ↓
App: Shows loading spinner
```

**Step 2: API Call**
```
POST /api/v1/analyzer/toggle
{
  "apikey": "your_api_key",
  "mode": true  // or false
}
```

**Step 3: Success Feedback**
```
┌─────────────────────────────────────────┐
│  ✅ Switched to Analyze Mode            │  ← Toast notification
│                                         │    (Orange for Analyze,
└─────────────────────────────────────────┘     Green for Live)
```

**Step 4: Error Feedback**
```
┌─────────────────────────────────────────┐
│  ❌ Failed to toggle mode: [error]      │  ← Red toast notification
└─────────────────────────────────────────┘
```

### Color Indicators

| Mode        | Icon  | Icon Color      | Switch Color    |
|-------------|-------|-----------------|-----------------|
| Live Mode   | 📈    | Green (#4CAF50) | Default Gray    |
| Analyze Mode| 🔬    | Orange (#FF9800)| Orange (#FF9800)|

---

## 🎯 Feature 2: Current Analyzer Status Display

### Initialization Flow

```
Settings Screen Opens
  ↓
[Fetch Analyzer Status API Call]
  ↓
POST /api/v1/analyzer
{
  "apikey": "your_api_key"
}
  ↓
Response:
{
  "status": "success",
  "data": {
    "mode": true  // or "analyze_mode" or "analyzermode"
  }
}
  ↓
Update UI with Actual Mode
```

### API Field Name Support

The app supports **multiple field name formats** for maximum compatibility:

```dart
// Priority order:
1. data['mode']          ← Primary (your spec)
2. data['analyze_mode']  ← Alternative
3. data['analyzermode']  ← Fallback
```

**Example API Responses (All Supported):**

**Format 1:**
```json
{
  "status": "success",
  "data": {
    "mode": true
  }
}
```

**Format 2:**
```json
{
  "status": "success",
  "data": {
    "analyze_mode": false
  }
}
```

**Format 3:**
```json
{
  "status": "success",
  "data": {
    "analyzermode": true
  }
}
```

---

## 🎯 Feature 3: Broker Name Display

### Connection Section Layout

```
┌─────────────────────────────────────────┐
│  🔗 Connection                          │
│                                         │
│  Connected Broker                       │  ✅ NEW: Shows broker name
│  Zerodha                                │      from /api/v1/ping
│                                         │
│  Host URL                               │
│  https://demo.openalgo.in               │
│                                         │
│  WebSocket URL                          │
│  wss://demo.openalgo.in/ws              │
│                                         │
│  API Key                                │
│  •••••••••••••••                        │
│                                         │
└─────────────────────────────────────────┘
```

### API Call Flow

```
Settings Screen Opens
  ↓
[Fetch Broker Info API Call]
  ↓
POST /api/v1/ping
{
  "apikey": "your_api_key"
}
  ↓
Response:
{
  "status": "success",
  "data": {
    "broker": "Zerodha"  // or "broker_name"
  }
}
  ↓
Display Broker Name in Connection Section
```

### API Field Name Support

The app supports **both field name formats**:

```dart
// Priority order:
1. data['broker']       ← Primary (your spec)
2. data['broker_name']  ← Alternative
```

**Example API Responses (Both Supported):**

**Format 1:**
```json
{
  "status": "success",
  "data": {
    "broker": "Zerodha"
  }
}
```

**Format 2:**
```json
{
  "status": "success",
  "data": {
    "broker_name": "Angel One"
  }
}
```

### Graceful Degradation

If the broker API call fails:
```
┌─────────────────────────────────────────┐
│  🔗 Connection                          │
│                                         │
│  (No "Connected Broker" row shown)     │  ← Gracefully hidden
│                                         │
│  Host URL                               │
│  https://demo.openalgo.in               │
│  ...                                    │
└─────────────────────────────────────────┘
```

---

## 🎨 Visual Design Elements

### Icons Used

| Feature              | Icon          | Color       | Size |
|----------------------|---------------|-------------|------|
| Trading Mode (Live)  | Icons.show_chart (📈) | Green | 28px |
| Trading Mode (Analyze)| Icons.science (🔬) | Orange | 28px |
| Connection           | Icons.link (🔗) | Blue   | 28px |
| Header Indices       | Icons.candlestick_chart | Blue | 28px |

### Color Palette

| Element            | Light Mode      | Dark Mode       |
|--------------------|-----------------|-----------------|
| Success (Live)     | #4CAF50 (Green) | #4CAF50 (Green) |
| Warning (Analyze)  | #FF9800 (Orange)| #FF9800 (Orange)|
| Accent (Blue)      | #2196F3 (Blue)  | #42A5F5 (Blue)  |
| Error (Red)        | #F44336 (Red)   | #EF5350 (Red)   |
| Text Primary       | #212121 (Black) | #FFFFFF (White) |
| Text Secondary     | #757575 (Gray)  | #BDBDBD (Gray)  |

### Card Styling

```
All sections use Material Card widget:
- Elevation: 2
- Border Radius: 8px
- Padding: 16px
- Margin: 8px vertical
```

---

## 🧪 User Testing Scenarios

### Scenario 1: Verify Current Mode on App Launch
```
1. Open OpenAlgo Terminal app
2. Navigate to Settings tab (bottom navigation)
3. Scroll to "Trading Mode" section
4. ✅ Verify: Mode shows actual backend state (not hardcoded "Live")
5. ✅ Verify: Icon and color match the mode
```

### Scenario 2: Toggle Analyzer Mode
```
1. In Settings, find "Trading Mode" section
2. Tap the toggle switch
3. ✅ Verify: Loading spinner appears briefly
4. ✅ Verify: Success toast appears ("Switched to [Mode]")
5. ✅ Verify: Icon changes (📈 ↔ 🔬)
6. ✅ Verify: Color changes (Green ↔ Orange)
7. ✅ Verify: Text updates (Live Mode ↔ Analyze Mode)
8. ✅ Verify: Description updates (Real trading ↔ Virtual trading)
```

### Scenario 3: Verify Broker Display
```
1. Open Settings tab
2. Scroll to "Connection" section
3. ✅ Verify: "Connected Broker" row is visible
4. ✅ Verify: Broker name shows (e.g., "Zerodha", "Angel One")
5. ✅ Verify: Name is NOT "Unknown" or "null"
```

### Scenario 4: Error Handling
```
1. Disconnect network/WiFi
2. Try toggling analyzer mode
3. ✅ Verify: Error toast appears with message
4. ✅ Verify: Mode reverts to previous state
5. ✅ Verify: App doesn't crash
```

### Scenario 5: Pull-to-Refresh
```
1. In Settings screen, pull down to refresh
2. ✅ Verify: Refresh animation appears
3. ✅ Verify: All three APIs are called again:
   - Analyzer status
   - Broker info  
   - Funds
4. ✅ Verify: UI updates with latest data
```

---

## 📱 Mobile & Web Preview

### Mobile View (Portrait)
```
┌─────────────────┐
│  Settings   🚪  │
├─────────────────┤
│                 │
│  📊 Header      │
│  Indices        │
│  ☑ NIFTY 50    │
│  ☑ SENSEX      │
│                 │
├─────────────────┤
│                 │
│  🔬 Trading     │
│  Mode    [●──]  │  ← Full width switch
│  Analyze Mode   │
│  Virtual...     │
│                 │
├─────────────────┤
│                 │
│  🔗 Connection  │
│  Broker:        │
│  Zerodha        │
│  Host: ...      │
│                 │
└─────────────────┘
```

### Web/Tablet View (Wider)
```
┌───────────────────────────────────────────┐
│  Settings                      [Logout 🚪]│
├───────────────────────────────────────────┤
│                                           │
│  📊 Header Indices                        │
│  ☑ NIFTY 50  ☐ BANK NIFTY                │  ← Side by side
│  ☐ INDIA VIX ☑ SENSEX                    │
│                                           │
├───────────────────────────────────────────┤
│                                           │
│  🔬 Trading Mode              [●──]       │  ← More spacing
│  Analyze Mode                             │
│  Virtual trading with ₹1 Crore capital   │
│                                           │
├───────────────────────────────────────────┤
│                                           │
│  🔗 Connection                            │
│  Connected Broker: Zerodha                │  ← Inline layout
│  Host URL: https://demo.openalgo.in      │
│  ...                                      │
│                                           │
└───────────────────────────────────────────┘
```

---

## 🎯 Success Criteria

All three features are considered successfully implemented when:

- [x] **Analyzer Toggle**: Switch widget changes mode via API
- [x] **Current Status**: Mode displayed matches backend (not default)
- [x] **Broker Display**: Shows broker name from ping API
- [x] **Loading States**: Spinners shown during API calls
- [x] **Error Handling**: User-friendly error messages
- [x] **Visual Feedback**: Toast notifications confirm actions
- [x] **Field Flexibility**: Supports multiple API field name formats
- [x] **Graceful Degradation**: Works even if broker API fails
- [x] **Responsive Design**: Works on mobile and web
- [x] **Pull-to-Refresh**: Updates all data including new features

---

## 📸 Screenshot Locations (for reference)

When testing, capture these views:

1. **Settings Overview**: Full settings screen with all sections
2. **Live Mode**: Trading Mode section showing Live Mode
3. **Analyze Mode**: Trading Mode section showing Analyze Mode
4. **Broker Display**: Connection section with broker name
5. **Toggle Action**: Screenshot showing toast notification
6. **Loading State**: Screenshot with loading spinner visible
7. **Error State**: Screenshot with error toast message

---

**Last Updated**: 2025-01-31  
**App Version**: 1.0.0  
**Status**: ✅ All UI features implemented and tested
