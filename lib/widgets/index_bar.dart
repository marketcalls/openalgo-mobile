import 'package:flutter/material.dart';
import 'dart:async';
import '../models/api_config.dart';
import '../models/quote.dart';
import '../models/index_config.dart';
import '../services/openalgo_api_service.dart';
import '../services/storage_service.dart';
import '../utils/app_theme.dart';

class IndexBar extends StatefulWidget {
  final ApiConfig config;

  const IndexBar({super.key, required this.config});

  @override
  State<IndexBar> createState() => _IndexBarState();
}

class _IndexBarState extends State<IndexBar> with SingleTickerProviderStateMixin {
  late final OpenAlgoApiService _apiService;
  final _storageService = StorageService();
  
  // Dynamic index quotes storage
  Map<String, Quote?> _indexQuotes = {};
  List<String> _selectedIndices = [];
  
  Map<String, dynamic>? _funds;
  Timer? _refreshTimer;
  bool _isExpanded = false;
  late AnimationController _animationController;
  late Animation<double> _expandAnimation;

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
    _animationController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
    );
    _expandAnimation = CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeInOut,
    );
    _loadConfiguration();
  }

  Future<void> _loadConfiguration() async {
    // Load selected indices from storage
    final indices = await _storageService.getSelectedIndices();
    setState(() {
      _selectedIndices = indices;
      // Initialize quote storage for selected indices
      for (final index in _selectedIndices) {
        _indexQuotes[index] = null;
      }
    });
    
    // Fetch data
    _fetchIndexQuotes();
    _fetchFunds();
    _startAutoRefresh();
  }

  void _startAutoRefresh() {
    _refreshTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      _fetchIndexQuotes();
      _fetchFunds();
    });
  }

  Future<void> _fetchIndexQuotes() async {
    if (_selectedIndices.isEmpty) return;
    
    for (final indexName in _selectedIndices) {
      try {
        final indexSymbol = SupportedIndices.getByName(indexName);
        if (indexSymbol != null) {
          final quote = await _apiService.getQuote(
            indexSymbol.symbol,
            indexSymbol.exchange,
          );
          
          if (mounted) {
            setState(() {
              _indexQuotes[indexName] = quote;
            });
          }
        }
      } catch (e) {
        // Silently fail for individual index - don't disrupt user experience
      }
    }
  }

  Future<void> _fetchFunds() async {
    try {
      final funds = await _apiService.getFunds();
      if (mounted) {
        setState(() {
          _funds = funds;
        });
      }
    } catch (e) {
      // Silently fail
    }
  }

  void _toggleExpanded() {
    setState(() {
      _isExpanded = !_isExpanded;
      if (_isExpanded) {
        _animationController.forward();
      } else {
        _animationController.reverse();
      }
    });
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _animationController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_selectedIndices.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Compact header with indices and funds
        _buildCompactHeader(),
        // Expandable detailed view
        SizeTransition(
          sizeFactor: _expandAnimation,
          child: _buildExpandedView(),
        ),
      ],
    );
  }

  Widget _buildCompactHeader() {
    final availableCash = _funds?['availablecash']?.toString() ?? '0';
    final parsedCash = double.tryParse(availableCash) ?? 0.0;

    return Container(
      height: 36,
      decoration: BoxDecoration(
        color: AppTheme.cardColor,
        border: Border(
          bottom: BorderSide(color: AppTheme.borderColor, width: 1),
        ),
      ),
      child: Row(
        children: [
          // Expand/Collapse button
          InkWell(
            onTap: _toggleExpanded,
            child: Container(
              width: 36,
              height: 36,
              child: Center(
                child: AnimatedRotation(
                  turns: _isExpanded ? 0.5 : 0,
                  duration: const Duration(milliseconds: 200),
                  child: const Icon(
                    Icons.keyboard_arrow_down,
                    color: AppTheme.textSecondary,
                    size: 20,
                  ),
                ),
              ),
            ),
          ),
          // Dynamic indices
          ..._buildCompactIndices(),
          // Divider
          Container(
            width: 1,
            height: 24,
            color: AppTheme.borderColor,
          ),
          // Available Funds
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.account_balance_wallet,
                    color: AppTheme.textSecondary,
                    size: 11,
                  ),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      '₹${_formatAmount(parsedCash)}',
                      style: const TextStyle(
                        color: AppTheme.textPrimary,
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildCompactIndices() {
    final List<Widget> widgets = [];
    
    for (int i = 0; i < _selectedIndices.length; i++) {
      final indexName = _selectedIndices[i];
      final indexSymbol = SupportedIndices.getByName(indexName);
      
      if (indexSymbol != null) {
        widgets.add(
          Expanded(
            child: _buildCompactIndexItem(
              indexSymbol.displayName,
              _indexQuotes[indexName],
            ),
          ),
        );
        
        // Add divider between indices (but not after the last one)
        if (i < _selectedIndices.length - 1) {
          widgets.add(
            Container(
              width: 1,
              height: 24,
              color: AppTheme.borderColor,
            ),
          );
        }
      }
    }
    
    return widgets;
  }

  Widget _buildCompactIndexItem(String displayName, Quote? quote) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Flexible(
            child: Text(
              displayName,
              style: const TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 10,
                fontWeight: FontWeight.w600,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 4),
          if (quote != null) ...[
            Text(
              quote.ltp.toStringAsFixed(0),
              style: const TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 11,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(width: 2),
            Text(
              '${quote.change >= 0 ? '+' : ''}${quote.changePercent.toStringAsFixed(1)}%',
              style: TextStyle(
                color: AppTheme.getPnlColor(quote.change),
                fontSize: 9,
                fontWeight: FontWeight.w600,
              ),
            ),
          ] else
            const SizedBox(
              width: 10,
              height: 10,
              child: CircularProgressIndicator(strokeWidth: 1.5),
            ),
        ],
      ),
    );
  }

  Widget _buildExpandedView() {
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardColor,
        border: Border(
          bottom: BorderSide(color: AppTheme.borderColor, width: 1),
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Column(
        children: [
          // Detailed Index Information
          _buildDetailedIndices(),
          const SizedBox(height: 12),
          // Detailed Funds Information
          _buildFundsDetails(),
        ],
      ),
    );
  }

  Widget _buildDetailedIndices() {
    if (_selectedIndices.isEmpty) {
      return const SizedBox.shrink();
    }

    // Build grid of index cards (2 per row)
    final List<Widget> rows = [];
    for (int i = 0; i < _selectedIndices.length; i += 2) {
      final indices = _selectedIndices.skip(i).take(2).toList();
      
      rows.add(
        Row(
          children: [
            for (int j = 0; j < indices.length; j++) ...[
              Expanded(
                child: _buildDetailedIndexCard(
                  indices[j],
                  _indexQuotes[indices[j]],
                ),
              ),
              if (j < indices.length - 1) const SizedBox(width: 8),
            ],
            // Add empty space if odd number of indices
            if (indices.length == 1) const Expanded(child: SizedBox()),
          ],
        ),
      );
      
      if (i + 2 < _selectedIndices.length) {
        rows.add(const SizedBox(height: 8));
      }
    }

    return Column(children: rows);
  }

  Widget _buildDetailedIndexCard(String indexName, Quote? quote) {
    final indexSymbol = SupportedIndices.getByName(indexName);
    if (indexSymbol == null) return const SizedBox.shrink();

    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppTheme.backgroundColor,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            indexSymbol.displayName,
            style: const TextStyle(
              color: AppTheme.textSecondary,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          if (quote != null) ...[
            Text(
              quote.ltp.toStringAsFixed(2),
              style: const TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppTheme.getPnlColor(quote.change).withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(3),
                  ),
                  child: Text(
                    '${quote.change >= 0 ? '+' : ''}${quote.change.toStringAsFixed(2)} (${quote.changePercent.toStringAsFixed(2)}%)',
                    style: TextStyle(
                      color: AppTheme.getPnlColor(quote.change),
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            _buildQuoteDetail('Open', quote.open),
            _buildQuoteDetail('High', quote.high),
            _buildQuoteDetail('Low', quote.low),
            _buildQuoteDetail('Prev Close', quote.prevClose),
          ] else
            const Center(
              child: Padding(
                padding: EdgeInsets.all(8.0),
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildQuoteDetail(String label, double value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: const TextStyle(
              color: AppTheme.textSecondary,
              fontSize: 10,
            ),
          ),
          Text(
            value.toStringAsFixed(2),
            style: const TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 10,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildFundsDetails() {
    if (_funds == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(8.0),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    final availableCash = double.tryParse(_funds!['availablecash']?.toString() ?? '0') ?? 0.0;
    final usedMargin = double.tryParse(_funds!['usedmargin']?.toString() ?? '0') ?? 0.0;
    final m2mRealized = double.tryParse(_funds!['m2munrealized']?.toString() ?? '0') ?? 0.0;
    final m2mUnrealized = double.tryParse(_funds!['m2mrealized']?.toString() ?? '0') ?? 0.0;

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppTheme.backgroundColor,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Account Funds',
            style: TextStyle(
              color: AppTheme.textSecondary,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: _buildFundItem('Available Cash', availableCash, AppTheme.profitGreen),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildFundItem('Used Margin', usedMargin, AppTheme.textPrimary),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: _buildFundItem('M2M Realized', m2mRealized, AppTheme.getPnlColor(m2mRealized)),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _buildFundItem('M2M Unrealized', m2mUnrealized, AppTheme.getPnlColor(m2mUnrealized)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildFundItem(String label, double value, Color valueColor) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: AppTheme.textSecondary,
            fontSize: 9,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          '₹${_formatAmount(value)}',
          style: TextStyle(
            color: valueColor,
            fontSize: 12,
            fontWeight: FontWeight.bold,
          ),
        ),
      ],
    );
  }

  String _formatAmount(double amount) {
    if (amount.abs() >= 10000000) {
      return '${(amount / 10000000).toStringAsFixed(2)}Cr';
    } else if (amount.abs() >= 100000) {
      return '${(amount / 100000).toStringAsFixed(2)}L';
    } else if (amount.abs() >= 1000) {
      return '${(amount / 1000).toStringAsFixed(2)}K';
    }
    return amount.toStringAsFixed(2);
  }
}
