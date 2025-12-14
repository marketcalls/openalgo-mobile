class ApiConfig {
  final String hostUrl;
  final String webSocketUrl;
  final String apiKey;

  ApiConfig({
    required this.hostUrl,
    required this.webSocketUrl,
    required this.apiKey,
  });

  Map<String, dynamic> toJson() => {
        'hostUrl': hostUrl,
        'webSocketUrl': webSocketUrl,
        'apiKey': apiKey,
      };

  factory ApiConfig.fromJson(Map<String, dynamic> json) => ApiConfig(
        hostUrl: json['hostUrl'] as String,
        webSocketUrl: json['webSocketUrl'] as String,
        apiKey: json['apiKey'] as String,
      );
}
