class Trade {
  final String action;
  final String symbol;
  final String exchange;
  final String orderId;
  final String product;
  final double quantity;
  final double averagePrice;
  final String timestamp;
  final double tradeValue;

  Trade({
    required this.action,
    required this.symbol,
    required this.exchange,
    required this.orderId,
    required this.product,
    required this.quantity,
    required this.averagePrice,
    required this.timestamp,
    required this.tradeValue,
  });

  factory Trade.fromJson(Map<String, dynamic> json) => Trade(
        action: json['action'] as String? ?? '',
        symbol: json['symbol'] as String? ?? '',
        exchange: json['exchange'] as String? ?? '',
        orderId: json['orderid'] as String? ?? '',
        product: json['product'] as String? ?? '',
        quantity: (json['quantity'] ?? 0).toDouble(),
        averagePrice: (json['average_price'] ?? 0).toDouble(),
        timestamp: json['timestamp'] as String? ?? '',
        tradeValue: (json['trade_value'] ?? 0).toDouble(),
      );

  bool get isBuy => action.toUpperCase() == 'BUY';
  bool get isSell => action.toUpperCase() == 'SELL';
}
