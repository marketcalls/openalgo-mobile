class Holding {
  final String symbol;
  final String exchange;
  final String product;
  final int quantity;
  final double pnl;
  final double pnlPercent;

  Holding({
    required this.symbol,
    required this.exchange,
    required this.product,
    required this.quantity,
    required this.pnl,
    required this.pnlPercent,
  });

  factory Holding.fromJson(Map<String, dynamic> json) => Holding(
        symbol: json['symbol'] as String? ?? '',
        exchange: json['exchange'] as String? ?? '',
        product: json['product'] as String? ?? '',
        quantity: json['quantity'] as int? ?? 0,
        pnl: (json['pnl'] ?? 0).toDouble(),
        pnlPercent: (json['pnlpercent'] ?? 0).toDouble(),
      );

  bool get isProfit => pnl > 0;
  bool get isLoss => pnl < 0;
}

class HoldingsResponse {
  final List<Holding> holdings;
  final HoldingStatistics? statistics;

  HoldingsResponse({
    required this.holdings,
    this.statistics,
  });

  factory HoldingsResponse.fromJson(Map<String, dynamic> json) {
    final data = json['data'] as Map<String, dynamic>;
    final holdingsJson = data['holdings'] as List<dynamic>? ?? [];

    return HoldingsResponse(
      holdings: holdingsJson
          .map((holding) => Holding.fromJson(holding as Map<String, dynamic>))
          .toList(),
      statistics: data['statistics'] != null
          ? HoldingStatistics.fromJson(
              data['statistics'] as Map<String, dynamic>)
          : null,
    );
  }
}

class HoldingStatistics {
  final double totalHoldingValue;
  final double totalInvValue;
  final double totalProfitAndLoss;
  final double totalPnlPercentage;

  HoldingStatistics({
    required this.totalHoldingValue,
    required this.totalInvValue,
    required this.totalProfitAndLoss,
    required this.totalPnlPercentage,
  });

  factory HoldingStatistics.fromJson(Map<String, dynamic> json) =>
      HoldingStatistics(
        totalHoldingValue: (json['totalholdingvalue'] ?? 0).toDouble(),
        totalInvValue: (json['totalinvvalue'] ?? 0).toDouble(),
        totalProfitAndLoss: (json['totalprofitandloss'] ?? 0).toDouble(),
        totalPnlPercentage: (json['totalpnlpercentage'] ?? 0).toDouble(),
      );
}
