import 'package:flutter/material.dart';
import '../utils/app_theme.dart';

class ModeIndicator extends StatelessWidget {
  final bool isAnalyzeMode;

  const ModeIndicator({
    super.key,
    required this.isAnalyzeMode,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: isAnalyzeMode
            ? AppTheme.accentBlue.withValues(alpha: 0.2)
            : AppTheme.profitGreen.withValues(alpha: 0.2),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isAnalyzeMode ? AppTheme.accentBlue : AppTheme.profitGreen,
          width: 1.5,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            isAnalyzeMode ? Icons.science : Icons.flash_on,
            size: 14,
            color: isAnalyzeMode ? AppTheme.accentBlue : AppTheme.profitGreen,
          ),
          const SizedBox(width: 6),
          Text(
            isAnalyzeMode ? 'ANALYZE' : 'LIVE',
            style: TextStyle(
              color: isAnalyzeMode ? AppTheme.accentBlue : AppTheme.profitGreen,
              fontSize: 11,
              fontWeight: FontWeight.bold,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }
}
