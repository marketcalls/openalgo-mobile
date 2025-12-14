import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../services/storage_service.dart';
import '../utils/app_theme.dart';
import 'main_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _hostUrlController = TextEditingController();
  final _wsUrlController = TextEditingController();
  final _apiKeyController = TextEditingController();
  final _storageService = StorageService();
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _loadSavedConfig();
  }

  Future<void> _loadSavedConfig() async {
    final config = await _storageService.getApiConfig();
    if (config != null) {
      _hostUrlController.text = config.hostUrl;
      _wsUrlController.text = config.webSocketUrl;
      _apiKeyController.text = config.apiKey;
    }
  }

  Future<void> _connect() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    setState(() => _isLoading = true);

    try {
      final config = ApiConfig(
        hostUrl: _hostUrlController.text.trim(),
        webSocketUrl: _wsUrlController.text.trim(),
        apiKey: _apiKeyController.text.trim(),
      );

      await _storageService.saveApiConfig(config);

      if (mounted) {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(
            builder: (_) => MainScreen(config: config),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Connection failed: $e'),
            backgroundColor: AppTheme.lossRed,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24.0),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 40),
                const Icon(
                  Icons.candlestick_chart,
                  size: 80,
                  color: AppTheme.profitGreen,
                ),
                const SizedBox(height: 16),
                Text(
                  'OpenAlgo Terminal',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.bold,
                      ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  'Connect to OpenAlgo Server',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppTheme.textSecondary,
                      ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 48),
                TextFormField(
                  controller: _hostUrlController,
                  decoration: const InputDecoration(
                    labelText: 'Host URL',
                    hintText: 'http://127.0.0.1:5000',
                    prefixIcon: Icon(Icons.link),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Please enter host URL';
                    }
                    if (!value.startsWith('http://') &&
                        !value.startsWith('https://')) {
                      return 'URL must start with http:// or https://';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _wsUrlController,
                  decoration: const InputDecoration(
                    labelText: 'WebSocket URL',
                    hintText: 'ws://127.0.0.1:8765',
                    prefixIcon: Icon(Icons.sync_alt),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Please enter WebSocket URL';
                    }
                    if (!value.startsWith('ws://') &&
                        !value.startsWith('wss://')) {
                      return 'WebSocket URL must start with ws:// or wss://';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _apiKeyController,
                  decoration: const InputDecoration(
                    labelText: 'API Key',
                    hintText: 'Enter your OpenAlgo API key',
                    prefixIcon: Icon(Icons.vpn_key),
                  ),
                  obscureText: true,
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Please enter API key';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: _isLoading ? null : _connect,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.profitGreen,
                    foregroundColor: AppTheme.backgroundColor,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                  child: _isLoading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AppTheme.backgroundColor,
                          ),
                        )
                      : const Text(
                          'Connect',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                ),
                const SizedBox(height: 24),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppTheme.cardColor,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppTheme.borderColor),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            Icons.info_outline,
                            size: 20,
                            color: AppTheme.accentBlue,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            'Connection Info',
                            style: Theme.of(context)
                                .textTheme
                                .titleSmall
                                ?.copyWith(
                                  color: AppTheme.textPrimary,
                                  fontWeight: FontWeight.w600,
                                ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Text(
                        '• Get your API key from OpenAlgo Settings',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '• Host URL is your OpenAlgo server address',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '• WebSocket URL is for real-time data streaming',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _hostUrlController.dispose();
    _wsUrlController.dispose();
    _apiKeyController.dispose();
    super.dispose();
  }
}
