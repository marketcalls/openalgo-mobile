import 'package:flutter/material.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../models/position.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class PositionsScreen extends StatefulWidget {
  final ApiConfig config;

  const PositionsScreen({super.key, required this.config});

  @override
  State<PositionsScreen> createState() => _PositionsScreenState();
}

class _PositionsScreenState extends State<PositionsScreen> {
  late final OpenAlgoApiService _apiService;
  List<Position> _positions = [];
  bool _isLoading = true;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _fetchPositions();
    _refreshTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      _fetchPositions();
    });
  }

  Future<void> _fetchPositions() async {
    try {
      final positions = await _apiService.getPositionBook();
      if (mounted) {
        setState(() {
          _positions = positions.where((p) => p.quantityDouble != 0).toList();
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  Future<void> _closeAllPositions() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Close All Positions'),
        content: const Text('Are you sure you want to close all open positions?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('No'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Yes'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      try {
        final result = await _apiService.closeAllPositions();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(result['message'] ?? 'Positions closed'),
              backgroundColor: AppTheme.profitGreen,
            ),
          );
          _fetchPositions();
        }
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Error: $e'),
              backgroundColor: AppTheme.lossRed,
            ),
          );
        }
      }
    }
  }

  double get _totalPnl {
    return _positions.fold(0.0, (sum, position) => sum + position.pnlDouble);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Positions'),
        actions: [
          if (_positions.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.close_fullscreen),
              onPressed: _closeAllPositions,
              tooltip: 'Close All',
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchPositions,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                if (_positions.isNotEmpty) _buildPnlSummary(),
                Expanded(
                  child: _positions.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(
                                Icons.account_balance_wallet,
                                size: 64,
                                color: AppTheme.textSecondary,
                              ),
                              const SizedBox(height: 16),
                              Text(
                                'No open positions',
                                style: Theme.of(context)
                                    .textTheme
                                    .titleMedium
                                    ?.copyWith(
                                      color: AppTheme.textSecondary,
                                    ),
                              ),
                            ],
                          ),
                        )
                      : RefreshIndicator(
                          onRefresh: _fetchPositions,
                          child: ListView.builder(
                            itemCount: _positions.length,
                            itemBuilder: (context, index) {
                              return _buildPositionItem(_positions[index]);
                            },
                          ),
                        ),
                ),
              ],
            ),
    );
  }

  Widget _buildPnlSummary() {
    return Container(
      color: AppTheme.surfaceColor,
      padding: const EdgeInsets.all(16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            'Total P&L',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: AppTheme.textPrimary,
                ),
          ),
          Text(
            '₹${_totalPnl.toStringAsFixed(2)}',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  color: AppTheme.getPnlColor(_totalPnl),
                  fontWeight: FontWeight.bold,
                ),
          ),
        ],
      ),
    );
  }

  Widget _buildPositionItem(Position position) {
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
                    position.symbol,
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
                    color: position.isLong
                        ? AppTheme.profitGreen.withValues(alpha: 0.2)
                        : AppTheme.lossRed.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    position.isLong ? 'LONG' : 'SHORT',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color:
                              position.isLong ? AppTheme.profitGreen : AppTheme.lossRed,
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
                  'Qty: ${position.quantity}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  'Avg: ₹${position.averagePrice}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  'LTP: ₹${position.ltp}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  position.product,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: AppTheme.getPnlColor(position.pnlDouble)
                        .withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    '${position.isProfit ? '+' : ''}₹${position.pnl}',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppTheme.getPnlColor(position.pnlDouble),
                          fontWeight: FontWeight.bold,
                        ),
                  ),
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
