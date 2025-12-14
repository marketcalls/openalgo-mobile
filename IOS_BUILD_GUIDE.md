# iOS Build Guide - OpenAlgo Terminal

## 📱 iOS Configuration Complete!

The OpenAlgo Terminal Flutter project is now **fully configured for iOS builds**. All iOS-specific settings, permissions, and configurations have been prepared.

---

## ✅ What Has Been Configured

### **1. iOS Project Settings**
- ✅ **Bundle ID:** `com.algoterminal.trade`
- ✅ **Display Name:** OpenAlgo Terminal
- ✅ **Minimum iOS Version:** 12.0
- ✅ **App Category:** Finance
- ✅ **Supported Devices:** iPhone, iPad
- ✅ **Orientations:** Portrait, Landscape Left, Landscape Right

### **2. Info.plist Permissions**
- ✅ **Network Access** - HTTPS connections configured
- ✅ **App Transport Security** - Secure connections to demo.openalgo.in
- ✅ **Background Modes** - Real-time data updates
- ✅ **Status Bar** - Proper status bar configuration
- ✅ **Device Capabilities** - ARM64 support

### **3. Podfile Configuration**
- ✅ Created iOS dependency manager configuration
- ✅ Minimum iOS 12.0 deployment target
- ✅ CocoaPods integration ready
- ✅ Flutter iOS pods setup

### **4. App Icons**
- ✅ Icon set structure ready (20x20 to 1024x1024)
- 📌 **TODO:** Replace default icons with custom OpenAlgo Terminal icons

---

## 🚀 Building on macOS

### **Prerequisites**

Before building, ensure you have:

1. **macOS** - Required for iOS development
2. **Xcode 14.0+** - Download from Mac App Store
3. **Flutter SDK** - Already configured in this project
4. **CocoaPods** - iOS dependency manager

**Install Prerequisites:**
```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install CocoaPods (if not installed)
sudo gem install cocoapods

# Verify Flutter installation
flutter doctor -v
```

---

## 📋 Step-by-Step Build Instructions

### **Step 1: Download/Clone the Project**
```bash
# If you have the project locally
cd /path/to/openalgo_terminal

# Or clone from repository
git clone <repository_url>
cd openalgo_terminal
```

### **Step 2: Install Flutter Dependencies**
```bash
# Get Flutter packages
flutter pub get

# This will also generate iOS-specific files
```

### **Step 3: Install iOS Dependencies**
```bash
# Navigate to iOS directory
cd ios

# Install CocoaPods dependencies
pod install

# Or update existing pods
pod update

# Go back to project root
cd ..
```

### **Step 4: Open in Xcode**
```bash
# Open the workspace (NOT the project)
open ios/Runner.xcworkspace
```

**⚠️ Important:** Always open `Runner.xcworkspace`, not `Runner.xcodeproj`!

---

## 🔧 Xcode Configuration

### **1. Select Development Team**

In Xcode:
1. Select **Runner** in the project navigator
2. Go to **Signing & Capabilities** tab
3. Select your **Team** (requires Apple Developer Account)
4. Xcode will automatically handle provisioning profiles

### **2. Verify Bundle Identifier**
- Should be: `com.algoterminal.trade`
- Xcode may suggest adding team prefix (e.g., `TEAMID.com.algoterminal.trade`)
- This is normal and acceptable

### **3. Configure Signing**

**For Development:**
```
Signing: Automatically manage signing ✓
Team: [Your Apple Developer Team]
Bundle Identifier: com.algoterminal.trade
```

**For Distribution:**
```
Signing: Manual signing
Provisioning Profile: [Your Distribution Profile]
```

---

## 🏗️ Build Commands

### **1. Debug Build (Development)**
```bash
# Build for iOS simulator (requires macOS)
flutter build ios --debug --simulator

# Or run directly on simulator
flutter run -d ios-simulator
```

### **2. Release Build (Device)**
```bash
# Build release IPA for physical device
flutter build ios --release

# Build with specific configuration
flutter build ios --release --flavor production
```

### **3. Build Archive (App Store)**
```bash
# In Xcode:
# 1. Product > Archive
# 2. Wait for archive to complete
# 3. Window > Organizer
# 4. Select archive and click "Distribute App"
```

---

## 📱 Testing on iOS Simulator

### **List Available Simulators**
```bash
# Show all iOS simulators
flutter devices

# Example output:
# iPhone 15 Pro (mobile) • <UUID> • ios • com.apple.CoreSimulator...
# iPad Pro (mobile) • <UUID> • ios • com.apple.CoreSimulator...
```

