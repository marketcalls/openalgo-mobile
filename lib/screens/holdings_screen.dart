import 'package:flutter/material.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../models/holding.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class HoldingsScreen extends StatefulWidget {
  final ApiConfig config;

  const HoldingsScreen({super.key, required this.config});

  @override
  State<HoldingsScreen> createState() => _HoldingsScreenState();
}

class _HoldingsScreenState extends State<HoldingsScreen> {
  late final OpenAlgoApiService _apiService;
  List<Holding> _holdings = [];
  HoldingStatistics? _statistics;
  bool _isLoading = true;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _fetchHoldings();
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _fetchHoldings();
    });
  }

  Future<void> _fetchHoldings() async {
    try {
      final response = await _apiService.getHoldings();
      if (mounted) {
        setState(() {
          _holdings = response.holdings;
          _statistics = response.statistics;
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
        title: const Text('Holdings'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchHoldings,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                if (_statistics != null) _buildStatistics(),
                Expanded(
                  child: _holdings.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(
                                Icons.business_center,
                                size: 64,
                                color: AppTheme.textSecondary,
                              ),
                              const SizedBox(height: 16),
                              Text(
                                'No holdings found',
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
                          onRefresh: _fetchHoldings,
                          child: ListView.builder(
                            itemCount: _holdings.length,
                            itemBuilder: (context, index) {
                              return _buildHoldingItem(_holdings[index]);
                            },
                          ),
                        ),
                ),
              ],
            ),
    );
  }

  Widget _buildStatistics() {
    final stats = _statistics!;
    return Container(
      color: AppTheme.surfaceColor,
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Current Value',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '₹${stats.totalHoldingValue.toStringAsFixed(2)}',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: AppTheme.textPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ],
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    'Investment',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '₹${stats.totalInvValue.toStringAsFixed(2)}',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: AppTheme.textPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Divider(color: AppTheme.borderColor),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Total P&L',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      color: AppTheme.textPrimary,
                    ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '₹${stats.totalProfitAndLoss.toStringAsFixed(2)}',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          color: AppTheme.getPnlColor(stats.totalProfitAndLoss),
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  Text(
                    '(${stats.totalPnlPercentage >= 0 ? '+' : ''}${stats.totalPnlPercentage.toStringAsFixed(2)}%)',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AppTheme.getPnlColor(stats.totalProfitAndLoss),
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildHoldingItem(Holding holding) {
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
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        holding.symbol,
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              color: AppTheme.textPrimary,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Qty: ${holding.quantity}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: AppTheme.getPnlColor(holding.pnl)
                            .withValues(alpha: 0.2),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        '${holding.isProfit ? '+' : ''}₹${holding.pnl.toStringAsFixed(2)}',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: AppTheme.getPnlColor(holding.pnl),
                              fontWeight: FontWeight.bold,
                            ),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '(${holding.pnlPercent >= 0 ? '+' : ''}${holding.pnlPercent.toStringAsFixed(2)}%)',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: AppTheme.getPnlColor(holding.pnl),
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                  ],
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
