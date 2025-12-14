import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../models/api_config.dart';
import '../models/quote.dart';
import '../models/order.dart';
import '../models/position.dart';
import '../models/holding.dart';
import '../models/trade.dart';
import '../models/symbol_search.dart';

class OpenAlgoApiService {
  final ApiConfig config;

  OpenAlgoApiService(this.config);

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
      };

  void _logRequest(String endpoint, Map<String, dynamic> body) {
    if (kDebugMode) {
      debugPrint('🔵 API Request: $endpoint');
      debugPrint('   URL: ${config.hostUrl}$endpoint');
      debugPrint('   Body: ${jsonEncode(body)}');
    }
  }

  void _logResponse(String endpoint, int statusCode, String body) {
    if (kDebugMode) {
      debugPrint('🟢 API Response: $endpoint');
      debugPrint('   Status: $statusCode');
      debugPrint('   Body: $body');
    }
  }

  void _logError(String endpoint, dynamic error) {
    if (kDebugMode) {
      debugPrint('🔴 API Error: $endpoint');
      debugPrint('   Error: $error');
    }
  }

  // Quotes API - Single symbol
  Future<Quote> getQuote(String symbol, String exchange) async {
    const endpoint = '/api/v1/quotes';
    final requestBody = {
      'apikey': config.apiKey,
      'symbol': symbol,
      'exchange': exchange,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      ).timeout(
        const Duration(seconds: 10),
        onTimeout: () {
          throw Exception('Request timeout - Server not responding');
        },
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return Quote.fromJson({
            ...data,
            'symbol': symbol,
            'exchange': exchange,
          });
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      } else if (response.statusCode == 403) {
        throw Exception('Access Forbidden (403) - API key may be invalid or rate limited');
      } else if (response.statusCode == 404) {
        throw Exception('Endpoint not found (404) - Not available on demo server');
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // MultiQuotes API - Multiple symbols in single request
  Future<List<Quote>> getMultiQuotes(List<Map<String, String>> symbolList) async {
    const endpoint = '/api/v1/multiquotes';
    final requestBody = {
      'apikey': config.apiKey,
      'symbols': symbolList, // [{"symbol": "RELIANCE", "exchange": "NSE"}, ...]
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      ).timeout(
        const Duration(seconds: 15),
        onTimeout: () {
          throw Exception('Request timeout - Server not responding');
        },
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          final quotesData = data['data'] as List<dynamic>;
          return quotesData.map((quoteJson) {
            final quoteMap = quoteJson as Map<String, dynamic>;
            // Pass the quote data directly with symbol and exchange
            return Quote.fromJson({
              ...quoteMap, // Include all quote data
              'symbol': quoteMap['symbol'] ?? '',
              'exchange': quoteMap['exchange'] ?? '',
            });
          }).toList();
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      } else if (response.statusCode == 403) {
        throw Exception('Access Forbidden (403) - API key may be invalid or rate limited');
      } else if (response.statusCode == 404) {
        // MultiQuotes not available - throw specific error to trigger fallback
        throw Exception('Endpoint not found (404) - Not available on demo server');
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // OrderBook API
  Future<OrderBookResponse> getOrderBook() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/orderbook'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] == 'success') {
        return OrderBookResponse.fromJson(data);
      }
    }
    throw Exception('Failed to fetch orderbook');
  }

  // TradeBook API
  Future<List<Trade>> getTradeBook() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/tradebook'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] == 'success') {
        final tradesJson = data['data'] as List<dynamic>? ?? [];
        return tradesJson
            .map((trade) => Trade.fromJson(trade as Map<String, dynamic>))
            .toList();
      }
    }
    throw Exception('Failed to fetch tradebook');
  }

  // PositionBook API
  Future<List<Position>> getPositionBook() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/positionbook'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] == 'success') {
        final positionsJson = data['data'] as List<dynamic>? ?? [];
        return positionsJson
            .map((position) => Position.fromJson(position as Map<String, dynamic>))
            .toList();
      }
    }
    throw Exception('Failed to fetch positions');
  }

  // Holdings API
  Future<HoldingsResponse> getHoldings() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/holdings'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] == 'success') {
        return HoldingsResponse.fromJson(data);
      }
    }
    throw Exception('Failed to fetch holdings');
  }

  // Place Order API
  Future<Map<String, dynamic>> placeOrder({
    required String symbol,
    required String exchange,
    required String action,
    required String quantity,
    required String priceType,
    required String product,
    String? price,
    String? triggerPrice,
    String? disclosedQuantity,
  }) async {
    const endpoint = '/api/v1/placeorder';
    final requestBody = {
      'apikey': config.apiKey,
      'strategy': 'MobileApp',
      'symbol': symbol,
      'exchange': exchange,
      'action': action,
      'quantity': quantity,
      'pricetype': priceType,  // OpenAlgo expects 'pricetype' not 'price_type'
      'product': product,
      'price': price ?? '0',
      'trigger_price': triggerPrice ?? '0',
      'disclosed_quantity': disclosedQuantity ?? '0',
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return data;
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Cancel Order API
  Future<Map<String, dynamic>> cancelOrder(String orderId) async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/cancelorder'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
        'strategy': 'MobileApp',
        'order_id': orderId,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return data;
    }
    throw Exception('Failed to cancel order');
  }

  // Modify Order API
  Future<Map<String, dynamic>> modifyOrder({
    required String orderId,
    required String symbol,
    required String exchange,
    required String action,
    required String quantity,
    required String priceType,
    required String product,
    String? price,
    String? triggerPrice,
  }) async {
    const endpoint = '/api/v1/modifyorder';
    final requestBody = {
      'apikey': config.apiKey,
      'strategy': 'MobileApp',
      'order_id': orderId,
      'symbol': symbol,
      'exchange': exchange,
      'action': action,
      'quantity': quantity,
      'pricetype': priceType,  // OpenAlgo expects 'pricetype' not 'price_type'
      'product': product,
      'price': price ?? '0',
      'trigger_price': triggerPrice ?? '0',
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return data;
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Search Symbols API
  Future<List<SymbolSearch>> searchSymbols(String query,
      {String? exchange}) async {
    const endpoint = '/api/v1/search';
    final requestBody = <String, dynamic>{
      'apikey': config.apiKey,
      'query': query,
    };
    
    if (exchange != null && exchange.isNotEmpty) {
      requestBody['exchange'] = exchange;
    }

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          final symbolsJson = data['data'] as List<dynamic>? ?? [];
          if (kDebugMode) {
            debugPrint('   Found ${symbolsJson.length} symbols');
          }
          return symbolsJson
              .map((symbol) => SymbolSearch.fromJson(symbol as Map<String, dynamic>))
              .toList();
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          if (kDebugMode) {
            debugPrint('   API error: $errorMsg');
          }
        }
      }
      
      // Return empty list instead of throwing error
      return [];
    } catch (e) {
      _logError(endpoint, e);
      // Return empty list on error
      return [];
    }
  }

  // Depth API - Get market depth
  Future<Map<String, dynamic>> getDepth(String symbol, String exchange) async {
    const endpoint = '/api/v1/depth';
    final requestBody = {
      'apikey': config.apiKey,
      'symbol': symbol,
      'exchange': exchange,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data['data'] as Map<String, dynamic>;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Close All Positions API
  Future<Map<String, dynamic>> closeAllPositions() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/closeposition'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
        'strategy': 'MobileApp',
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return data;
    }
    throw Exception('Failed to close positions');
  }

  // Cancel All Orders API
  Future<Map<String, dynamic>> cancelAllOrders() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/cancelallorder'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
        'strategy': 'MobileApp',
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return data;
    }
    throw Exception('Failed to cancel all orders');
  }

  // Funds API
  Future<Map<String, dynamic>> getFunds() async {
    final response = await http.post(
      Uri.parse('${config.hostUrl}/api/v1/funds'),
      headers: _headers,
      body: jsonEncode({
        'apikey': config.apiKey,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] == 'success') {
        return data['data'] as Map<String, dynamic>;
      }
    }
    throw Exception('Failed to fetch funds');
  }

  // Analyzer Status API
  Future<Map<String, dynamic>> getAnalyzerStatus() async {
    const endpoint = '/api/v1/analyzer';
    final requestBody = {
      'apikey': config.apiKey,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Toggle Analyzer Mode API
  Future<Map<String, dynamic>> toggleAnalyzer(bool analyzeMode) async {
    const endpoint = '/api/v1/analyzer/toggle';
    final requestBody = {
      'apikey': config.apiKey,
      'mode': analyzeMode,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Symbol API - Get symbol details including lot size
  Future<Map<String, dynamic>> getSymbolInfo(String symbol, String exchange) async {
    const endpoint = '/api/v1/symbol';
    final requestBody = {
      'apikey': config.apiKey,
      'symbol': symbol,
      'exchange': exchange,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data['data'] as Map<String, dynamic>;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Intervals API - Get supported timeframes
  Future<Map<String, dynamic>> getIntervals() async {
    const endpoint = '/api/v1/intervals';
    final requestBody = {
      'apikey': config.apiKey,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Historical Data API - Get candlestick data
  Future<List<Map<String, dynamic>>> getHistoricalData({
    required String symbol,
    required String exchange,
    required String interval,
    String? startDate,
    String? endDate,
  }) async {
    const endpoint = '/api/v1/history';
    
    // Calculate default date range if not provided
    final now = DateTime.now();
    final end = endDate ?? _formatDate(now);
    final start = startDate ?? _formatDate(now.subtract(const Duration(days: 30)));
    
    final requestBody = {
      'apikey': config.apiKey,
      'symbol': symbol,
      'exchange': exchange,
      'interval': interval,
      'start_date': start,
      'end_date': end,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          final historyData = data['data'] as List<dynamic>;
          return historyData.map((item) => item as Map<String, dynamic>).toList();
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Ping API - Get broker connection status
  Future<Map<String, dynamic>> ping() async {
    const endpoint = '/api/v1/ping';
    final requestBody = {
      'apikey': config.apiKey,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Option Chain API - Get option chain data
  Future<Map<String, dynamic>> getOptionChain({
    required String symbol,
    required String exchange,
  }) async {
    const endpoint = '/api/v1/optionchain';
    final requestBody = {
      'apikey': config.apiKey,
      'symbol': symbol,
      'exchange': exchange,
    };

    try {
      _logRequest(endpoint, requestBody);
      
      final response = await http.post(
        Uri.parse('${config.hostUrl}$endpoint'),
        headers: _headers,
        body: jsonEncode(requestBody),
      );

      _logResponse(endpoint, response.statusCode, response.body);

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'success') {
          return data;
        } else {
          final errorMsg = data['message'] ?? 'Unknown error';
          throw Exception('API returned error: $errorMsg');
        }
      }
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    } catch (e) {
      _logError(endpoint, e);
      rethrow;
    }
  }

  // Helper method to format date for API (YYYY-MM-DD)
  String _formatDate(DateTime date) {
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }
}
