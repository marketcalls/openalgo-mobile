import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class ChartScreen extends StatefulWidget {
  final ApiConfig config;
  final String symbol;
  final String exchange;

  const ChartScreen({
    super.key,
    required this.config,
    required this.symbol,
    required this.exchange,
  });

  @override
  State<ChartScreen> createState() => _ChartScreenState();
}

class _ChartScreenState extends State<ChartScreen> {
  late final OpenAlgoApiService _apiService;
  String _selectedInterval = 'D'; // Default to Daily timeframe
  List<Map<String, dynamic>> _historyData = [];
  bool _isLoading = true;
  String? _error;
  final List<Map<String, String>> _intervals = [];
  
  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _fetchIntervals();
  }

  Future<void> _fetchIntervals() async {
    try {
      final intervals = await _apiService.getIntervals();
      if (mounted) {
        setState(() {
          _intervals.clear();
          final data = intervals['data'] as Map<String, dynamic>;
          
          // Parse seconds intervals (5s, 10s, 15s, 30s, 45s)
          if (data['seconds'] != null) {
            for (final interval in data['seconds'] as List<dynamic>) {
              _intervals.add({
                'value': interval.toString(),
                'label': interval.toString(),
              });
            }
          }
          
          // Parse minutes intervals (1m, 2m, 3m, 5m, 10m, 15m, 20m, 30m)
          if (data['minutes'] != null) {
            for (final interval in data['minutes'] as List<dynamic>) {
              _intervals.add({
                'value': interval.toString(),
                'label': interval.toString(),
              });
            }
          }
          
          // Parse hours intervals (1h, 2h, 4h)
          if (data['hours'] != null) {
            for (final interval in data['hours'] as List<dynamic>) {
              _intervals.add({
                'value': interval.toString(),
                'label': interval.toString(),
              });
            }
          }
          
          // Parse days intervals (D)
          if (data['days'] != null) {
            for (final interval in data['days'] as List<dynamic>) {
              _intervals.add({
                'value': interval.toString(),
                'label': interval.toString(),
              });
            }
          }
          
          // Parse weeks intervals
          if (data['weeks'] != null) {
            for (final interval in data['weeks'] as List<dynamic>) {
              _intervals.add({
                'value': interval.toString(),
                'label': interval.toString(),
              });
            }
          }
          
          // Parse months intervals
          if (data['months'] != null) {
            for (final interval in data['months'] as List<dynamic>) {
              _intervals.add({
                'value': interval.toString(),
                'label': interval.toString(),
              });
            }
          }
          
          // Default to 'D' if available, otherwise first interval
          if (_intervals.any((i) => i['value'] == 'D')) {
            _selectedInterval = 'D';
          } else if (_intervals.isNotEmpty) {
            _selectedInterval = _intervals[0]['value']!;
          }
        });
        _loadChart();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _intervals.addAll([
            {'value': '5s', 'label': '5s'},
            {'value': '1m', 'label': '1m'},
            {'value': '5m', 'label': '5m'},
            {'value': '15m', 'label': '15m'},
            {'value': '1h', 'label': '1h'},
            {'value': 'D', 'label': 'D'},
          ]);
          _selectedInterval = 'D';
        });
        _loadChart();
      }
    }
  }

  Future<void> _loadChart() async {
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

      if (mounted) {
        setState(() {
          _historyData = data;
          _isLoading = false;
        });
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.symbol} Chart'),
        actions: [
          // Timeframe selector
          PopupMenuButton<String>(
            icon: const Icon(Icons.access_time),
            initialValue: _selectedInterval,
            onSelected: (value) {
              setState(() => _selectedInterval = value);
              _loadChart();
            },
            itemBuilder: (context) {
              return _intervals.map((interval) {
                return PopupMenuItem(
                  value: interval['value'],
                  child: Text(interval['label']!),
                );
              }).toList();
            },
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.error_outline, size: 48, color: AppTheme.lossRed),
                      const SizedBox(height: 16),
                      Text(_error!),
                      const SizedBox(height: 16),
                      ElevatedButton(
                        onPressed: _loadChart,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                )
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Icon(Icons.candlestick_chart, color: AppTheme.accentBlue),
                                  const SizedBox(width: 8),
                                  Text(
                                    '${widget.symbol} Historical Data',
                                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                                          fontWeight: FontWeight.bold,
                                        ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              Text(
                                'Timeframe: $_selectedInterval',
                                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                      color: AppTheme.textSecondary,
                                    ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                'Data Points: ${_historyData.length}',
                                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                      color: AppTheme.textSecondary,
                                    ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      const Card(
                        color: AppTheme.accentBlue,
                        child: Padding(
                          padding: EdgeInsets.all(16),
                          child: Column(
                            children: [
                              Icon(Icons.info_outline, color: Colors.white, size: 48),
                              SizedBox(height: 12),
                              Text(
                                'Chart Visualization Coming Soon',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 18,
                                  fontWeight: FontWeight.bold,
                                ),
                                textAlign: TextAlign.center,
                              ),
                              SizedBox(height: 8),
                              Text(
                                'TradingView charts with indicators will be available in the next update',
                                style: TextStyle(color: Colors.white70, fontSize: 14),
                                textAlign: TextAlign.center,
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      if (_historyData.isNotEmpty) ...[
                        Text(
                          'Recent Candles',
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                        ),
                        const SizedBox(height: 8),
                        ..._historyData.take(10).map((candle) => _buildCandleCard(candle)),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _buildCandleCard(Map<String, dynamic> candle) {
    final open = (candle['open'] ?? 0).toDouble();
    final close = (candle['close'] ?? 0).toDouble();
    final isGreen = close >= open;
    
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Container(
              width: 4,
              height: 40,
              decoration: BoxDecoration(
                color: isGreen ? AppTheme.profitGreen : AppTheme.lossRed,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'O: ₹${open.toStringAsFixed(2)}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      Text(
                        'H: ₹${(candle['high'] ?? 0).toDouble().toStringAsFixed(2)}',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'C: ₹${close.toStringAsFixed(2)}',
                        style: TextStyle(
                          fontSize: 12,
                          color: isGreen ? AppTheme.profitGreen : AppTheme.lossRed,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        'L: ₹${(candle['low'] ?? 0).toDouble().toStringAsFixed(2)}',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
