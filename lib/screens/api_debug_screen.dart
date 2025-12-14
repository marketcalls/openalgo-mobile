import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../utils/app_theme.dart';
import '../utils/api_test_helper.dart';

class ApiDebugScreen extends StatefulWidget {
  final ApiConfig config;

  const ApiDebugScreen({super.key, required this.config});

  @override
  State<ApiDebugScreen> createState() => _ApiDebugScreenState();
}

class _ApiDebugScreenState extends State<ApiDebugScreen> {
  bool _isTesting = false;
  final List<String> _logs = [];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('API Debug Tool'),
        actions: [
          IconButton(
            icon: const Icon(Icons.delete_outline),
            onPressed: _logs.isEmpty
                ? null
                : () {
                    setState(() {
                      _logs.clear();
                    });
                  },
            tooltip: 'Clear Logs',
          ),
        ],
      ),
      body: Column(
        children: [
          // Test Button Section
          Container(
            padding: const EdgeInsets.all(16),
            color: AppTheme.surfaceColor,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ElevatedButton.icon(
                  onPressed: _isTesting ? null : _runTests,
                  icon: _isTesting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Icon(Icons.play_arrow),
                  label: Text(_isTesting ? 'Testing...' : 'Run All API Tests'),
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    backgroundColor: AppTheme.accentBlue,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'This will test all OpenAlgo API endpoints',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: AppTheme.textSecondary,
                      ),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          
          // Connection Info
          Container(
            padding: const EdgeInsets.all(16),
            color: AppTheme.surfaceColor.withValues(alpha: 0.5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Connection Details',
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 8),
                _buildInfoRow('Host URL', widget.config.hostUrl),
                _buildInfoRow(
                  'API Key',
                  '${widget.config.apiKey.substring(0, 8)}...',
                ),
                _buildInfoRow('WebSocket URL', widget.config.webSocketUrl),
              ],
            ),
          ),
          const Divider(height: 1),
          
          // Logs Section
          Expanded(
            child: _logs.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(
                          Icons.bug_report,
                          size: 64,
                          color: AppTheme.textSecondary,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'No logs yet',
                          style: Theme.of(context)
                              .textTheme
                              .titleMedium
                              ?.copyWith(
                                color: AppTheme.textSecondary,
                              ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Run tests to see API responses',
                          style: Theme.of(context)
                              .textTheme
                              .bodySmall
                              ?.copyWith(
                                color: AppTheme.textSecondary,
                              ),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _logs.length,
                    itemBuilder: (context, index) {
                      return _buildLogItem(_logs[index]);
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: AppTheme.textSecondary,
                  ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w500,
                  ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLogItem(String log) {
    Color backgroundColor = AppTheme.backgroundColor;
    Color textColor = AppTheme.textPrimary;

    if (log.contains('✅')) {
      backgroundColor = AppTheme.profitGreen.withValues(alpha: 0.1);
      textColor = AppTheme.profitGreen;
    } else if (log.contains('❌')) {
      backgroundColor = AppTheme.lossRed.withValues(alpha: 0.1);
      textColor = AppTheme.lossRed;
    } else if (log.contains('🔵')) {
      backgroundColor = AppTheme.accentBlue.withValues(alpha: 0.1);
      textColor = AppTheme.accentBlue;
    } else if (log.contains('🟢')) {
      backgroundColor = AppTheme.profitGreen.withValues(alpha: 0.05);
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: backgroundColor,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: textColor.withValues(alpha: 0.2),
        ),
      ),
      child: Text(
        log,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
              fontFamily: 'monospace',
              fontSize: 11,
              color: textColor,
            ),
      ),
    );
  }

  Future<void> _runTests() async {
    setState(() {
      _isTesting = true;
      _logs.clear();
      _logs.add('========== Starting API Tests ==========');
      _logs.add('Host: ${widget.config.hostUrl}');
      _logs.add('Time: ${DateTime.now()}');
      _logs.add('');
    });

    // Capture debug prints
    final originalPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null && mounted) {
        setState(() {
          _logs.add(message);
        });
      }
      originalPrint(message, wrapWidth: wrapWidth);
    };

    try {
      await ApiTestHelper.testAllEndpoints(widget.config);
    } catch (e) {
      setState(() {
        _logs.add('❌ Critical Error: $e');
      });
    }

    // Restore original debugPrint
    debugPrint = originalPrint;

    if (mounted) {
      setState(() {
        _isTesting = false;
        _logs.add('');
        _logs.add('========== Tests Completed ==========');
      });
    }
  }
}
