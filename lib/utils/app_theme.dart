import 'package:flutter/material.dart';

class AppTheme {
  // Light Theme Colors (OpenAlgo/Zerodha Kite style - DEFAULT)
  static const Color lightBackground = Color(0xFFFFFFFF);
  static const Color lightSurface = Color(0xFFF5F5F5);
  static const Color lightCard = Color(0xFFFFFFFF);
  static const Color lightBorder = Color(0xFFE5E5E5);
  static const Color lightTextPrimary = Color(0xFF333333);
  static const Color lightTextSecondary = Color(0xFF666666);
  
  // Dark Theme Colors (Zerodha Kite dark)
  static const Color darkBackground = Color(0xFF1F2933);
  static const Color darkSurface = Color(0xFF2A3442);
  static const Color darkCard = Color(0xFF323D4E);
  static const Color darkBorder = Color(0xFF3E4C59);
  static const Color darkTextPrimary = Color(0xFFFFFFFF);
  static const Color darkTextSecondary = Color(0xFF9CA3AF);
  
  // Common Colors (OpenAlgo brand colors)
  static const Color profitGreen = Color(0xFF00B386);
  static const Color lossRed = Color(0xFFFF6B6B);
  static const Color accentBlue = Color(0xFF5367FF);
  static const Color warningOrange = Color(0xFFFFA502);
  
  // Legacy colors for backward compatibility - NOW DEFAULTING TO LIGHT
  static const Color backgroundColor = lightBackground;
  static const Color surfaceColor = lightSurface;
  static const Color cardColor = lightCard;
  static const Color textPrimary = lightTextPrimary;
  static const Color textSecondary = lightTextSecondary;
  static const Color borderColor = lightBorder;

  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: lightBackground,
      colorScheme: const ColorScheme.light(
        primary: accentBlue,
        secondary: profitGreen,
        surface: lightSurface,
        error: lossRed,
        background: lightBackground,
      ),
      cardTheme: CardThemeData(
        color: lightCard,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: const BorderSide(color: lightBorder, width: 1),
        ),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: lightBackground,
        elevation: 0,
        centerTitle: false,
        iconTheme: IconThemeData(color: lightTextPrimary),
        titleTextStyle: TextStyle(
          color: lightTextPrimary,
          fontSize: 18,
          fontWeight: FontWeight.w500,
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: lightBackground,
        selectedItemColor: accentBlue,
        unselectedItemColor: lightTextSecondary,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
        showSelectedLabels: true,
        showUnselectedLabels: true,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: accentBlue,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(4),
          ),
        ),
      ),
      textTheme: const TextTheme(
        bodyLarge: TextStyle(color: lightTextPrimary, fontSize: 16),
        bodyMedium: TextStyle(color: lightTextPrimary, fontSize: 14),
        bodySmall: TextStyle(color: lightTextSecondary, fontSize: 12),
        titleLarge: TextStyle(color: lightTextPrimary, fontWeight: FontWeight.w500, fontSize: 20),
        titleMedium: TextStyle(color: lightTextPrimary, fontWeight: FontWeight.w500, fontSize: 16),
        titleSmall: TextStyle(color: lightTextSecondary, fontSize: 14),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: lightSurface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: lightBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: lightBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: accentBlue, width: 2),
        ),
        labelStyle: const TextStyle(color: lightTextSecondary),
        hintStyle: const TextStyle(color: lightTextSecondary),
      ),
      dividerColor: lightBorder,
    );
  }

  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: darkBackground,
      colorScheme: const ColorScheme.dark(
        primary: accentBlue,
        secondary: profitGreen,
        surface: darkSurface,
        error: lossRed,
        background: darkBackground,
      ),
      cardTheme: CardThemeData(
        color: darkCard,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: const BorderSide(color: darkBorder, width: 1),
        ),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: darkBackground,
        elevation: 0,
        centerTitle: false,
        iconTheme: IconThemeData(color: darkTextPrimary),
        titleTextStyle: TextStyle(
          color: darkTextPrimary,
          fontSize: 18,
          fontWeight: FontWeight.w500,
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: darkSurface,
        selectedItemColor: accentBlue,
        unselectedItemColor: darkTextSecondary,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
        showSelectedLabels: true,
        showUnselectedLabels: true,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: accentBlue,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(4),
          ),
        ),
      ),
      textTheme: const TextTheme(
        bodyLarge: TextStyle(color: darkTextPrimary, fontSize: 16),
        bodyMedium: TextStyle(color: darkTextPrimary, fontSize: 14),
        bodySmall: TextStyle(color: darkTextSecondary, fontSize: 12),
        titleLarge: TextStyle(color: darkTextPrimary, fontWeight: FontWeight.w500, fontSize: 20),
        titleMedium: TextStyle(color: darkTextPrimary, fontWeight: FontWeight.w500, fontSize: 16),
        titleSmall: TextStyle(color: darkTextSecondary, fontSize: 14),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: darkSurface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: darkBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: darkBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: accentBlue, width: 2),
        ),
        labelStyle: const TextStyle(color: darkTextSecondary),
        hintStyle: const TextStyle(color: darkTextSecondary),
      ),
      dividerColor: darkBorder,
    );
  }

  static Color getPnlColor(double pnl) {
    return pnl >= 0 ? profitGreen : lossRed;
  }

  static Color getActionColor(String action) {
    return action.toUpperCase() == 'BUY' ? profitGreen : lossRed;
  }
  
  // Get theme-aware colors
  static Color getTextPrimary(BuildContext context) {
    return Theme.of(context).brightness == Brightness.light 
        ? lightTextPrimary 
        : darkTextPrimary;
  }
  
  static Color getTextSecondary(BuildContext context) {
    return Theme.of(context).brightness == Brightness.light 
        ? lightTextSecondary 
        : darkTextSecondary;
  }
  
  static Color getBackground(BuildContext context) {
    return Theme.of(context).brightness == Brightness.light 
        ? lightBackground 
        : darkBackground;
  }
  
  static Color getBorder(BuildContext context) {
    return Theme.of(context).brightness == Brightness.light 
        ? lightBorder 
        : darkBorder;
  }
}
