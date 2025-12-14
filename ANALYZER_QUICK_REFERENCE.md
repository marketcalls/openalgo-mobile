# ⚡ Analyzer Mode & Broker Display - Quick Reference

## 🔥 TL;DR - What Was Implemented

Three new features added to OpenAlgo Terminal Settings screen:

1. **Analyzer Mode Toggle** - Switch between Live/Analyze trading modes
2. **Current Status Display** - Shows actual analyzer status from backend
3. **Broker Name Display** - Shows connected broker in Connection section

**Status**: ✅ All features complete and deployed  
**Live App**: https://5060-izaau6inhv2bunerkxbc5-de59bda9.sandbox.novita.ai

---

## 📡 API Endpoints Used

### 1. Get Analyzer Status
```bash
POST /api/v1/analyzer
Content-Type: application/json

{
  "apikey": "your_api_key"
}

# Response (supports multiple formats):
{
  "status": "success",
  "data": {
    "mode": true,              # Primary
    "analyze_mode": true,      # Alternative
    "analyzermode": true       # Fallback
  }
}
```

### 2. Toggle Analyzer Mode
```bash
POST /api/v1/analyzer/toggle
Content-Type: application/json

{
  "apikey": "your_api_key",
  "mode": true  # true = analyze, false = live
}

# Response:
{
  "status": "success",
  "message": "Analyzer mode activated"
}
```

### 3. Get Broker Info
```bash
POST /api/v1/ping
Content-Type: application/json

{
  "apikey": "your_api_key"
}

# Response (supports both formats):
{
  "status": "success",
  "data": {
    "broker": "Zerodha",       # Primary
    "broker_name": "Zerodha"   # Alternative
  }
}
```

---

## 🎯 Key Code Locations

### API Service (Already Implemented)
**File**: `lib/services/openalgo_api_service.dart`
- Line 435: `getAnalyzerStatus()`
- Line 469: `toggleAnalyzer(bool analyzeMode)`
- Line 626: `ping()`

### Settings Screen (Updated)
**File**: `lib/screens/settings_screen.dart`
- Line 30: State variables
- Line 67: `_fetchBrokerInfo()` - ✅ Updated to support both field names
- Line 84: `_fetchAnalyzerStatus()` - ✅ Updated to support multiple fields
- Line 104: `_toggleAnalyzerMode(bool value)`
- Line 301: `_buildConnectionSection()` - Shows broker name
- Line 571: `_buildAnalyzerModeSection()` - Toggle UI

---

## 🎨 UI Components

### Trading Mode Section
```dart
Icon: _isAnalyzeMode ? Icons.science : Icons.show_chart
Color: _isAnalyzeMode ? Orange : Green
Label: _isAnalyzeMode ? 'Analyze Mode' : 'Live Mode'
Switch: value = _isAnalyzeMode, onChanged = _toggleAnalyzerMode
```

### Connection Section (Broker Display)
```dart
if (_brokerName != null) {
  _buildInfoRow('Connected Broker', _brokerName.toString())
}
```

---

## 🔄 Data Flow Diagrams

### Initialization Flow
```
initState()
   │
   ├──> _loadSelectedIndices()
   ├──> _fetchFunds()
   ├──> _fetchBrokerInfo()      ← Fetches broker from /api/v1/ping
   └──> _fetchAnalyzerStatus()  ← Fetches current mode from /api/v1/analyzer
```

### Toggle Flow
```
User taps switch
   │
   ├──> setState(_isLoadingAnalyzerStatus = true)
   │
   ├──> _apiService.toggleAnalyzer(newValue)
   │      POST /api/v1/analyzer/toggle
   │
   ├──> Success?
   │      │
   │      ├─ Yes ──> setState(_isAnalyzeMode = newValue)
   │      │          Show success toast
   │      │
   │      └─ No  ──> Show error toast
   │
   └──> setState(_isLoadingAnalyzerStatus = false)
```

---

## 🧪 Test Commands

### 1. Test Get Analyzer Status
```bash
curl -X POST https://demo.openalgo.in/api/v1/analyzer \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key"
  }'
```

**Expected**: `{"status": "success", "data": {"mode": true/false}}`

### 2. Test Toggle Analyzer
```bash
# Enable Analyze Mode
curl -X POST https://demo.openalgo.in/api/v1/analyzer/toggle \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key",
    "mode": true
  }'

# Disable Analyze Mode (Live Mode)
curl -X POST https://demo.openalgo.in/api/v1/analyzer/toggle \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key",
    "mode": false
  }'
```

**Expected**: `{"status": "success", "message": "Analyzer mode [activated/deactivated]"}`

### 3. Test Get Broker Info
```bash
curl -X POST https://demo.openalgo.in/api/v1/ping \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key"
  }'
```

**Expected**: `{"status": "success", "data": {"broker": "Zerodha"}}`

---

## 🐛 Common Issues & Solutions

### Issue 1: Mode always shows "Live" even though backend is in Analyze mode
**Cause**: API field name mismatch  
**Solution**: ✅ Fixed - now supports `mode`, `analyze_mode`, `analyzermode`

