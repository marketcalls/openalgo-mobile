# OpenAlgo Terminal - User Installation & Setup Guide

## 📱 Quick Start Guide

**Yes, you can install the APK and connect to your OpenAlgo server!**

---

## 🎯 What You Need

### **1. OpenAlgo Server** (Backend)
- ✅ OpenAlgo server must be running and accessible
- ✅ Server URL (e.g., `http://192.168.1.100:5000` or `https://your-domain.com`)
- ✅ WebSocket URL (e.g., `ws://192.168.1.100:8765`)
- ✅ API Key from your OpenAlgo server

### **2. Android Device**
- ✅ Android 5.0+ (API 21 or higher)
- ✅ Internet connection (WiFi or mobile data)
- ✅ "Install from Unknown Sources" enabled

### **3. OpenAlgo Terminal APK**
- ✅ Download: `app-release.apk` (52.8 MB)
- ✅ Location: `build/app/outputs/flutter-apk/app-release.apk`

---

## 📋 Step-by-Step Installation

### **Step 1: Enable Unknown Sources**

On your Android device:
1. Go to **Settings**
2. Navigate to **Security** or **Privacy**
3. Enable **"Install from Unknown Sources"** or **"Allow from this source"**

### **Step 2: Transfer APK to Device**

Choose one method:

**Method A: USB Transfer**
```bash
# Connect device via USB
adb install app-release.apk
```

**Method B: File Transfer**
1. Copy APK to device storage
2. Use file manager on device
3. Tap `app-release.apk` to install

**Method C: Cloud Storage**
1. Upload APK to Google Drive / Dropbox
2. Download on device
3. Tap to install

### **Step 3: Install APK**

1. Locate the APK file on your device
2. Tap on `app-release.apk`
3. Review permissions:
   - ✅ **Internet** - Required for API connectivity
   - ✅ **Network State** - Check connection status
4. Tap **"Install"**
5. Wait for installation to complete
6. Tap **"Open"** or find "OpenAlgo" in app drawer

---

## 🔧 First Launch Configuration

### **Login Screen - Enter Your OpenAlgo Server Details**

When you first open the app, you'll see a login screen with 3 fields:

#### **1. Host URL** (Required)
- Your OpenAlgo server address
- **Examples**:
  - Local server: `http://192.168.1.100:5000`
  - Remote server: `https://openalgo.yourdomain.com`
  - Public IP: `http://203.0.113.10:5000`
  
**Format**: Must start with `http://` or `https://`

#### **2. WebSocket URL** (Required)
- WebSocket endpoint for real-time data
- **Examples**:
  - Local: `ws://192.168.1.100:8765`
  - Remote: `wss://openalgo.yourdomain.com/ws`
  - Public IP: `ws://203.0.113.10:8765`
  
**Format**: Must start with `ws://` or `wss://`

#### **3. API Key** (Required)
- Your OpenAlgo API authentication key
- **Example**: `abc123xyz789` (your actual key from OpenAlgo server)
- This is generated/configured on your OpenAlgo server

---

## ✅ Configuration Examples

### **Example 1: Local Network Setup**
```
Host URL:      http://192.168.1.50:5000
WebSocket URL: ws://192.168.1.50:8765
API Key:       your-openalgo-api-key-here
```
**Use when**: OpenAlgo server runs on same WiFi network

### **Example 2: Remote Server Setup**
```
Host URL:      https://openalgo.example.com
WebSocket URL: wss://openalgo.example.com/ws
API Key:       your-openalgo-api-key-here
```
**Use when**: OpenAlgo server accessible via internet

### **Example 3: Localhost (for testing)**
```
Host URL:      http://127.0.0.1:5000
WebSocket URL: ws://127.0.0.1:8765
API Key:       your-openalgo-api-key-here
```
**Use when**: Testing with OpenAlgo server on same device

---

## 🔐 How to Get Your API Key

Your API key is configured in your OpenAlgo server:

1. **Access OpenAlgo Server Dashboard**
2. **Navigate to Settings or API Configuration**
3. **Find or Generate API Key**
4. **Copy the API Key**
5. **Paste into OpenAlgo Terminal app**

