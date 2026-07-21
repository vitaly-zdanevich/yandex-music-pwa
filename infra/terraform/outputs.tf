output "function_url" {
  description = "Direct streaming API URL. Set VITE_API_BASE_URL to this value without the trailing slash."
  value       = aws_lambda_function_url.proxy.function_url
}

output "web_build_command" {
  description = "Build command for a GitHub Pages deployment that calls this Function URL."
  value       = "VITE_API_BASE_URL=${trimsuffix(aws_lambda_function_url.proxy.function_url, "/")} VITE_BASE_PATH=/yandex-music-pwa/ npm run build"
}
