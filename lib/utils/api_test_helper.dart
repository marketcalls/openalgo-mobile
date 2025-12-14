import 'package:flutter/foundation.dart';
import '../models/api_config.dart';
import '../services/openalgo_api_service.dart';

class ApiTestHelper {
  static Future<void> testAllEndpoints(ApiConfig config) async {
    final api = OpenAlgoApiService(config);
    final results = <String, dynamic>{};
    
    if (kDebugMode) {
      debugPrint('========== OpenAlgo API Test Started ==========');
      debugPrint('Host URL: ${config.hostUrl}');
      debugPrint('API Key: ${config.apiKey.substring(0, 8)}...');
    }

    // Test 1: Analyzer Status
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 1] Testing Analyzer Status API...');
      }
      final analyzerStatus = await api.getAnalyzerStatus();
      results['analyzer_status'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ Analyzer Status: $analyzerStatus');
      }
    } catch (e) {
      results['analyzer_status'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ Analyzer Status Failed: $e');
      }
    }

    // Test 2: Funds
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 2] Testing Funds API...');
      }
      final funds = await api.getFunds();
      results['funds'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ Funds: $funds');
      }
    } catch (e) {
      results['funds'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ Funds Failed: $e');
      }
    }

    // Test 3: Quote (RELIANCE NSE)
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 3] Testing Quote API (RELIANCE NSE)...');
      }
      final quote = await api.getQuote('RELIANCE', 'NSE');
      results['quote'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ Quote - Symbol: ${quote.symbol}, LTP: ${quote.ltp}, Change: ${quote.change}');
      }
    } catch (e) {
      results['quote'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ Quote Failed: $e');
      }
    }

    // Test 4: Depth (RELIANCE NSE)
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 4] Testing Depth API (RELIANCE NSE)...');
      }
      final depth = await api.getDepth('RELIANCE', 'NSE');
      results['depth'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ Depth - LTP: ${depth['ltp']}, Bids: ${(depth['bids'] as List).length}, Asks: ${(depth['asks'] as List).length}');
      }
    } catch (e) {
      results['depth'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ Depth Failed: $e');
      }
    }

    // Test 5: Search (TCS)
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 5] Testing Search API (TCS)...');
      }
      final searchResults = await api.searchSymbols('TCS');
      results['search'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ Search - Found ${searchResults.length} results');
        if (searchResults.isNotEmpty) {
          debugPrint('   First result: ${searchResults.first.symbol} - ${searchResults.first.name}');
        }
      }
    } catch (e) {
      results['search'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ Search Failed: $e');
      }
    }

    // Test 6: OrderBook
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 6] Testing OrderBook API...');
      }
      final orderBook = await api.getOrderBook();
      results['orderbook'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ OrderBook - Total orders: ${orderBook.orders.length}');
      }
    } catch (e) {
      results['orderbook'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ OrderBook Failed: $e');
      }
    }

    // Test 7: TradeBook
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 7] Testing TradeBook API...');
      }
      final tradeBook = await api.getTradeBook();
      results['tradebook'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ TradeBook - Total trades: ${tradeBook.length}');
      }
    } catch (e) {
      results['tradebook'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ TradeBook Failed: $e');
      }
    }

    // Test 8: PositionBook
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 8] Testing PositionBook API...');
      }
      final positionBook = await api.getPositionBook();
      results['positionbook'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ PositionBook - Total positions: ${positionBook.length}');
      }
    } catch (e) {
      results['positionbook'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ PositionBook Failed: $e');
      }
    }

    // Test 9: Holdings
    try {
      if (kDebugMode) {
        debugPrint('\n[TEST 9] Testing Holdings API...');
      }
      final holdings = await api.getHoldings();
      results['holdings'] = 'SUCCESS';
      if (kDebugMode) {
        debugPrint('✅ Holdings - Total holdings: ${holdings.holdings.length}');
      }
    } catch (e) {
      results['holdings'] = 'FAILED: $e';
      if (kDebugMode) {
        debugPrint('❌ Holdings Failed: $e');
      }
    }

    // Print summary
    if (kDebugMode) {
      debugPrint('\n========== API Test Summary ==========');
      int passed = 0;
      int failed = 0;
      results.forEach((key, value) {
        if (value.toString().startsWith('SUCCESS')) {
          passed++;
          debugPrint('✅ $key: PASSED');
        } else {
          failed++;
          debugPrint('❌ $key: FAILED');
          debugPrint('   Error: $value');
        }
      });
      debugPrint('\nTotal: ${passed + failed} tests');
      debugPrint('Passed: $passed');
      debugPrint('Failed: $failed');
      debugPrint('========================================\n');
    }
  }
}
