import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/api_config.dart';

enum WebSocketMode { ltp, quote, depth }

class WebSocketService {
  final ApiConfig config;
  WebSocketChannel? _channel;
  final StreamController<Map<String, dynamic>> _dataController =
      StreamController<Map<String, dynamic>>.broadcast();
  Timer? _heartbeatTimer;
  bool _isAuthenticated = false;

  WebSocketService(this.config);

  Stream<Map<String, dynamic>> get dataStream => _dataController.stream;
  bool get isConnected => _channel != null && _isAuthenticated;

  Future<void> connect() async {
    try {
      _channel = WebSocketChannel.connect(Uri.parse(config.webSocketUrl));

      // Listen to messages
      _channel!.stream.listen(
        (message) {
          _handleMessage(message as String);
        },
        onError: (error) {
          if (kDebugMode) {
            debugPrint('WebSocket Error: $error');
          }
        },
        onDone: () {
          if (kDebugMode) {
            debugPrint('WebSocket connection closed');
          }
          _isAuthenticated = false;
          _stopHeartbeat();
        },
      );

      // Authenticate
      await _authenticate();

      // Start heartbeat
      _startHeartbeat();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('WebSocket connection error: $e');
      }
      rethrow;
    }
  }

  Future<void> _authenticate() async {
    final authMessage = jsonEncode({
      'action': 'authenticate',
      'api_key': config.apiKey,
    });
    _channel?.sink.add(authMessage);
  }

  void _handleMessage(String message) {
    try {
      final data = jsonDecode(message) as Map<String, dynamic>;

      // Handle authentication confirmation
      if (data['type'] == 'auth_success' || data['status'] == 'authenticated') {
        _isAuthenticated = true;
        if (kDebugMode) {
          debugPrint('WebSocket authenticated successfully');
        }
        return;
      }

      // Handle ping/pong
      if (data['type'] == 'ping') {
        _sendPong();
        return;
      }

      // Forward market data to stream
      if (data['type'] == 'market_data') {
        _dataController.add(data);
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Error handling message: $e');
      }
    }
  }

  void subscribe(String symbol, String exchange, WebSocketMode mode) {
    if (!_isAuthenticated) {
      if (kDebugMode) {
        debugPrint('Cannot subscribe: Not authenticated');
      }
      return;
    }

    final subscribeMessage = jsonEncode({
      'action': 'subscribe',
      'symbol': symbol,
      'exchange': exchange,
      'mode': _getModeValue(mode),
    });
    _channel?.sink.add(subscribeMessage);
  }

  void unsubscribe(String symbol, String exchange, WebSocketMode mode) {
    if (!_isAuthenticated) {
      return;
    }

    final unsubscribeMessage = jsonEncode({
      'action': 'unsubscribe',
      'symbol': symbol,
      'exchange': exchange,
      'mode': _getModeValue(mode),
    });
    _channel?.sink.add(unsubscribeMessage);
  }

  int _getModeValue(WebSocketMode mode) {
    switch (mode) {
      case WebSocketMode.ltp:
        return 1;
      case WebSocketMode.quote:
        return 2;
      case WebSocketMode.depth:
        return 3;
    }
  }

  void _sendPong() {
    final pongMessage = jsonEncode({'type': 'pong'});
    _channel?.sink.add(pongMessage);
  }

  void _startHeartbeat() {
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      _sendPong();
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void dispose() {
    _stopHeartbeat();
    _channel?.sink.close();
    _dataController.close();
    _isAuthenticated = false;
  }
}
