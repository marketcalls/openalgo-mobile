import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../models/quote.dart';
import '../services/openalgo_api_service.dart';
import '../services/storage_service.dart';
import '../utils/app_theme.dart';
import '../widgets/mode_indicator.dart';
import 'search_symbol_screen.dart';
import 'place_order_screen.dart';
import 'depth_screen.dart';
import 'coming_soon_screen.dart';

class WatchlistScreen extends StatefulWidget {
  final ApiConfig config;

  const WatchlistScreen({super.key, required this.config});

  @override
  State<WatchlistScreen> createState() => _WatchlistScreenState();
}

class _WatchlistScreenState extends State<WatchlistScreen> {
  late final OpenAlgoApiService _apiService;
  final _storageService = StorageService();
  
  List<WatchlistItem> _watchlist = [];
  bool _isLoading = true;
  bool _isAnalyzeMode = false;
  Timer? _refreshTimer;
  Timer? _modeCheckTimer;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _loadWatchlist();
    _fetchAnalyzerStatus(); // Fetch analyzer status on init
    _startAutoRefresh();
    _startModeCheck(); // Check analyzer status periodically
  }

  Future<void> _fetchAnalyzerStatus() async {
    try {
      final status = await _apiService.getAnalyzerStatus();
      if (mounted) {
        setState(() {
          final data = status['data'] as Map<String, dynamic>;
          _isAnalyzeMode = (data['mode'] ?? data['analyze_mode'] ?? data['analyzermode']) as bool? ?? false;
        });
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Error fetching analyzer status: $e');
      }
      // Default to false if API fails
      if (mounted) {
        setState(() {
          _isAnalyzeMode = false;
        });
      }
    }
  }

  void _startModeCheck() {
    // Check analyzer mode every 30 seconds
    _modeCheckTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _fetchAnalyzerStatus();
    });
  }

  Future<void> _loadWatchlist() async {
    final saved = await _storageService.getWatchlist();
    
    // Remove any index symbols from watchlist (they belong in header only)
    final indexSymbols = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'INDIAVIX'];
    final cleaned = saved.where((item) => 
      !indexSymbols.contains(item.symbol.toUpperCase())
    ).toList();
    
    // If watchlist was modified (indices removed), save the cleaned version
    if (cleaned.length != saved.length) {
      await _storageService.saveWatchlist(cleaned);
    }
    
    if (cleaned.isEmpty) {
      // Add default watchlist items (indices are now in header)
      cleaned.addAll([
        WatchlistItem(symbol: 'RELIANCE', exchange: 'NSE'),
        WatchlistItem(symbol: 'SBIN', exchange: 'NSE'),
        WatchlistItem(symbol: 'INFY', exchange: 'NSE'),
        WatchlistItem(symbol: 'TCS', exchange: 'NSE'),
      ]);
      await _storageService.saveWatchlist(cleaned);
    }

    setState(() {
      _watchlist = cleaned;
      _isLoading = false;
    });

    _fetchQuotes();
  }

  void _startAutoRefresh() {
    // Refresh quotes every 5 seconds for real-time feel
    _refreshTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      _fetchQuotes();
    });
  }

  Future<void> _fetchQuotes() async {
    if (_watchlist.isEmpty) return;

    // Use individual quotes for maximum compatibility
    // MultiQuotes API is optional and not widely supported yet
    await _fetchQuotesIndividually();
  }

  // Fallback method for servers without multiquotes API
  Future<void> _fetchQuotesIndividually() async {
    for (final item in _watchlist) {
      try {
        final quote = await _apiService.getQuote(item.symbol, item.exchange);
        if (mounted) {
          setState(() {
            item.quote = quote;
            item.errorMessage = null;
          });
        }
      } catch (e) {
        if (kDebugMode) {
          debugPrint('Error fetching quote for ${item.symbol}: $e');
        }
        if (mounted) {
          setState(() {
            item.errorMessage = _getErrorMessage(e);
          });
        }
      }
    }
  }

  String _getErrorMessage(dynamic error) {
    final errorStr = error.toString();
    if (errorStr.contains('403')) {
      return 'Access forbidden';
    } else if (errorStr.contains('404')) {
      return 'Not available';
    } else if (errorStr.contains('timeout')) {
      return 'Timeout';
    } else if (errorStr.contains('CORS') || errorStr.contains('XMLHttpRequest')) {
      return 'Server CORS issue';
    } else if (errorStr.contains('NetworkException') || errorStr.contains('SocketException')) {
      return 'Network error';
    }
    return 'Error';
  }

  bool _isIndexSymbol(String exchange) {
    return exchange == 'NSE_INDEX' || exchange == 'BSE_INDEX';
  }

  Future<void> _addSymbol() async {
    final result = await Navigator.of(context).push<WatchlistItem>(
      MaterialPageRoute(
        builder: (_) => SearchSymbolScreen(config: widget.config),
      ),
    );

    if (result != null) {
      setState(() {
        _watchlist.add(result);
      });
      await _storageService.saveWatchlist(_watchlist);
      // Fetch quote for new symbol immediately
      _fetchQuoteForItem(result);
    }
  }

  Future<void> _fetchQuoteForItem(WatchlistItem item) async {
    try {
      final quote = await _apiService.getQuote(item.symbol, item.exchange);
      if (mounted) {
        setState(() {
          item.quote = quote;
        });
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Error fetching quote for ${item.symbol}: $e');
      }
    }
  }

  Future<void> _removeSymbol(int index) async {
    setState(() {
      _watchlist.removeAt(index);
    });
    await _storageService.saveWatchlist(_watchlist);
  }

  void _openPlaceOrder(WatchlistItem item) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PlaceOrderScreen(
          config: widget.config,
          symbol: item.symbol,
          exchange: item.exchange,
          ltp: item.quote?.ltp ?? 0,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Watchlist'),
        actions: [
          ModeIndicator(isAnalyzeMode: _isAnalyzeMode),
          const SizedBox(width: 8),
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: _addSymbol,
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchQuotes,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _watchlist.isEmpty
              ? _buildEmptyState()
              : RefreshIndicator(
                  onRefresh: _fetchQuotes,
                  child: ListView.builder(
                    itemCount: _watchlist.length,
                    itemBuilder: (context, index) {
                      final item = _watchlist[index];
                      return _buildWatchlistItem(item, index);
                    },
                  ),
                ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(
            Icons.waterfall_chart,
            size: 64,
            color: AppTheme.textSecondary,
          ),
          const SizedBox(height: 16),
          Text(
            'No symbols in watchlist',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: AppTheme.textSecondary,
                ),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: _addSymbol,
            icon: const Icon(Icons.add),
            label: const Text('Add Symbol'),
          ),
        ],
      ),
    );
  }

  Widget _buildWatchlistItem(WatchlistItem item, int index) {
    final quote = item.quote;
    
    return Dismissible(
      key: Key('${item.symbol}_${item.exchange}_$index'),
      direction: DismissDirection.endToStart,
      background: Container(
        color: AppTheme.lossRed,
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 20),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: const [
            Icon(Icons.delete, color: Colors.white, size: 32),
            SizedBox(height: 4),
            Text(
              'Remove',
              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
      confirmDismiss: (direction) async {
        return await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Remove Symbol'),
            content: Text('Remove ${item.symbol} from watchlist?'),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('Cancel'),
              ),
              TextButton(
                onPressed: () => Navigator.of(context).pop(true),
                style: TextButton.styleFrom(foregroundColor: AppTheme.lossRed),
                child: const Text('Remove'),
              ),
            ],
          ),
        );
      },
      onDismissed: (_) {
        _removeSymbol(index);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('${item.symbol} removed from watchlist'),
            duration: const Duration(seconds: 2),
          ),
        );
      },
      child: Card(
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Column(
          children: [
            InkWell(
              onTap: () => _openPlaceOrder(item),
              onLongPress: () {
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => const ComingSoonScreen(
                      featureName: 'TradingView Charts',
                      description: 'Advanced charting features with technical indicators are under development and will be available soon.',
                    ),
                  ),
                );
              },
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Expanded(
                      flex: 2,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            item.symbol,
                            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                  color: AppTheme.textPrimary,
                                  fontWeight: FontWeight.w600,
                                ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            item.exchange,
                            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                  color: AppTheme.textSecondary,
                                ),
                          ),
                        ],
                      ),
                    ),
                    if (quote != null) ...[
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              '₹${quote.ltp.toStringAsFixed(2)}',
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                    color: AppTheme.textPrimary,
                                    fontWeight: FontWeight.bold,
                                  ),
                            ),
                            const SizedBox(height: 4),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: AppTheme.getPnlColor(quote.change)
                                    .withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                '${quote.change >= 0 ? '+' : ''}${quote.change.toStringAsFixed(2)} (${quote.changePercent.toStringAsFixed(2)}%)',
                                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                      color: AppTheme.getPnlColor(quote.change),
                                      fontWeight: FontWeight.w600,
                                    ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ] else if (item.errorMessage != null)
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Icon(
                              Icons.error_outline,
                              size: 20,
                              color: AppTheme.lossRed,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              item.errorMessage!,
                              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                    color: AppTheme.lossRed,
                                    fontSize: 11,
                                  ),
                              textAlign: TextAlign.end,
                            ),
                          ],
                        ),
                      )
                    else
                      const Expanded(
                        child: Center(
                          child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            // Action buttons: Buy, Sell, Depth (or just Depth for indices)
            Container(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: AppTheme.borderColor,
                    width: 1,
                  ),
                ),
              ),
              child: _isIndexSymbol(item.exchange)
                  ? // Only show Chart and Depth for indices
                  Row(
                      children: [
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => const ComingSoonScreen(
                                    featureName: 'TradingView Charts',
                                    description: 'Advanced charting features with technical indicators are under development and will be available soon.',
                                  ),
                                ),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                border: Border(
                                  right: BorderSide(
                                    color: AppTheme.borderColor,
                                    width: 0.5,
                                  ),
                                ),
                              ),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(Icons.candlestick_chart, size: 18, color: AppTheme.accentBlue),
                                  const SizedBox(height: 2),
                                  Text(
                                    'Chart',
                                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                          color: AppTheme.accentBlue,
                                          fontSize: 10,
                                          fontWeight: FontWeight.w600,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => DepthScreen(
                                    config: widget.config,
                                    symbol: item.symbol,
                                    exchange: item.exchange,
                                  ),
                                ),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(Icons.layers, size: 18, color: AppTheme.accentBlue),
                                  const SizedBox(height: 2),
                                  Text(
                                    'Depth',
                                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                          color: AppTheme.accentBlue,
                                          fontSize: 10,
                                          fontWeight: FontWeight.w600,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ],
                    )
                  : // Show B, S, Depth for tradable symbols
                  Row(
                      children: [
                        // Buy Button
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => PlaceOrderScreen(
                                    config: widget.config,
                                    symbol: item.symbol,
                                    exchange: item.exchange,
                                    ltp: item.quote?.ltp ?? 0,
                                    initialAction: 'BUY',
                                  ),
                                ),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                color: AppTheme.profitGreen.withValues(alpha: 0.1),
                                border: Border(
                                  right: BorderSide(
                                    color: AppTheme.borderColor,
                                    width: 0.5,
                                  ),
                                ),
                              ),
                              child: Center(
                                child: Text(
                                  'B',
                                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                        color: AppTheme.profitGreen,
                                        fontWeight: FontWeight.bold,
                                      ),
                                ),
                              ),
                            ),
                          ),
                        ),
                        // Sell Button
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => PlaceOrderScreen(
                                    config: widget.config,
                                    symbol: item.symbol,
                                    exchange: item.exchange,
                                    ltp: item.quote?.ltp ?? 0,
                                    initialAction: 'SELL',
                                  ),
                                ),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                color: AppTheme.lossRed.withValues(alpha: 0.1),
                                border: Border(
                                  right: BorderSide(
                                    color: AppTheme.borderColor,
                                    width: 0.5,
                                  ),
                                ),
                              ),
                              child: Center(
                                child: Text(
                                  'S',
                                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                        color: AppTheme.lossRed,
                                        fontWeight: FontWeight.bold,
                                      ),
                                ),
                              ),
                            ),
                          ),
                        ),
                        // Chart Button
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => const ComingSoonScreen(
                                    featureName: 'TradingView Charts',
                                    description: 'Advanced charting features with technical indicators are under development and will be available soon.',
                                  ),
                                ),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                border: Border(
                                  right: BorderSide(
                                    color: AppTheme.borderColor,
                                    width: 0.5,
                                  ),
                                ),
                              ),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(Icons.candlestick_chart, size: 14, color: AppTheme.accentBlue),
                                  const SizedBox(height: 2),
                                  Text(
                                    'Chart',
                                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                          color: AppTheme.accentBlue,
                                          fontSize: 9,
                                          fontWeight: FontWeight.w600,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        // Depth Button
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => DepthScreen(
                                    config: widget.config,
                                    symbol: item.symbol,
                                    exchange: item.exchange,
                                  ),
                                ),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(Icons.layers, size: 14, color: AppTheme.accentBlue),
                                  const SizedBox(height: 2),
                                  Text(
                                    'Depth',
                                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                          color: AppTheme.accentBlue,
                                          fontSize: 9,
                                          fontWeight: FontWeight.w600,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _modeCheckTimer?.cancel();
    super.dispose();
  }
}