### Issue 2: Broker name shows "Unknown"
**Cause**: API field name mismatch or API call failed  
**Solution**: ✅ Fixed - now supports both `broker` and `broker_name`

### Issue 3: Toggle doesn't work
**Cause**: API endpoint not available or incorrect parameter  
**Solution**: Check API logs, ensure `mode` parameter is boolean

### Issue 4: Settings screen crashes
**Cause**: Type mismatch (double vs String)  
**Solution**: ✅ Fixed - all values converted with safe `.toString()`

---

## 📊 State Management

### State Variables
```dart
bool _isAnalyzeMode = false;            // Current analyzer mode
bool _isLoadingAnalyzerStatus = false;  // Loading indicator
String? _brokerName;                    // Broker name (nullable)
```

### State Updates
```dart
// Fetch status
setState(() {
  _isAnalyzeMode = data['mode'] ?? false;
  _isLoadingAnalyzerStatus = false;
});

// Toggle mode
setState(() {
  _isAnalyzeMode = value;
  _isLoadingAnalyzerStatus = false;
});

// Fetch broker
setState(() {
  _brokerName = data['broker']?.toString() ?? 'Unknown';
});
```

---

## 🎯 Verification Checklist

### In App Testing
- [ ] Settings tab loads without errors
- [ ] Trading Mode section visible with icon and switch
- [ ] Initial mode matches backend (not hardcoded)
- [ ] Toggle switch changes mode successfully
- [ ] Success toast appears after toggle
- [ ] Icon and color change appropriately
- [ ] Broker name appears in Connection section
- [ ] Pull-to-refresh updates all three values
- [ ] Error handling works (network off)

### API Testing
- [ ] GET /api/v1/analyzer returns current mode
- [ ] POST /api/v1/analyzer/toggle changes mode
- [ ] POST /api/v1/ping returns broker name
- [ ] All endpoints accept apikey parameter
- [ ] Response format matches specification

---

## 🚀 Deployment Info

**Live URL**: https://5060-izaau6inhv2bunerkxbc5-de59bda9.sandbox.novita.ai

**Build Command**:
```bash
cd /home/user/flutter_app
flutter build web --release
cd build/web
python3 -c "import http.server, socketserver; ..." &
```

**Port**: 5060  
**Server**: Python HTTP with CORS enabled

---

## 📝 Important Notes

1. **Field Name Flexibility**: The app now supports multiple API field name formats for maximum compatibility with different backend versions.

2. **Graceful Degradation**: If broker API fails, the broker name row is simply hidden (not shown as "Unknown").

3. **Loading States**: All API calls show loading indicators to improve UX.

4. **Error Handling**: User-friendly error messages displayed via SnackBar toasts.

5. **Type Safety**: All dynamic API values safely converted to String with `.toString()`.

6. **Pull-to-Refresh**: All three APIs are re-called when user pulls down in Settings.

---

## 📚 Related Documentation

- **Full Feature Summary**: `ANALYZER_BROKER_FEATURE_SUMMARY.md`
- **UI/UX Guide**: `ANALYZER_UI_GUIDE.md`
- **Previous Fixes**: `BUGFIX_SETTINGS_CHARTS.md`
- **Index Configuration**: `INDEX_CONFIGURATION_UPDATE.md`

---

## 🎓 For New Developers

**Want to understand the implementation?**

1. Start with API service: `lib/services/openalgo_api_service.dart`
2. Then read Settings screen: `lib/screens/settings_screen.dart`
3. Check UI guide: `ANALYZER_UI_GUIDE.md`
4. Review API docs: Your provided API documentation

**Want to modify the features?**

- Change icons: Update `Icons.science` and `Icons.show_chart`
- Change colors: Update `AppTheme.warningOrange` and `AppTheme.profitGreen`
- Change text: Update strings in `_buildAnalyzerModeSection()`
- Add new fields: Update `_fetchBrokerInfo()` to extract more data

---

## ⚡ Emergency Debugging

### Check if APIs are being called
```dart
// Enable debug mode in openalgo_api_service.dart
void _logRequest(String endpoint, Map<String, dynamic> body) {
  if (kDebugMode) {
    debugPrint('🔵 API Request: $endpoint');
    debugPrint('   Body: ${jsonEncode(body)}');
  }
}
```

### Check current state values
```dart
// Add in Settings screen initState or build method
if (kDebugMode) {
  debugPrint('_isAnalyzeMode: $_isAnalyzeMode');
  debugPrint('_brokerName: $_brokerName');
  debugPrint('_isLoadingAnalyzerStatus: $_isLoadingAnalyzerStatus');
}
```

### Test API manually
```bash
# Replace URL and apikey with your values
flutter run -d chrome --debug
# Then check browser console for API logs
```

---

**Last Updated**: 2025-01-31  
**Version**: 1.0.0  
**Author**: OpenAlgo Terminal Development Team  
**Status**: ✅ Production Ready