### **Run on Specific Simulator**
```bash
# Run on iPhone 15 Pro simulator
flutter run -d "iPhone 15 Pro"

# Or use device ID
flutter run -d <UUID>
```

---

## 🔑 Code Signing & Certificates

### **Required for Physical Devices:**

1. **Apple Developer Account** ($99/year)
   - Individual or Organization account
   - Sign up at: https://developer.apple.com

2. **Certificates**
   - iOS Development Certificate (for testing)
   - iOS Distribution Certificate (for App Store)

3. **Provisioning Profiles**
   - Development Profile (for testing on devices)
   - Ad Hoc Profile (for limited distribution)
   - App Store Profile (for App Store submission)

### **Generate Certificates in Xcode:**

1. Open Xcode > Preferences > Accounts
2. Add your Apple ID
3. Download Manual Profiles (if using manual signing)
4. Xcode can auto-generate certificates (if using automatic signing)

---

## 🍎 App Store Submission

### **Preparation Steps:**

1. **Create App in App Store Connect**
   ```
   - Go to: https://appstoreconnect.apple.com
   - Create new app
   - Bundle ID: com.algoterminal.trade
   - App Name: OpenAlgo Terminal
   - Category: Finance
   ```

2. **Prepare App Store Assets**
   - App Icon: 1024x1024px (already configured)
   - Screenshots: iPhone (6.5", 5.5") and iPad (12.9", 11")
   - App Preview Videos (optional)
   - App Description
   - Keywords
   - Privacy Policy URL

3. **App Store Information**
   - Description: Professional mobile trading terminal for OpenAlgo
   - Keywords: trading, stocks, finance, openalgo, terminal
   - Support URL: Your support website
   - Marketing URL: Your marketing website
   - Privacy Policy: Required for finance apps

4. **Build Archive**
   ```bash
   # In Xcode:
   # 1. Select "Any iOS Device (arm64)" as destination
   # 2. Product > Archive
   # 3. Upload to App Store Connect
   ```

5. **TestFlight Testing**
   - Internal testing (up to 100 testers)
   - External testing (requires Apple review)

6. **Submit for Review**
   - Complete all App Store Connect fields
   - Submit for review
   - Typical review time: 24-48 hours

---

## 🎨 Custom App Icons

### **Icon Requirements:**

iOS requires multiple icon sizes:

| Size | Usage | File Name |
|------|-------|-----------|
| 20x20@2x | iPhone Notification | Icon-App-20x20@2x.png |
| 20x20@3x | iPhone Notification | Icon-App-20x20@3x.png |
| 29x29@2x | iPhone Settings | Icon-App-29x29@2x.png |
| 29x29@3x | iPhone Settings | Icon-App-29x29@3x.png |
| 40x40@2x | iPhone Spotlight | Icon-App-40x40@2x.png |
| 40x40@3x | iPhone Spotlight | Icon-App-40x40@3x.png |
| 60x60@2x | iPhone App | Icon-App-60x60@2x.png |
| 60x60@3x | iPhone App | Icon-App-60x60@3x.png |
| 1024x1024 | App Store | Icon-App-1024x1024@1x.png |

### **Icon Generation:**

**Option 1: Manual Creation**
- Create master icon at 1024x1024px
- Export all required sizes
- Place in `ios/Runner/Assets.xcassets/AppIcon.appiconset/`

**Option 2: Use Icon Generator Tools**
- https://appicon.co/
- https://makeappicon.com/
- Upload 1024x1024px icon, download iOS icon set

**Option 3: Flutter Package**
```bash
# Install flutter_launcher_icons
flutter pub add dev:flutter_launcher_icons

# Configure in pubspec.yaml
# Then run:
flutter pub run flutter_launcher_icons
```

---

## 🔍 Troubleshooting

### **Common Issues:**

#### **1. "No Provisioning Profile Found"**
```
Solution:
- Ensure you're signed in with Apple ID in Xcode
- Enable "Automatically manage signing"
- Or manually select a valid provisioning profile
```

#### **2. "CocoaPods Not Found"**
```bash
# Install CocoaPods
sudo gem install cocoapods

# Then run
cd ios && pod install
```

#### **3. "Module Not Found" Errors**
```bash
# Clean and rebuild
flutter clean
flutter pub get
cd ios && pod install
```

