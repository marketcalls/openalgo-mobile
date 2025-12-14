class Order {
  final String orderId;
  final String symbol;
  final String exchange;
  final String action;
  final String product;
  final String quantity;
  final double price;
  final String priceType;
  final String orderStatus;
  final double triggerPrice;
  final String timestamp;
  final double averagePrice;

  Order({
    required this.orderId,
    required this.symbol,
    required this.exchange,
    required this.action,
    required this.product,
    required this.quantity,
    required this.price,
    required this.priceType,
    required this.orderStatus,
    required this.triggerPrice,
    required this.timestamp,
    required this.averagePrice,
  });

  factory Order.fromJson(Map<String, dynamic> json) => Order(
        orderId: json['orderid'] as String? ?? '',
        symbol: json['symbol'] as String? ?? '',
        exchange: json['exchange'] as String? ?? '',
        action: json['action'] as String? ?? '',
        product: json['product'] as String? ?? '',
        quantity: json['quantity']?.toString() ?? '0',
        price: (json['price'] ?? 0).toDouble(),
        priceType: json['pricetype'] as String? ?? '',
        orderStatus: json['order_status'] as String? ?? '',
        triggerPrice: (json['trigger_price'] ?? 0).toDouble(),
        timestamp: json['timestamp'] as String? ?? '',
        averagePrice: (json['average_price'] ?? 0).toDouble(),
      );

  bool get isComplete => orderStatus.toLowerCase() == 'complete';
  bool get isPending =>
      orderStatus.toLowerCase() == 'pending' ||
      orderStatus.toLowerCase() == 'open' ||
      orderStatus.toLowerCase() == 'trigger pending';
  bool get isCancelled => orderStatus.toLowerCase() == 'cancelled';
  bool get isRejected => orderStatus.toLowerCase() == 'rejected';
}

class OrderBookResponse {
  final List<Order> orders;
  final OrderStatistics? statistics;

  OrderBookResponse({
    required this.orders,
    this.statistics,
  });

  factory OrderBookResponse.fromJson(Map<String, dynamic> json) {
    final data = json['data'] as Map<String, dynamic>;
    final ordersJson = data['orders'] as List<dynamic>? ?? [];

    return OrderBookResponse(
      orders: ordersJson
          .map((order) => Order.fromJson(order as Map<String, dynamic>))
          .toList(),
      statistics: data['statistics'] != null
          ? OrderStatistics.fromJson(data['statistics'] as Map<String, dynamic>)
          : null,
    );
  }
}

class OrderStatistics {
  final double totalBuyOrders;
  final double totalSellOrders;
  final double totalCompletedOrders;
  final double totalOpenOrders;
  final double totalRejectedOrders;

  OrderStatistics({
    required this.totalBuyOrders,
    required this.totalSellOrders,
    required this.totalCompletedOrders,
    required this.totalOpenOrders,
    required this.totalRejectedOrders,
  });

  factory OrderStatistics.fromJson(Map<String, dynamic> json) => OrderStatistics(
        totalBuyOrders: (json['total_buy_orders'] ?? 0).toDouble(),
        totalSellOrders: (json['total_sell_orders'] ?? 0).toDouble(),
        totalCompletedOrders: (json['total_completed_orders'] ?? 0).toDouble(),
        totalOpenOrders: (json['total_open_orders'] ?? 0).toDouble(),
        totalRejectedOrders: (json['total_rejected_orders'] ?? 0).toDouble(),
      );
}
