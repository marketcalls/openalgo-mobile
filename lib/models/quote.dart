class Quote {
  final String symbol;
  final String exchange;
  final double open;
  final double high;
  final double low;
  final double ltp;
  final double prevClose;
  final double ask;
  final double bid;
  final int volume;
  final double change;
  final double changePercent;

  Quote({
    required this.symbol,
    required this.exchange,
    required this.open,
    required this.high,
    required this.low,
    required this.ltp,
    required this.prevClose,
    required this.ask,
    required this.bid,
    required this.volume,
    required this.change,
    required this.changePercent,
  });

  factory Quote.fromJson(Map<String, dynamic> json) {
    // Handle both formats: single quote (with 'data' wrapper) and multiquote (direct data)
    final data = json.containsKey('data') && json['data'] is Map
        ? json['data'] as Map<String, dynamic>
        : json;
    
    // Safe double conversion helper
    double toDouble(dynamic value) {
      if (value == null) return 0.0;
      if (value is double) return value;
      if (value is int) return value.toDouble();
      if (value is String) return double.tryParse(value) ?? 0.0;
      return 0.0;
    }
    
    final double ltp = toDouble(data['ltp']);
    final double prevClose = toDouble(data['prev_close']);
    final double change = ltp - prevClose;
    final double changePercent = prevClose != 0 ? (change / prevClose) * 100 : 0;

    return Quote(
      symbol: json['symbol'] as String? ?? '',
      exchange: json['exchange'] as String? ?? '',
      open: toDouble(data['open']),
      high: toDouble(data['high']),
      low: toDouble(data['low']),
      ltp: ltp,
      prevClose: prevClose,
      ask: toDouble(data['ask']),
      bid: toDouble(data['bid']),
      volume: (data['volume'] ?? 0) is int ? data['volume'] : int.tryParse(data['volume']?.toString() ?? '0') ?? 0,
      change: change,
      changePercent: changePercent,
    );
  }
}

class WatchlistItem {
  final String symbol;
  final String exchange;
  Quote? quote;
  String? errorMessage;

  WatchlistItem({
    required this.symbol,
    required this.exchange,
    this.quote,
    this.errorMessage,
  });

  Map<String, dynamic> toJson() => {
        'symbol': symbol,
        'exchange': exchange,
      };

  factory WatchlistItem.fromJson(Map<String, dynamic> json) => WatchlistItem(
        symbol: json['symbol'] as String,
        exchange: json['exchange'] as String,
      );
}
