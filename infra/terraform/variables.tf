variable "aws_region" {
  description = "AWS region for the Lambda and Parameter Store values."
  type        = string
}

variable "project_name" {
  description = "Name prefix for the proxy resources."
  type        = string
  default     = "yandex-music-pwa-proxy"
}

variable "lambda_zip_path" {
  description = "Path to the cargo-lambda ZIP containing the native bootstrap."
  type        = string
}

variable "allowed_origin" {
  description = "Exact PWA origin allowed by Function URL CORS (no path or trailing slash)."
  type        = string
  default     = "https://vitaly-zdanevich.github.io"

  validation {
    condition     = can(regex("^https://[^/]+$", var.allowed_origin)) || can(regex("^http://localhost(:[0-9]+)?$", var.allowed_origin))
    error_message = "allowed_origin must be one HTTPS origin (or localhost for development), without a path."
  }
}

variable "lambda_memory_size" {
  description = "Lambda memory in MB. 256 MB is a balance between network throughput and free-tier duration."
  type        = number
  default     = 256

  validation {
    condition     = var.lambda_memory_size >= 128 && var.lambda_memory_size <= 10240
    error_message = "lambda_memory_size must be between 128 and 10240."
  }
}

variable "lambda_timeout_seconds" {
  description = "Maximum time for a streamed media response."
  type        = number
  default     = 300
}

variable "reserved_concurrency" {
  description = "Small concurrency ceiling that limits accidental proxy fan-out."
  type        = number
  default     = 2

  validation {
    condition     = var.reserved_concurrency == -1 || (var.reserved_concurrency >= 1 && var.reserved_concurrency <= 1000)
    error_message = "reserved_concurrency must be -1 (unreserved) or between 1 and 1000."
  }
}

variable "file_info_signing_key" {
  description = "Server-side Yandex file-info HMAC key, encrypted in SSM and never included in the PWA."
  type        = string
  sensitive   = true
  default     = "7tvSmFbyf5hJnIHhCimDDD"
}

variable "budget_alert_email" {
  description = "Optional email for an AWS Budget alert. Empty disables budget creation. Alerts do not impose a hard cap."
  type        = string
  default     = ""
}
