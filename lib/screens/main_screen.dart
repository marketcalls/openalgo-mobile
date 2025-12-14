import 'package:flutter/material.dart';
import '../models/api_config.dart';
import '../utils/app_theme.dart';
import '../widgets/index_bar.dart';
import 'watchlist_screen.dart';
import 'orderbook_screen.dart';
import 'positions_screen.dart';
import 'tradebook_screen.dart';
import 'holdings_screen.dart';
import 'settings_screen.dart';

class MainScreen extends StatefulWidget {
  final ApiConfig config;

  const MainScreen({super.key, required this.config});

  @override
  State<MainScreen> createState() => _MainScreenState();
}

class _MainScreenState extends State<MainScreen> {
  int _selectedIndex = 0;

  late final List<Widget> _screens;

  @override
  void initState() {
    super.initState();
    _screens = [
      WatchlistScreen(config: widget.config),
      OrderbookScreen(config: widget.config),
      PositionsScreen(config: widget.config),
      TradebookScreen(config: widget.config),
      HoldingsScreen(config: widget.config),
      SettingsScreen(config: widget.config),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          IndexBar(config: widget.config),
          Expanded(child: _screens[_selectedIndex]),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: AppTheme.borderColor, width: 1),
          ),
        ),
        child: BottomNavigationBar(
          currentIndex: _selectedIndex,
          onTap: (index) => setState(() => _selectedIndex = index),
          items: const [
            BottomNavigationBarItem(
              icon: Icon(Icons.show_chart),
              label: 'Watchlist',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.receipt_long),
              label: 'Orders',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.account_balance_wallet),
              label: 'Positions',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.history),
              label: 'Trades',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.business_center),
              label: 'Holdings',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.settings),
              label: 'Settings',
            ),
          ],
        ),
      ),
    );
  }
}
