/// Represents a configurable index symbol for header display
class IndexSymbol {
  final String name;
  final String symbol;
  final String exchange;
  final String displayName;

  const IndexSymbol({
    required this.name,
    required this.symbol,
    required this.exchange,
    required this.displayName,
  });

  Map<String, dynamic> toJson() => {
    'name': name,
    'symbol': symbol,
    'exchange': exchange,
    'displayName': displayName,
  };

  factory IndexSymbol.fromJson(Map<String, dynamic> json) => IndexSymbol(
    name: json['name'] as String,
    symbol: json['symbol'] as String,
    exchange: json['exchange'] as String,
    displayName: json['displayName'] as String,
  );
}

/// Supported index symbols for header display
class SupportedIndices {
  static const List<IndexSymbol> all = [
    IndexSymbol(
      name: 'NIFTY',
      symbol: 'NIFTY',
      exchange: 'NSE_INDEX',
      displayName: 'NIFTY 50',
    ),
    IndexSymbol(
      name: 'BANKNIFTY',
      symbol: 'BANKNIFTY',
      exchange: 'NSE_INDEX',
      displayName: 'BANK NIFTY',
    ),
    IndexSymbol(
      name: 'INDIAVIX',
      symbol: 'INDIAVIX',
      exchange: 'NSE_INDEX',
      displayName: 'INDIA VIX',
    ),
    IndexSymbol(
      name: 'SENSEX',
      symbol: 'SENSEX',
      exchange: 'BSE_INDEX',
      displayName: 'SENSEX',
    ),
  ];

  /// Get default indices to display (NIFTY and SENSEX)
  static List<String> getDefaults() => ['NIFTY', 'SENSEX'];

  /// Get index by name
  static IndexSymbol? getByName(String name) {
    try {
      return all.firstWhere((index) => index.name == name);
    } catch (e) {
      return null;
    }
  }
}
