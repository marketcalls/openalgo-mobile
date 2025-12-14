import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'dart:convert';
import '../models/api_config.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class TradingViewChartScreen extends StatefulWidget {
  final ApiConfig config;
  final String symbol;
  final String exchange;

  const TradingViewChartScreen({
    super.key,
    required this.config,
    required this.symbol,
    required this.exchange,
  });

  @override
  State<TradingViewChartScreen> createState() => _TradingViewChartScreenState();
}

class _TradingViewChartScreenState extends State<TradingViewChartScreen> {
  late final OpenAlgoApiService _apiService;
  late final WebViewController _webViewController;
  
  String _selectedInterval = 'D'; // Default to Daily timeframe
  List<Map<String, String>> _intervals = [];
  bool _isLoading = true;
  bool _isChartReady = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _initializeWebView();
    _fetchIntervals();
  }

  void _initializeWebView() {
    _webViewController = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppTheme.backgroundColor)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageFinished: (String url) {
            // Chart HTML loaded, now wait for JavaScript ready signal
          },
        ),
      )
      ..addJavaScriptChannel(
        'chartEvent',
        onMessageReceived: (JavaScriptMessage message) {
          _handleChartEvent(message.message);
        },
      );

    _loadChartHTML();
  }

  Future<void> _loadChartHTML() async {
    try {
      final htmlContent = await rootBundle.loadString('assets/tradingview_chart.html');
      await _webViewController.loadHtmlString(htmlContent);
    } catch (e) {
      setState(() {
        _error = 'Failed to load chart: $e';
        _isLoading = false;
      });
    }
  }

  void _handleChartEvent(String message) {
    try {
      final data = jsonDecode(message);
      final event = data['event'];

      if (event == 'chartReady') {
        setState(() {
          _isChartReady = true;
        });
        _loadChart();
      } else if (event == 'dataLoaded') {
        setState(() {
          _isLoading = false;
        });
      } else if (event == 'error') {
        setState(() {
          _error = data['data']['message'];
          _isLoading = false;
        });
      }
    } catch (e) {
      // Ignore malformed messages
    }
  }

  Future<void> _fetchIntervals() async {
    try {
      final intervals = await _apiService.getIntervals();
      if (mounted) {
        setState(() {
          _intervals.clear();
          final data = intervals['data'] as Map<String, dynamic>;

          // Parse all interval types
          for (final category in ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months']) {
            if (data[category] != null) {
              for (final interval in data[category] as List<dynamic>) {
                _intervals.add({
                  'value': interval.toString(),
                  'label': interval.toString(),
                });
              }
            }
          }
        });
      }
    } catch (e) {
      // Silently fail - use default intervals
    }
  }

  Future<void> _loadChart() async {
    if (!_isChartReady) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final data = await _apiService.getHistoricalData(
        symbol: widget.symbol,
        exchange: widget.exchange,
        interval: _selectedInterval,
      );

      if (mounted && data.isNotEmpty) {
        // Convert API data to TradingView format with null safety
        final chartData = data.where((item) {
          // Filter out items with null required fields
          return item['timestamp'] != null &&
                 item['open'] != null &&
                 item['high'] != null &&
                 item['low'] != null &&
                 item['close'] != null;
        }).map((item) {
          return {
            'timestamp': item['timestamp'],
            'open': item['open'],
            'high': item['high'],
            'low': item['low'],
            'close': item['close'],
          };
        }).toList();

        if (chartData.isNotEmpty) {
          // Send data to WebView
          final jsonData = jsonEncode(chartData);
          await _webViewController.runJavaScript('setChartData($jsonData)');
        } else {
          throw Exception('No valid chart data available');
        }
      } else {
        throw Exception('No chart data received from API');
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Failed to load chart data: $e';
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _changeInterval(String interval) async {
    setState(() {
      _selectedInterval = interval;
    });
    await _loadChart();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.symbol} Chart'),
        backgroundColor: AppTheme.cardColor,
        actions: [
          // Timeframe selector
          if (_intervals.isNotEmpty)
            PopupMenuButton<String>(
              icon: const Icon(Icons.access_time),
              tooltip: 'Select Interval',
              onSelected: _changeInterval,
              itemBuilder: (BuildContext context) {
                return _intervals.map((interval) {
                  return PopupMenuItem<String>(
                    value: interval['value']!,
                    child: Row(
                      children: [
                        if (interval['value'] == _selectedInterval)
                          const Icon(
                            Icons.check,
                            size: 18,
                            color: AppTheme.accentBlue,
                          )
                        else
                          const SizedBox(width: 18),
                        const SizedBox(width: 8),
                        Text(
                          interval['label']!,
                          style: TextStyle(
                            fontWeight: interval['value'] == _selectedInterval
                                ? FontWeight.bold
                                : FontWeight.normal,
                            color: interval['value'] == _selectedInterval
                                ? AppTheme.accentBlue
                                : AppTheme.textPrimary,
                          ),
                        ),
                      ],
                    ),
                  );
                }).toList();
              },
            ),
          // Refresh button
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadChart,
            tooltip: 'Refresh Chart',
          ),
        ],
      ),
      body: Stack(
        children: [
          // WebView with TradingView chart
          WebViewWidget(controller: _webViewController),

          // Loading indicator
          if (_isLoading)
            Container(
              color: AppTheme.backgroundColor.withValues(alpha: 0.8),
              child: const Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircularProgressIndicator(),
                    SizedBox(height: 16),
                    Text(
                      'Loading chart...',
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 14,
                      ),
                    ),
                  ],
                ),
              ),
            ),

          // Error display
          if (_error != null)
            Container(
              color: AppTheme.backgroundColor,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(24.0),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        Icons.error_outline,
                        size: 48,
                        color: AppTheme.lossRed,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'Failed to load chart',
                        style: const TextStyle(
                          color: AppTheme.textPrimary,
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _error!,
                        style: const TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 14,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 24),
                      ElevatedButton.icon(
                        onPressed: _loadChart,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Retry'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.accentBlue,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 24,
                            vertical: 12,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),

          // TradingView attribution (required by license)
          Positioned(
            bottom: 8,
            right: 8,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: AppTheme.cardColor.withValues(alpha: 0.9),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Text(
                'Charts by TradingView',
                style: TextStyle(
                  fontSize: 10,
                  color: AppTheme.textSecondary,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    super.dispose();
  }
}
