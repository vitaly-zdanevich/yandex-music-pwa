provider "aws" {
  region = var.aws_region
}

locals {
  parameter_prefix     = "/${var.project_name}"
  token_parameter_name = "${local.parameter_prefix}/yandex-token"
  token_parameter_arn  = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.token_parameter_name}"
  common_tags = {
    Project = var.project_name
    Managed = "terraform"
  }
}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_ssm_parameter" "signing_key" {
  name        = "${local.parameter_prefix}/file-info-signing-key"
  description = "Yandex file-info signing key used only by the Rust proxy."
  type        = "SecureString"
  tier        = "Standard"
  value       = var.file_info_signing_key
  tags        = local.common_tags
}

resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "parameters" {
  name = "${var.project_name}-parameters"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadProxySecrets"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          local.token_parameter_arn,
          aws_ssm_parameter.signing_key.arn,
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project_name}"
  retention_in_days = 1
  tags              = local.common_tags
}

resource "aws_lambda_function" "proxy" {
  function_name = var.project_name
  role          = aws_iam_role.lambda.arn
  filename      = var.lambda_zip_path

  source_code_hash = filebase64sha256(var.lambda_zip_path)
  runtime          = "provided.al2023"
  handler          = "bootstrap"
  architectures    = ["arm64"]

  memory_size                    = var.lambda_memory_size
  timeout                        = var.lambda_timeout_seconds
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      ALLOWED_ORIGIN           = var.allowed_origin
      TOKEN_PARAMETER          = local.token_parameter_name
      SIGNING_KEY_PARAMETER    = aws_ssm_parameter.signing_key.name
      SECRET_CACHE_TTL_SECONDS = "300"
      RUST_LOG                 = "yandex_music_proxy=info"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy_attachment.basic_execution,
    aws_iam_role_policy.parameters,
  ]

  tags = local.common_tags
}

resource "aws_lambda_function_url" "proxy" {
  function_name      = aws_lambda_function.proxy.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_lambda_permission" "function_url_public" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.proxy.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "function_url_invoke_function_public" {
  statement_id             = "AllowPublicFunctionInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.proxy.function_name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_alert_email == "" ? 0 : 1
  name         = "${var.project_name}-monthly"
  budget_type  = "COST"
  limit_amount = "1"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 10
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
