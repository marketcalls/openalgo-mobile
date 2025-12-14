import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class ApiStatusScreen extends StatefulWidget {
  final ApiConfig config;

  const ApiStatusScreen({super.key, required this.config});

  @override
  State<ApiStatusScreen> createState() => _ApiStatusScreenState();
}

class _ApiStatusScreenState extends State<ApiStatusScreen> {
  late final OpenAlgoApiService _apiService;
  final Map<String, bool?> _endpointStatus = {};
  final Map<String, String> _endpointMessages = {};
  bool _isChecking = false;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
  }

  Future<void> _checkAllEndpoints() async {
    setState(() {
      _isChecking = true;
      _endpointStatus.clear();
      _endpointMessages.clear();
    });

    // Test each endpoint
    await _testEndpoint('Funds', () => _apiService.getFunds());
    await _testEndpoint('Quotes', () => _apiService.getQuote('RELIANCE', 'NSE'));
    await _testEndpoint('Depth', () => _apiService.getDepth('RELIANCE', 'NSE'));
    await _testEndpoint('Search', () => _apiService.searchSymbols('TCS'));
    await _testEndpoint('OrderBook', () => _apiService.getOrderBook());
    await _testEndpoint('TradeBook', () => _apiService.getTradeBook());
    await _testEndpoint('PositionBook', () => _apiService.getPositionBook());
    await _testEndpoint('Holdings', () => _apiService.getHoldings());
    await _testEndpoint('Analyzer Status', () => _apiService.getAnalyzerStatus());

    setState(() => _isChecking = false);
  }

  Future<void> _testEndpoint(String name, Future<dynamic> Function() test) async {
    try {
      await test();
      setState(() {
        _endpointStatus[name] = true;
        _endpointMessages[name] = 'Working';
      });
    } catch (e) {
      final errorMsg = e.toString();
      setState(() {
        _endpointStatus[name] = false;
        if (errorMsg.contains('404')) {
          _endpointMessages[name] = 'Not available (404)';
        } else if (errorMsg.contains('400')) {
          _endpointMessages[name] = 'Bad Request (400)';
        } else {
          _endpointMessages[name] = 'Error';
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('API Status'),
        backgroundColor: AppTheme.backgroundColor,
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'OpenAlgo API Endpoints',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Server: ${widget.config.hostUrl}',
                      style: const TextStyle(color: Colors.grey),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _isChecking ? null : _checkAllEndpoints,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.accentBlue,
                        ),
                        child: _isChecking
                            ? const SizedBox(
                                height: 20,
                                width: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Text('Check All Endpoints'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            child: _endpointStatus.isEmpty
                ? const Center(
                    child: Text('Tap "Check All Endpoints" to test API'),
                  )
                : ListView.builder(
                    itemCount: _endpointStatus.length,
                    itemBuilder: (context, index) {
                      final endpoint = _endpointStatus.keys.elementAt(index);
                      final isWorking = _endpointStatus[endpoint];
                      final message = _endpointMessages[endpoint] ?? '';

                      return ListTile(
                        leading: Icon(
                          isWorking == true
                              ? Icons.check_circle
                              : Icons.error,
                          color: isWorking == true
                              ? AppTheme.profitGreen
                              : AppTheme.lossRed,
                        ),
                        title: Text(endpoint),
                        subtitle: Text(message),
                        trailing: isWorking == true
                            ? const Text(
                                '✓',
                                style: TextStyle(
                                  color: AppTheme.profitGreen,
                                  fontSize: 24,
                                  fontWeight: FontWeight.bold,
                                ),
                              )
                            : const Text(
                                '✗',
                                style: TextStyle(
                                  color: AppTheme.lossRed,
                                  fontSize: 24,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
