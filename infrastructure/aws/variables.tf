variable "aws_region" {
  type        = string
  description = "AWS region used for the ReDDone artifact vault."
  default     = "ap-southeast-1"
}

variable "name_prefix" {
  type        = string
  description = "Prefix for private ReDDone resources."
  default     = "reddone"
}

variable "artifact_bucket_name" {
  type        = string
  description = "Globally unique private artifact bucket name."
}

variable "vercel_oidc_issuer" {
  type        = string
  description = "Exact Vercel OIDC issuer URL shown for the production team."
}

variable "vercel_oidc_audience" {
  type        = string
  description = "Exact production OIDC audience claim."
}

variable "vercel_oidc_subject_pattern" {
  type        = string
  description = "Narrow StringLike subject claim for the ReDDone production project/environment."
}

variable "vercel_oidc_thumbprints" {
  type        = list(string)
  description = "Current TLS CA thumbprints for the configured issuer; verify during provisioning."
  sensitive   = true
}
