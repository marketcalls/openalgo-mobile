# OpenAlgo Terminal - Mobile Trading Platform

[![Flutter](https://img.shields.io/badge/Flutter-3.35.4-blue.svg)](https://flutter.dev/)
[![Dart](https://img.shields.io/badge/Dart-3.9.2-blue.svg)](https://dart.dev/)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Web%20%7C%20Android-lightgrey.svg)](https://github.com/marketcalls/openalgo-mobile)

A professional Flutter-based mobile trading platform that connects to OpenAlgo backend servers. This is a **frontend-only application** where users provide their own OpenAlgo server URL and API credentials.

![OpenAlgo Terminal](https://img.shields.io/badge/OpenAlgo-Terminal-orange)

## 🌟 Features

### Core Trading Features
- **📊 Watchlist Management** - Track multiple stocks with real-time quotes
- **📈 Live Market Data** - Real-time price updates every 5 seconds
- **💰 Account Overview** - View available cash, used margin, and P&L
- **📋 Order Management** - Place, modify, and cancel orders
- **📊 Position Tracking** - Monitor open positions and holdings
- **📖 Trade History** - Complete tradebook with all executions
- **🔍 Market Depth** - Level 2 order book data

### Advanced Features
- **🔬 Analyzer Mode** - Switch between Live and Analyze (paper trading) modes
- **📊 Configurable Header** - Select market indices (NIFTY, BANKNIFTY, SENSEX, INDIAVIX)
- **🔔 Real-time Updates** - Auto-refresh quotes and positions
- **🌓 Dark/Light Theme** - Theme toggle for comfortable viewing
- **🔐 Secure API Integration** - Connect to your OpenAlgo backend

## 🚀 Getting Started

### Prerequisites

- **OpenAlgo Backend Server** - You need a running OpenAlgo server
  - Get OpenAlgo: [https://github.com/marketcalls/openalgo](https://github.com/marketcalls/openalgo)
  - Or use demo server: `https://demo.openalgo.in`
- **API Key** - Obtain from your OpenAlgo server dashboard
- **Web Browser** (for web version) or **Android Device** (for mobile)

### Installation

#### Web Version (Recommended)
1. Visit the hosted web app (deployment URL will be provided)
2. Enter your OpenAlgo server URL
3. Enter your API key
4. Start trading!

#### Android Version (APK)
1. Download the latest APK from [Releases](https://github.com/marketcalls/openalgo-mobile/releases)
2. Enable "Install from Unknown Sources" in Android settings
3. Install the APK
4. Open the app and configure your OpenAlgo connection

### Configuration

On first launch, you'll need to provide:
- **Host URL**: Your OpenAlgo server URL (e.g., `https://your-server.com`)
- **WebSocket URL**: WebSocket endpoint (e.g., `wss://your-server.com/ws`)
- **API Key**: Your personal API key from OpenAlgo dashboard

## 📱 Screenshots

### Watchlist Screen
- Real-time stock quotes with price and percentage changes
- Color-coded profit/loss indicators
- Quick actions: Buy, Sell, Chart, Depth
- Pull-to-refresh and auto-refresh

### Settings Screen
- **Header Indices Configuration** - Select which indices to display
- **Trading Mode Toggle** - Switch between Live and Analyze modes
- **Account Funds Display** - Available cash, used margin, P&L
- **Broker Information** - Connected broker details
- **Theme Toggle** - Switch between dark and light themes

### Order & Position Management
- Place market, limit, and stop-loss orders
- View and modify pending orders
- Monitor open positions with P&L
- Complete trade history

## 🛠️ Development

### Tech Stack

**Framework & Language:**
- Flutter 3.35.4
- Dart 3.9.2

**State Management:**
- Provider

**Networking:**
- HTTP for REST APIs
- WebSocket for real-time data

**Local Storage:**
- SharedPreferences (user settings, API config)
- Hive + hive_flutter (document database for offline data)

**UI Components:**
- Material Design 3
- Custom themes with dark/light mode

### Project Structure

```
lib/
├── main.dart                 # App entry point
├── models/                   # Data models
│   ├── api_config.dart
│   ├── quote.dart
│   ├── order.dart
│   ├── position.dart
│   └── ...
├── screens/                  # UI screens
│   ├── login_screen.dart
│   ├── main_screen.dart
│   ├── watchlist_screen.dart
│   ├── settings_screen.dart
│   └── ...
├── services/                 # Business logic
│   ├── openalgo_api_service.dart
│   ├── storage_service.dart
│   └── websocket_service.dart
├── widgets/                  # Reusable widgets
│   ├── index_bar.dart
│   ├── mode_indicator.dart
│   └── ...
└── utils/                    # Utilities
    └── app_theme.dart
```

### Building from Source

#### Prerequisites
```bash
# Flutter SDK 3.35.4
# Dart SDK 3.9.2
# Android SDK (for APK builds)
```

#### Build for Web
```bash
cd /home/user/flutter_app
flutter pub get
flutter build web --release
```

#### Build for Android
```bash
cd /home/user/flutter_app
flutter pub get
flutter build apk --release
# Output: build/app/outputs/flutter-apk/app-release.apk
```

#### Build Android App Bundle (for Play Store)
```bash
flutter build appbundle --release
# Output: build/app/outputs/bundle/release/app-release.aab
```

### Running in Development
```bash
# Web (Chrome)
flutter run -d chrome

# Android Device/Emulator
flutter run -d <device_id>
```

## 🔌 OpenAlgo API Integration

This app integrates with the following OpenAlgo APIs:

### Required Endpoints
- `POST /api/v1/quotes` - Get single stock quote
- `POST /api/v1/funds` - Get account funds
- `POST /api/v1/orderbook` - Get pending orders
- `POST /api/v1/positionbook` - Get open positions
- `POST /api/v1/holdings` - Get holdings
- `POST /api/v1/tradebook` - Get trade history
- `POST /api/v1/placeorder` - Place new order
- `POST /api/v1/modifyorder` - Modify pending order
- `POST /api/v1/cancelorder` - Cancel pending order
- `POST /api/v1/analyzer` - Get analyzer status
- `POST /api/v1/analyzer/toggle` - Toggle analyzer mode
- `POST /api/v1/ping` - Check broker connection

### Optional Endpoints (Performance Enhancement)
- `POST /api/v1/multiquotes` - Batch quote fetching (10x faster)
- `POST /api/v1/depth` - Market depth data
- `POST /api/v1/search` - Symbol search

### API Request Format
All API requests require an `apikey` parameter:
```json
{
  "apikey": "your_api_key",
  // ... other parameters
}
```

## 🔒 Security & Privacy

- **No Data Storage**: The app only stores API configuration locally
- **Secure Communication**: All API calls use HTTPS
- **No Third-party Analytics**: No tracking or analytics services
- **Open Source**: Code is fully transparent and auditable
- **API Key Protection**: API keys stored securely on device

## 📋 Known Limitations

- **TradingView Charts**: Currently shows "Coming Soon" - under development
- **MultiQuotes API**: Optional - falls back to individual quotes if not available
- **iOS Platform**: Not currently optimized (Android and Web focus)
- **Backend Dependency**: Requires OpenAlgo backend server

## 🐛 Troubleshooting

### Watchlist Shows "Error"
- Verify your API key is correct
- Check OpenAlgo server is running and accessible
- Ensure `/api/v1/quotes` endpoint is available

### Settings Page Not Loading
- Check `/api/v1/funds` endpoint availability
- Verify API returns valid JSON response
- Try refreshing the app (hard refresh for web)

### Analyzer Toggle Not Working
- Ensure `/api/v1/analyzer` endpoint is available
- Check `/api/v1/analyzer/toggle` endpoint permissions
- Verify API key has analyzer access rights

### Orders Not Placing
- Check broker connection via `/api/v1/ping`
- Verify order parameters (symbol, exchange, quantity)
- Ensure sufficient funds/margin
- Check if in Analyze mode (virtual trading)

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow Flutter/Dart style guide
- Write meaningful commit messages
- Add tests for new features
- Update documentation as needed
- Ensure `flutter analyze` passes with no errors

## 📄 License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This means:
- ✅ You can use, modify, and distribute this software
- ✅ You must disclose source code when distributing
- ✅ You must license derivative works under AGPL-3.0
- ✅ Network use counts as distribution (must share source)
- ✅ Changes must be documented

See [LICENSE](LICENSE) file for full details.

### Why AGPL-3.0?
The AGPL license ensures that if you run a modified version of this software as a service, you must make your source code available to users. This protects the open-source nature of the project.

## 🙏 Acknowledgments

- **OpenAlgo Team** - For the excellent backend trading platform
- **Flutter Team** - For the amazing cross-platform framework
- **Contributors** - Thank you to all contributors!

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/marketcalls/openalgo-mobile/issues)
- **Discussions**: [GitHub Discussions](https://github.com/marketcalls/openalgo-mobile/discussions)
- **OpenAlgo Docs**: [OpenAlgo Documentation](https://docs.openalgo.in)

## 🗺️ Roadmap

### Upcoming Features
- [ ] TradingView Lightweight Charts integration
- [ ] MultiQuotes API support
- [ ] Advanced order types (bracket, cover orders)
- [ ] Technical indicators
- [ ] Price alerts and notifications
- [ ] Option chain analysis
- [ ] Portfolio analytics
- [ ] Export trade history
- [ ] iOS optimization

### Version History
- **v1.0.0** (2025-01-31) - Initial release
  - Core trading features
  - Analyzer mode support
  - Configurable header indices
  - Dark/Light theme toggle

## 📊 Project Status

- ✅ **Watchlist**: Fully functional with real-time quotes
- ✅ **Orders**: Place, modify, cancel orders
- ✅ **Positions**: Track open positions and P&L
- ✅ **Holdings**: View long-term holdings
- ✅ **Settings**: Analyzer mode, theme toggle, funds display
- ⏳ **Charts**: Coming soon (under development)
- ✅ **Web**: Fully functional and tested
- ✅ **Android**: APK build ready
- ⚠️ **iOS**: Not currently optimized

---

**Built with ❤️ using Flutter | Powered by OpenAlgo**

⭐ If you find this project useful, please consider giving it a star!
