import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../models/order.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class OrderbookScreen extends StatefulWidget {
  final ApiConfig config;

  const OrderbookScreen({super.key, required this.config});

  @override
  State<OrderbookScreen> createState() => _OrderbookScreenState();
}

class _OrderbookScreenState extends State<OrderbookScreen> {
  late final OpenAlgoApiService _apiService;
  List<Order> _orders = [];
  OrderStatistics? _statistics;
  bool _isLoading = true;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _fetchOrders();
    _startAutoRefresh();
  }

  void _startAutoRefresh() {
    _refreshTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      _fetchOrders();
    });
  }

  Future<void> _fetchOrders() async {
    try {
      final response = await _apiService.getOrderBook();
      if (mounted) {
        setState(() {
          _orders = response.orders;
          _statistics = response.statistics;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isLoading = false);
        if (kDebugMode) {
          debugPrint('Error fetching orders: $e');
        }
      }
    }
  }

  Future<void> _cancelOrder(String orderId) async {
    try {
      final result = await _apiService.cancelOrder(orderId);
      if (mounted) {
        if (result['status'] == 'success') {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Order cancelled successfully'),
              backgroundColor: AppTheme.profitGreen,
            ),
          );
          _fetchOrders();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(result['message'] ?? 'Failed to cancel order'),
              backgroundColor: AppTheme.lossRed,
            ),
          );
        }
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

  Future<void> _cancelAllOrders() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cancel All Orders'),
        content: const Text('Are you sure you want to cancel all pending orders?'),
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
        final result = await _apiService.cancelAllOrders();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(result['message'] ?? 'Orders cancelled'),
              backgroundColor: AppTheme.profitGreen,
            ),
          );
          _fetchOrders();
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Order Book'),
        actions: [
          IconButton(
            icon: const Icon(Icons.cancel_outlined),
            onPressed: _cancelAllOrders,
            tooltip: 'Cancel All',
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchOrders,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                if (_statistics != null) _buildStatistics(),
                Expanded(
                  child: _orders.isEmpty
                      ? _buildEmptyState()
                      : RefreshIndicator(
                          onRefresh: _fetchOrders,
                          child: ListView.builder(
                            itemCount: _orders.length,
                            itemBuilder: (context, index) {
                              return _buildOrderItem(_orders[index]);
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
      child: Row(
        children: [
          Expanded(
            child: _buildStatItem(
              'Completed',
              stats.totalCompletedOrders.toInt().toString(),
              AppTheme.profitGreen,
            ),
          ),
          Expanded(
            child: _buildStatItem(
              'Pending',
              stats.totalOpenOrders.toInt().toString(),
              AppTheme.accentBlue,
            ),
          ),
          Expanded(
            child: _buildStatItem(
              'Rejected',
              stats.totalRejectedOrders.toInt().toString(),
              AppTheme.lossRed,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStatItem(String label, String value, Color color) {
    return Column(
      children: [
        Text(
          value,
          style: Theme.of(context).textTheme.titleLarge?.copyWith(
                color: color,
                fontWeight: FontWeight.bold,
              ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(
            Icons.receipt_long,
            size: 64,
            color: AppTheme.textSecondary,
          ),
          const SizedBox(height: 16),
          Text(
            'No orders found',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: AppTheme.textSecondary,
                ),
          ),
        ],
      ),
    );
  }

  Widget _buildOrderItem(Order order) {
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
                    order.symbol,
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
                    color: AppTheme.getActionColor(order.action)
                        .withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    order.action,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppTheme.getActionColor(order.action),
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
                  'Qty: ${order.quantity}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  '₹${order.price.toStringAsFixed(2)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Text(
                  order.priceType,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Text(
                  order.product,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(width: 16),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: _getStatusColor(order).withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    order.orderStatus,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: _getStatusColor(order),
                          fontSize: 11,
                        ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              order.timestamp,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontSize: 11,
                  ),
            ),
            if (order.isPending) ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => _cancelOrder(order.orderId),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.lossRed,
                    foregroundColor: Colors.white,
                  ),
                  child: const Text('Cancel Order'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Color _getStatusColor(Order order) {
    if (order.isComplete) return AppTheme.profitGreen;
    if (order.isPending) return AppTheme.accentBlue;
    if (order.isRejected) return AppTheme.lossRed;
    if (order.isCancelled) return AppTheme.textSecondary;
    return AppTheme.textSecondary;
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }
}
