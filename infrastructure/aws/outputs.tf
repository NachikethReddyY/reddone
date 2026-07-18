output "aws_region" {
  value = var.aws_region
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.vault.arn
}

output "vercel_role_arn" {
  value = aws_iam_role.vercel_control_plane.arn
}
