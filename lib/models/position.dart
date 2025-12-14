class Position {
  final String symbol;
  final String exchange;
  final String product;
  final String quantity;
  final String averagePrice;
  final String ltp;
  final String pnl;

  Position({
    required this.symbol,
    required this.exchange,
    required this.product,
    required this.quantity,
    required this.averagePrice,
    required this.ltp,
    required this.pnl,
  });

  factory Position.fromJson(Map<String, dynamic> json) => Position(
        symbol: json['symbol'] as String? ?? '',
        exchange: json['exchange'] as String? ?? '',
        product: json['product'] as String? ?? '',
        quantity: json['quantity']?.toString() ?? '0',
        averagePrice: json['average_price']?.toString() ?? '0.0',
        ltp: json['ltp']?.toString() ?? '0.0',
        pnl: json['pnl']?.toString() ?? '0.0',
      );

  double get quantityDouble => double.tryParse(quantity) ?? 0.0;
  double get averagePriceDouble => double.tryParse(averagePrice) ?? 0.0;
  double get ltpDouble => double.tryParse(ltp) ?? 0.0;
  double get pnlDouble => double.tryParse(pnl) ?? 0.0;

  bool get isLong => quantityDouble > 0;
  bool get isShort => quantityDouble < 0;
  bool get isProfit => pnlDouble > 0;
  bool get isLoss => pnlDouble < 0;
}