**Note**: API key format and location depend on your OpenAlgo server version. Consult your OpenAlgo server documentation.

---

## 🚀 After Configuration

### **What Happens After You Tap "Connect"**

1. ✅ **Validates input** - Checks URL formats and API key
2. ✅ **Saves configuration** - Stores settings locally (no re-entry needed)
3. ✅ **Tests connection** - Pings OpenAlgo server
4. ✅ **Authenticates** - Verifies API key
5. ✅ **Loads data** - Fetches initial watchlist, positions, holdings

### **If Connection Succeeds** ✅
- Navigates to main app screen
- Shows watchlist with live quotes
- Displays account funds
- Shows analyzer mode status
- Settings saved for future launches

### **If Connection Fails** ❌
- Shows error message
- Allows you to correct configuration
- Common issues:
  - Incorrect server URL
  - Server not running
  - Wrong API key
  - Network connectivity issues

---

## 📱 Main App Features

Once connected, you'll have access to:

### **1. Watchlist** 📊
- View real-time stock quotes
- Add/remove symbols
- See price changes and percentage moves
- Tap to view charts

### **2. Orders** 📝
- View order book
- Place new orders
- Modify pending orders
- Cancel orders

### **3. Positions** 💼
- Current open positions
- P&L (Profit & Loss)
- Position details
- Close positions

### **4. Holdings** 📈
- Long-term holdings
- Investment portfolio
- Overall returns

### **5. Trades** 📜
- Trade history
- Completed trades
- Trade details

### **6. Settings** ⚙️
- **Connection**: View broker name, connection status
- **Trading Mode**: Toggle Live/Analyze mode
- **Analyzer Status**: See current mode (LIVE/ANALYZE)
- **Account Funds**: View available balance
- **Index Configuration**: Configure NIFTY, BANKNIFTY, etc.
- **App Theme**: Dark/Light mode

---

## 🔄 Changing Server Configuration

### **To Update Server Settings**

1. **Open App** → Tap **Settings** (bottom right)
2. **Scroll to Connection Section**
3. **Tap "Logout"** or **"Disconnect"**
4. **Returns to Login Screen**
5. **Enter new server details**
6. **Tap "Connect"**

### **Settings Are Persistent**
- Configuration saved automatically
- No need to re-enter on app restart
- Stored securely in local device storage
- Not shared with external servers

---

## 🐛 Troubleshooting

### **App Crashes Immediately** ❌

**Symptoms**: App opens and closes instantly

**Solutions**:
1. ✅ **Uninstall old version** if any exists
2. ✅ **Install fresh APK** (52.8 MB version)
3. ✅ **Clear app cache**: Settings → Apps → OpenAlgo → Clear Cache
4. ✅ **Restart device**

---

### **Cannot Connect to Server** ❌

**Symptoms**: "Connection failed" error on login

**Check These**:

#### **1. Server URL Format**
```
✅ Correct: http://192.168.1.50:5000
❌ Wrong:  192.168.1.50:5000 (missing http://)
❌ Wrong:  http://192.168.1.50 (missing port)
```

#### **2. Network Connectivity**
- Device and server on same network?
- Can you ping server from device?
- Firewall blocking connections?

#### **3. OpenAlgo Server Running**
- Is OpenAlgo server process active?
- Check server logs for errors
- Verify server listening on configured port

#### **4. API Key Correct**
- Copy-paste API key (avoid typos)
- Check for extra spaces
- Verify key is active on server

---

### **Login Screen Shows But Can't Submit** ❌

**Symptoms**: "Connect" button disabled or validation errors

