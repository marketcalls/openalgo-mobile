class SymbolSearch {
  final String symbol;
  final String name;
  final String exchange;
  final String token;
  final String instrumentType;
  final int lotSize;
  final double strike;
  final String expiry;

  SymbolSearch({
    required this.symbol,
    required this.name,
    required this.exchange,
    required this.token,
    required this.instrumentType,
    required this.lotSize,
    required this.strike,
    required this.expiry,
  });

  factory SymbolSearch.fromJson(Map<String, dynamic> json) => SymbolSearch(
        symbol: json['symbol'] as String? ?? '',
        name: json['name'] as String? ?? '',
        exchange: json['exchange'] as String? ?? '',
        token: json['token'] as String? ?? '',
        instrumentType: json['instrumenttype'] as String? ?? '',
        lotSize: json['lotsize'] as int? ?? 1,
        strike: (json['strike'] ?? -1.0).toDouble(),
        expiry: json['expiry'] as String? ?? '',
      );

  String get displayName {
    if (instrumentType.isEmpty || instrumentType == 'EQ') {
      return '$name ($exchange)';
    }
    return '$symbol ($exchange)';
  }
}
