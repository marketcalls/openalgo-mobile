import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/api_config.dart';
import '../models/quote.dart';

class StorageService {
  static const String _apiConfigKey = 'api_config';
  static const String _watchlistKey = 'watchlist';
  static const String _selectedIndicesKey = 'selected_indices';

  Future<void> saveApiConfig(ApiConfig config) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_apiConfigKey, jsonEncode(config.toJson()));
  }

  Future<ApiConfig?> getApiConfig() async {
    final prefs = await SharedPreferences.getInstance();
    final configJson = prefs.getString(_apiConfigKey);
    if (configJson != null) {
      return ApiConfig.fromJson(jsonDecode(configJson) as Map<String, dynamic>);
    }
    return null;
  }

  Future<void> clearApiConfig() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_apiConfigKey);
  }

  Future<void> saveWatchlist(List<WatchlistItem> watchlist) async {
    final prefs = await SharedPreferences.getInstance();
    final watchlistJson =
        jsonEncode(watchlist.map((item) => item.toJson()).toList());
    await prefs.setString(_watchlistKey, watchlistJson);
  }

  Future<List<WatchlistItem>> getWatchlist() async {
    final prefs = await SharedPreferences.getInstance();
    final watchlistJson = prefs.getString(_watchlistKey);
    if (watchlistJson != null) {
      final List<dynamic> decoded = jsonDecode(watchlistJson) as List<dynamic>;
      return decoded
          .map((item) => WatchlistItem.fromJson(item as Map<String, dynamic>))
          .toList();
    }
    return [];
  }

  /// Save selected indices for header display
  Future<void> saveSelectedIndices(List<String> indices) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_selectedIndicesKey, indices);
  }

  /// Get selected indices for header display
  /// Returns default [NIFTY, SENSEX] if none saved
  Future<List<String>> getSelectedIndices() async {
    final prefs = await SharedPreferences.getInstance();
    final indices = prefs.getStringList(_selectedIndicesKey);
    if (indices != null && indices.isNotEmpty) {
      return indices;
    }
    // Default to NIFTY and SENSEX
    return ['NIFTY', 'SENSEX'];
  }
}
