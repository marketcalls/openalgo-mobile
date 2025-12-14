import 'package:flutter/material.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';
import 'place_order_screen.dart';

class DepthScreen extends StatefulWidget {
  final ApiConfig config;
  final String symbol;
  final String exchange;

  const DepthScreen({
    super.key,
    required this.config,
    required this.symbol,
    required this.exchange,
  });

  @override
  State<DepthScreen> createState() => _DepthScreenState();
}

class _DepthScreenState extends State<DepthScreen> {
  late final OpenAlgoApiService _apiService;
  Map<String, dynamic>? _depthData;
  bool _isLoading = true;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _fetchDepth();
    _startAutoRefresh();
  }

  void _startAutoRefresh() {
    _refreshTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      _fetchDepth();
    });
  }

  Future<void> _fetchDepth() async {
    try {
      final depth = await _apiService.getDepth(widget.symbol, widget.exchange);
      if (mounted) {
        setState(() {
          _depthData = depth;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.symbol} Depth'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchDepth,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _depthData == null
              ? const Center(child: Text('No depth data available'))
              : Column(
                  children: [
                    Expanded(
                      child: RefreshIndicator(
                        onRefresh: _fetchDepth,
                        child: ListView(
                          padding: const EdgeInsets.all(16),
                          children: [
                      // LTP Display
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            children: [
                              Text(
                                'Last Traded Price',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                '₹${_depthData!['ltp']?.toStringAsFixed(2) ?? '0.00'}',
                                style: Theme.of(context)
                                    .textTheme
                                    .headlineMedium
                                    ?.copyWith(
                                      color: AppTheme.textPrimary,
                                      fontWeight: FontWeight.bold,
                                    ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      // Market Depth
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Column(
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: AppTheme.profitGreen
                                        .withValues(alpha: 0.2),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.center,
                                    children: [
                                      const Icon(
                                        Icons.arrow_upward,
                                        color: AppTheme.profitGreen,
                                        size: 16,
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        'BUY',
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium
                                            ?.copyWith(
                                              color: AppTheme.profitGreen,
                                              fontWeight: FontWeight.bold,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 8),
                                ..._buildBidRows(),
                              ],
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color:
                                        AppTheme.lossRed.withValues(alpha: 0.2),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.center,
                                    children: [
                                      const Icon(
                                        Icons.arrow_downward,
                                        color: AppTheme.lossRed,
                                        size: 16,
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        'SELL',
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium
                                            ?.copyWith(
                                              color: AppTheme.lossRed,
                                              fontWeight: FontWeight.bold,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 8),
                                ..._buildAskRows(),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            // Buy/Sell Buttons
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Theme.of(context).scaffoldBackgroundColor,
                border: Border(
                  top: BorderSide(color: AppTheme.borderColor),
                ),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () {
                        final ltp = (_depthData!['ltp'] as num?)?.toDouble() ?? 0.0;
                        Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => PlaceOrderScreen(
                              config: widget.config,
                              symbol: widget.symbol,
                              exchange: widget.exchange,
                              ltp: ltp,
                              initialAction: 'BUY',
                            ),
                          ),
                        );
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.profitGreen,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                      child: const Text(
                        'BUY',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () {
                        final ltp = (_depthData!['ltp'] as num?)?.toDouble() ?? 0.0;
                        Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => PlaceOrderScreen(
                              config: widget.config,
                              symbol: widget.symbol,
                              exchange: widget.exchange,
                              ltp: ltp,
                              initialAction: 'SELL',
                            ),
                          ),
                        );
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.lossRed,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                      child: const Text(
                        'SELL',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
    );
  }

  List<Widget> _buildBidRows() {
    final bids = _depthData!['bids'] as List<dynamic>? ?? [];
    return bids.take(5).map((bid) {
      final bidMap = bid as Map<String, dynamic>;
      final price = (bidMap['price'] ?? 0).toDouble();
      final quantity = (bidMap['quantity'] ?? 0).toInt();
      return _buildDepthRow(
        '₹${price.toStringAsFixed(2)}',
        quantity.toString(),
        AppTheme.profitGreen,
      );
    }).toList();
  }

  List<Widget> _buildAskRows() {
    final asks = _depthData!['asks'] as List<dynamic>? ?? [];
    return asks.take(5).map((ask) {
      final askMap = ask as Map<String, dynamic>;
      final price = (askMap['price'] ?? 0).toDouble();
      final quantity = (askMap['quantity'] ?? 0).toInt();
      return _buildDepthRow(
        '₹${price.toStringAsFixed(2)}',
        quantity.toString(),
        AppTheme.lossRed,
      );
    }).toList();
  }

  Widget _buildDepthRow(String price, String quantity, Color color) {
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            price,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: color,
                  fontWeight: FontWeight.w600,
                ),
          ),
          Text(
            quantity,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: AppTheme.textSecondary,
                ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }
}