#### **4. "Code Signing Failed"**
```
Solution:
- Check Team selection in Xcode
- Verify Bundle ID matches App Store Connect
- Regenerate provisioning profiles
- Clean build folder: Shift+Cmd+K in Xcode
```

#### **5. "Simulator Not Starting"**
```bash
# Reset simulator
xcrun simctl erase all

# Or in Simulator app:
# Device > Erase All Content and Settings
```

---

## 📊 Build Performance Tips

### **Optimize Build Times:**

1. **Xcode Build Settings**
   ```
   - Build Active Architecture Only: Yes (Debug)
   - Compiler Optimization: Fast (-O) for Debug
   - Debug Information Format: DWARF
   ```

2. **Clean Builds When Needed**
   ```bash
   # Full clean
   flutter clean
   cd ios && pod deintegrate && pod install
   ```

3. **Use Release Mode for Testing**
   ```bash
   # Release builds are optimized
   flutter run --release
   ```

---

## 🔐 Security Considerations

### **For Finance Apps:**

1. **SSL Pinning** - Consider implementing for production
2. **Biometric Auth** - Implement Face ID/Touch ID
3. **Secure Storage** - Use Keychain for sensitive data
4. **Jailbreak Detection** - Add security checks
5. **Certificate Transparency** - Validate SSL certificates

### **App Store Review Guidelines:**

- Financial apps require clear risk disclosures
- Must comply with regional financial regulations
- Privacy policy is mandatory
- User data handling must be transparent

---

## 📱 iOS-Specific Features to Consider

### **Optional Enhancements:**

1. **Widgets** - Home screen stock widgets
2. **Siri Shortcuts** - Voice-activated trades
3. **Face ID/Touch ID** - Biometric authentication
4. **Apple Watch** - Companion app for quick quotes
5. **Push Notifications** - Price alerts
6. **Today Extension** - Quick glance widget
7. **3D Touch** - Quick actions
8. **Handoff** - Continue on other devices

---

## 📋 iOS Build Checklist

Before submitting to App Store:

- [ ] Test on multiple iOS versions (12.0+)
- [ ] Test on different device sizes (iPhone, iPad)
- [ ] Test portrait and landscape orientations
- [ ] Verify all network requests work
- [ ] Test offline behavior
- [ ] Check app icon displays correctly
- [ ] Verify splash screen and launch screen
- [ ] Test all user flows and navigation
- [ ] Performance testing (memory, CPU, battery)
- [ ] Security testing (SSL, data storage)
- [ ] Accessibility testing (VoiceOver)
- [ ] Localization testing (if applicable)
- [ ] App Store screenshots prepared
- [ ] Privacy policy published
- [ ] Terms of service published

---

## 🎯 Quick Reference

### **Essential Commands:**
```bash
# Setup
flutter pub get
cd ios && pod install

# Run on simulator
flutter run -d ios-simulator

# Build release
flutter build ios --release

# Open in Xcode
open ios/Runner.xcworkspace

# Clean everything
flutter clean && cd ios && pod deintegrate && pod install
```

### **Important Files:**
```
ios/
├── Runner/
│   ├── Info.plist                  # App configuration
│   └── Assets.xcassets/            # App icons and images
├── Runner.xcodeproj/
│   └── project.pbxproj            # Xcode project settings
├── Podfile                         # CocoaPods dependencies
└── Runner.xcworkspace              # Open this in Xcode!
```

### **Bundle ID:** `com.algoterminal.trade`
### **Display Name:** OpenAlgo Terminal
### **Minimum iOS:** 12.0
### **Category:** Finance

---

## 📚 Additional Resources

- **Flutter iOS Deployment:** https://docs.flutter.dev/deployment/ios
- **Apple Developer:** https://developer.apple.com
- **App Store Connect:** https://appstoreconnect.apple.com
- **Human Interface Guidelines:** https://developer.apple.com/design/human-interface-guidelines/
- **App Store Review Guidelines:** https://developer.apple.com/app-store/review/guidelines/

---

## 💡 Next Steps

1. **Transfer to macOS machine**
2. **Open project in Xcode**
3. **Configure signing with your Apple ID**
4. **Build and test on simulator**
5. **Test on physical device**
6. **Submit to TestFlight for beta testing**
7. **Submit to App Store for review**

---

**The OpenAlgo Terminal is now iOS-ready! 🎉**

All configurations are complete. Just build on macOS with Xcode!
