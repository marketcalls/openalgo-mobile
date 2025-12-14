import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../models/symbol_search.dart';
import '../models/quote.dart';
import '../services/openalgo_api_service.dart';
import '../utils/app_theme.dart';

class SearchSymbolScreen extends StatefulWidget {
  final ApiConfig config;

  const SearchSymbolScreen({super.key, required this.config});

  @override
  State<SearchSymbolScreen> createState() => _SearchSymbolScreenState();
}

class _SearchSymbolScreenState extends State<SearchSymbolScreen> {
  final _searchController = TextEditingController();
  late final OpenAlgoApiService _apiService;
  List<SymbolSearch> _searchResults = [];
  bool _isSearching = false;
  String? _selectedExchange;

  final List<String> _exchanges = [
    'NSE',
    'BSE',
    'NFO',
    'BFO',
    'MCX',
    'CDS',
    'NSE_INDEX',
    'BSE_INDEX',
  ];

  @override
  void initState() {
    super.initState();
    _apiService = OpenAlgoApiService(widget.config);
  }

  Future<void> _search(String query) async {
    if (query.length < 2) {
      setState(() => _searchResults = []);
      return;
    }

    setState(() => _isSearching = true);

    try {
      final results = await _apiService.searchSymbols(
        query,
        exchange: _selectedExchange,
      );
      setState(() {
        _searchResults = results;
        _isSearching = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() => _isSearching = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Search failed: $e'),
            backgroundColor: AppTheme.lossRed,
          ),
        );
      }
    }
  }

  void _selectSymbol(SymbolSearch symbol) {
    final watchlistItem = WatchlistItem(
      symbol: symbol.symbol,
      exchange: symbol.exchange,
    );
    Navigator.of(context).pop(watchlistItem);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Search Symbol'),
      ),
      body: Column(
        children: [
          Container(
            color: AppTheme.surfaceColor,
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                TextField(
                  controller: _searchController,
                  decoration: InputDecoration(
                    hintText: 'Search symbol (e.g., RELIANCE, NIFTY)',
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: _searchController.text.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear),
                            onPressed: () {
                              _searchController.clear();
                              setState(() => _searchResults = []);
                            },
                          )
                        : null,
                  ),
                  onChanged: _search,
                  textInputAction: TextInputAction.search,
                  onSubmitted: _search,
                ),
                const SizedBox(height: 12),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      FilterChip(
                        label: const Text('All'),
                        selected: _selectedExchange == null,
                        onSelected: (selected) {
                          setState(() {
                            _selectedExchange = null;
                          });
                          if (_searchController.text.length >= 2) {
                            _search(_searchController.text);
                          }
                        },
                      ),
                      const SizedBox(width: 8),
                      ..._exchanges.map((exchange) {
                        return Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: FilterChip(
                            label: Text(exchange),
                            selected: _selectedExchange == exchange,
                            onSelected: (selected) {
                              setState(() {
                                _selectedExchange = selected ? exchange : null;
                              });
                              if (_searchController.text.length >= 2) {
                                _search(_searchController.text);
                              }
                            },
                          ),
                        );
                      }),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: _isSearching
                ? const Center(child: CircularProgressIndicator())
                : _searchResults.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.search,
                              size: 64,
                              color: AppTheme.textSecondary,
                            ),
                            const SizedBox(height: 16),
                            Text(
                              _searchController.text.isEmpty
                                  ? 'Enter symbol to search'
                                  : 'No results found',
                              style: Theme.of(context)
                                  .textTheme
                                  .titleMedium
                                  ?.copyWith(
                                    color: AppTheme.textSecondary,
                                  ),
                            ),
                          ],
                        ),
                      )
                    : ListView.builder(
                        itemCount: _searchResults.length,
                        itemBuilder: (context, index) {
                          final symbol = _searchResults[index];
                          return _buildSearchResultItem(symbol);
                        },
                      ),
          ),
        ],
      ),
    );
  }

  Widget _buildSearchResultItem(SymbolSearch symbol) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: ListTile(
        title: Text(
          symbol.symbol,
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w600,
              ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 4),
            Text(
              symbol.name,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 2),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: AppTheme.accentBlue.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    symbol.exchange,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppTheme.accentBlue,
                          fontSize: 11,
                        ),
                  ),
                ),
                if (symbol.instrumentType.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Text(
                    symbol.instrumentType,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontSize: 11,
                        ),
                  ),
                ],
                if (symbol.lotSize > 1) ...[
                  const SizedBox(width: 8),
                  Text(
                    'Lot: ${symbol.lotSize}',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontSize: 11,
                        ),
                  ),
                ],
              ],
            ),
          ],
        ),
        trailing: const Icon(Icons.add_circle_outline),
        onTap: () => _selectSymbol(symbol),
      ),
    );
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }
}