**Solutions**:
1. ✅ Ensure all 3 fields filled
2. ✅ Check URL format (http:// or https://)
3. ✅ Check WebSocket format (ws:// or wss://)
4. ✅ API key not empty

---

### **App Connects But Shows No Data** ❌

**Symptoms**: App opens, blank screens, no quotes

**Solutions**:
1. ✅ Check internet connection
2. ✅ Verify API permissions on server
3. ✅ Check if watchlist has symbols
4. ✅ Pull down to refresh data
5. ✅ Check OpenAlgo server logs

---

### **Real-Time Data Not Updating** ❌

**Symptoms**: Quotes not refreshing, stale data

**Solutions**:
1. ✅ Check WebSocket URL correct
2. ✅ Verify WebSocket port open
3. ✅ Check server WebSocket service running
4. ✅ Restart app
5. ✅ Check network stability

---

## 📊 Supported Features

### **✅ Available in App**
- [x] Real-time watchlist with quotes
- [x] Order management (place, modify, cancel)
- [x] Position tracking
- [x] Holdings view
- [x] Trade history
- [x] Account funds display
- [x] Analyzer mode toggle (Live/Analyze)
- [x] Broker connection status
- [x] Index configuration (NIFTY, BANKNIFTY, etc.)
- [x] Dark/Light theme
- [x] Pull-to-refresh data

### **⏳ Coming Soon**
- [ ] TradingView charts integration
- [ ] Advanced order types
- [ ] Market depth visualization
- [ ] Option chain analysis
- [ ] Push notifications
- [ ] Multiple account support

---

## 🔐 Security & Privacy

### **Data Storage**
- ✅ All configuration stored **locally** on device
- ✅ API key stored in **encrypted local storage**
- ✅ No data sent to third parties
- ✅ Direct connection to **your** OpenAlgo server only

### **Permissions Used**
- **Internet**: Connect to OpenAlgo server API
- **Network State**: Check connectivity status

### **What We DON'T Collect**
- ❌ No telemetry or analytics
- ❌ No user tracking
- ❌ No data sharing with third parties
- ❌ No cloud storage of your data

---

## 📞 Support & Help

### **Getting Help**

**1. Check OpenAlgo Server Documentation**
- API endpoint details
- Authentication setup
- WebSocket configuration

**2. Verify Server Status**
- Use OpenAlgo web interface
- Check server logs
- Test API endpoints manually

**3. App Issues**
- Check GitHub repository: https://github.com/marketcalls/openalgo-mobile
- Review documentation files
- Report bugs via GitHub Issues

---

## 🎯 Quick Reference

### **Configuration Template**
```
┌─────────────────────────────────────────┐
│ OpenAlgo Terminal - Login               │
├─────────────────────────────────────────┤
│                                         │
│ Host URL:                               │
│ http://YOUR_SERVER_IP:5000              │
│                                         │
│ WebSocket URL:                          │
│ ws://YOUR_SERVER_IP:8765                │
│                                         │
│ API Key:                                │
│ YOUR_OPENALGO_API_KEY                   │
│                                         │
│         [ Connect ]                     │
└─────────────────────────────────────────┘
```

### **Common Port Numbers**
- **OpenAlgo HTTP API**: 5000 (default)
- **OpenAlgo WebSocket**: 8765 (default)
- *(Ports may vary based on your server configuration)*

---

## ✅ Installation Checklist

Before opening the app, ensure:

- [ ] OpenAlgo server is running and accessible
- [ ] You know your server IP/domain
- [ ] You have your API key ready
- [ ] Device has internet connectivity
- [ ] APK installed successfully
- [ ] All required permissions granted

After installation:

- [ ] App launches without crashing
- [ ] Login screen appears
- [ ] Can enter server details
- [ ] Successfully connects to server
- [ ] Watchlist loads with data
- [ ] All tabs are accessible

---

## 🎉 Ready to Trade!

**That's it! You're all set!**

1. ✅ Install APK on Android device
2. ✅ Open "OpenAlgo" app
3. ✅ Enter your OpenAlgo server details
4. ✅ Tap "Connect"
5. ✅ Start trading with OpenAlgo Terminal!

**Your OpenAlgo Terminal app is ready to connect to your OpenAlgo server and start trading!** 📈🚀

---

**App Version**: 1.0.0 (Build 1)  
**Package Name**: com.example.openalgo_terminal  
**Min Android**: 5.0+ (API 21)  
**File Size**: 52.8 MB  
**Status**: Production Ready ✅
