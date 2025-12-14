import 'package:flutter/material.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../models/trade.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class TradebookScreen extends StatefulWidget {
  final ApiConfig config;

  const TradebookScreen({super.key, required this.config});

  @override
  State<TradebookScreen> createState() => _TradebookScreenState();
}

class _TradebookScreenState extends State<TradebookScreen> {
  late final OpenAlgoApiService _apiService;
  List<Trade> _trades = [];
  bool _isLoading = true;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _fetchTrades();
    _refreshTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      _fetchTrades();
    });
  }

  Future<void> _fetchTrades() async {
    try {
      final trades = await _apiService.getTradeBook();
      if (mounted) {
        setState(() {
          _trades = trades;
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
        title: const Text('Trade Book'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchTrades,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _trades.isEmpty
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(
                        Icons.history,
                        size: 64,
                        color: AppTheme.textSecondary,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'No trades executed',
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              color: AppTheme.textSecondary,
                            ),
                      ),
                    ],
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _fetchTrades,
                  child: ListView.builder(
                    itemCount: _trades.length,
                    itemBuilder: (context, index) {
                      return _buildTradeItem(_trades[index]);
                    },
                  ),
                ),
    );
  }

  Widget _buildTradeItem(Trade trade) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    trade.symbol,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: AppTheme.textPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: AppTheme.getActionColor(trade.action)
                        .withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    trade.action,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppTheme.getActionColor(trade.action),
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(
                  'Qty: ${trade.quantity.toInt()}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  '@ ₹${trade.averagePrice.toStringAsFixed(2)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  '= ₹${trade.tradeValue.toStringAsFixed(2)}',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Text(
                  trade.product,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  trade.timestamp,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }
}
