import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class PlaceOrderScreen extends StatefulWidget {
  final ApiConfig config;
  final String symbol;
  final String exchange;
  final double ltp;
  final String? initialAction;

  const PlaceOrderScreen({
    super.key,
    required this.config,
    required this.symbol,
    required this.exchange,
    required this.ltp,
    this.initialAction,
  });

  @override
  State<PlaceOrderScreen> createState() => _PlaceOrderScreenState();
}

class _PlaceOrderScreenState extends State<PlaceOrderScreen> {
  late final OpenAlgoApiService _apiService;
  final _quantityController = TextEditingController(text: '1');
  final _priceController = TextEditingController();
  final _triggerPriceController = TextEditingController();
  
  late String _action;
  String _priceType = 'MARKET';
  String _product = 'MIS';
  bool _isPlacing = false;
  int _lotSize = 1;
  int _lots = 1;

  final List<String> _priceTypes = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  final List<String> _products = ['MIS', 'CNC', 'NRML'];

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _priceController.text = widget.ltp.toStringAsFixed(2);
    _action = widget.initialAction ?? 'BUY';
    _checkAndFetchLotSize();
  }

  bool _isDerivativeExchange() {
    return widget.exchange == 'NFO' || 
           widget.exchange == 'BFO' || 
           widget.exchange == 'MCX' || 
           widget.exchange == 'CDS';
  }

  Future<void> _checkAndFetchLotSize() async {
    if (!_isDerivativeExchange()) {
      return;
    }

    try {
      final symbolInfo = await _apiService.getSymbolInfo(widget.symbol, widget.exchange);
      final lotSize = symbolInfo['lotsize'] as int? ?? 1;
      
      if (mounted) {
        setState(() {
          _lotSize = lotSize;
          _lots = 1;
          _quantityController.text = lotSize.toString();
        });
      }
    } catch (e) {
      // Default to lot size of 1 if fetch fails
      if (mounted) {
        setState(() {
          _lotSize = 1;
          _lots = 1;
        });
      }
    }
  }

  void _updateQuantityFromLots(int lots) {
    setState(() {
      _lots = lots;
      _quantityController.text = (lots * _lotSize).toString();
    });
  }

  Future<void> _placeOrder() async {
    if (_quantityController.text.isEmpty) {
      _showError('Please enter quantity');
      return;
    }

    if ((_priceType == 'LIMIT' || _priceType == 'SL') &&
        _priceController.text.isEmpty) {
      _showError('Please enter price');
      return;
    }

    if ((_priceType == 'SL' || _priceType == 'SL-M') &&
        _triggerPriceController.text.isEmpty) {
      _showError('Please enter trigger price');
      return;
    }

    setState(() => _isPlacing = true);

    try {
      final result = await _apiService.placeOrder(
        symbol: widget.symbol,
        exchange: widget.exchange,
        action: _action,
        quantity: _quantityController.text,
        priceType: _priceType,
        product: _product,
        price: _priceType != 'MARKET' && _priceType != 'SL-M'
            ? _priceController.text
            : null,
        triggerPrice: _priceType == 'SL' || _priceType == 'SL-M'
            ? _triggerPriceController.text
            : null,
      );

      if (mounted) {
        if (result['status'] == 'success') {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Order placed successfully: ${result['orderid']}'),
              backgroundColor: AppTheme.profitGreen,
            ),
          );
          Navigator.of(context).pop();
        } else {
          _showError(result['message'] ?? 'Failed to place order');
        }
      }
    } catch (e) {
      if (mounted) {
        _showError('Error: $e');
      }
    } finally {
      if (mounted) {
        setState(() => _isPlacing = false);
      }
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: AppTheme.lossRed,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Place Order'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.symbol,
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                            color: AppTheme.textPrimary,
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      widget.exchange,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: AppTheme.textSecondary,
                          ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Text(
                          'LTP: ',
                          style:
                              Theme.of(context).textTheme.bodyMedium?.copyWith(
                                    color: AppTheme.textSecondary,
                                  ),
                        ),
                        Text(
                          '₹${widget.ltp.toStringAsFixed(2)}',
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                color: AppTheme.textPrimary,
                                fontWeight: FontWeight.w600,
                              ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            // Action selector (BUY/SELL)
            Row(
              children: [
                Expanded(
                  child: ElevatedButton(
                    onPressed: () => setState(() => _action = 'BUY'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _action == 'BUY'
                          ? AppTheme.profitGreen
                          : AppTheme.cardColor,
                      foregroundColor: _action == 'BUY'
                          ? AppTheme.backgroundColor
                          : AppTheme.textSecondary,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                    child: const Text(
                      'BUY',
                      style: TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton(
                    onPressed: () => setState(() => _action = 'SELL'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _action == 'SELL'
                          ? AppTheme.lossRed
                          : AppTheme.cardColor,
                      foregroundColor: _action == 'SELL'
                          ? Colors.white
                          : AppTheme.textSecondary,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                    child: const Text(
                      'SELL',
                      style: TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            // Lot size info for derivatives
            if (_isDerivativeExchange() && _lotSize > 1)
              Card(
                color: AppTheme.accentBlue.withValues(alpha: 0.1),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      const Icon(Icons.info_outline, size: 18, color: AppTheme.accentBlue),
                      const SizedBox(width: 8),
                      Text(
                        'Lot Size: $_lotSize',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: AppTheme.accentBlue,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    ],
                  ),
                ),
              ),
            if (_isDerivativeExchange() && _lotSize > 1)
              const SizedBox(height: 12),
            // Lots selector for derivatives
            if (_isDerivativeExchange() && _lotSize > 1)
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Number of Lots',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppTheme.textSecondary,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      IconButton(
                        onPressed: _lots > 1 ? () => _updateQuantityFromLots(_lots - 1) : null,
                        icon: const Icon(Icons.remove_circle_outline),
                        color: AppTheme.lossRed,
                      ),
                      Expanded(
                        child: Container(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          decoration: BoxDecoration(
                            border: Border.all(color: AppTheme.borderColor),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            '$_lots Lot${_lots > 1 ? 's' : ''} = ${_lots * _lotSize} Qty',
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                  color: AppTheme.textPrimary,
                                  fontWeight: FontWeight.bold,
                                ),
                          ),
                        ),
                      ),
                      IconButton(
                        onPressed: () => _updateQuantityFromLots(_lots + 1),
                        icon: const Icon(Icons.add_circle_outline),
                        color: AppTheme.profitGreen,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                ],
              ),
            // Quantity (readonly for derivatives, editable for equity)
            TextField(
              controller: _quantityController,
              decoration: InputDecoration(
                labelText: _isDerivativeExchange() && _lotSize > 1 ? 'Quantity (Auto-calculated)' : 'Quantity',
                prefixIcon: const Icon(Icons.format_list_numbered),
              ),
              keyboardType: TextInputType.number,
              readOnly: _isDerivativeExchange() && _lotSize > 1,
              enabled: !(_isDerivativeExchange() && _lotSize > 1),
            ),
            const SizedBox(height: 16),
            // Price Type
            DropdownButtonFormField<String>(
              initialValue: _priceType,
              decoration: const InputDecoration(
                labelText: 'Order Type',
                prefixIcon: Icon(Icons.receipt),
              ),
              items: _priceTypes.map((type) {
                return DropdownMenuItem(
                  value: type,
                  child: Text(type),
                );
              }).toList(),
              onChanged: (value) {
                setState(() => _priceType = value!);
              },
            ),
            const SizedBox(height: 16),
            // Price (for LIMIT and SL orders)
            if (_priceType == 'LIMIT' || _priceType == 'SL')
              TextField(
                controller: _priceController,
                decoration: const InputDecoration(
                  labelText: 'Price',
                  prefixIcon: Icon(Icons.attach_money),
                ),
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
              ),
            if (_priceType == 'LIMIT' || _priceType == 'SL')
              const SizedBox(height: 16),
            // Trigger Price (for SL and SL-M orders)
            if (_priceType == 'SL' || _priceType == 'SL-M')
              TextField(
                controller: _triggerPriceController,
                decoration: const InputDecoration(
                  labelText: 'Trigger Price',
                  prefixIcon: Icon(Icons.gavel),
                ),
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
              ),
            if (_priceType == 'SL' || _priceType == 'SL-M')
              const SizedBox(height: 16),
            // Product
            DropdownButtonFormField<String>(
              initialValue: _product,
              decoration: const InputDecoration(
                labelText: 'Product',
                prefixIcon: Icon(Icons.category),
              ),
              items: _products.map((product) {
                return DropdownMenuItem(
                  value: product,
                  child: Text(product),
                );
              }).toList(),
              onChanged: (value) {
                setState(() => _product = value!);
              },
            ),
            const SizedBox(height: 24),
            // Place Order Button
            ElevatedButton(
              onPressed: _isPlacing ? null : _placeOrder,
              style: ElevatedButton.styleFrom(
                backgroundColor: _action == 'BUY'
                    ? AppTheme.profitGreen
                    : AppTheme.lossRed,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: _isPlacing
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : Text(
                      'Place ${_action.toUpperCase()} Order',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
            ),
            const SizedBox(height: 16),
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
                        size: 16,
                        color: AppTheme.accentBlue,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'Order Types',
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                              color: AppTheme.textPrimary,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'MARKET: Immediate execution at best price\n'
                    'LIMIT: Execute at specified price or better\n'
                    'SL: Stop Loss order with limit price\n'
                    'SL-M: Stop Loss Market order',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _quantityController.dispose();
    _priceController.dispose();
    _triggerPriceController.dispose();
    super.dispose();
  }
}
