data "aws_caller_identity" "current" {}

resource "aws_kms_key" "vault" {
  description             = "ReDDone envelope and artifact encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "vault" {
  name          = "alias/${var.name_prefix}-vault"
  target_key_id = aws_kms_key.vault.key_id
}

resource "aws_s3_bucket" "artifacts" {
  bucket = var.artifact_bucket_name
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.vault.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "clean-noncurrent-and-incomplete-artifacts"
    status = "Enabled"
    filter {
      prefix = "workspaces/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  rule {
    id     = "expire-static-preview-objects"
    status = "Enabled"
    filter {
      tag {
        key   = "reddone-retention"
        value = "preview-3d"
      }
    }
    expiration {
      days = 3
    }
  }
  rule {
    id     = "expire-raw-research-imports"
    status = "Enabled"
    filter {
      tag {
        key   = "reddone-retention"
        value = "research-30d"
      }
    }
    expiration {
      days = 30
    }
  }
}

resource "aws_iam_openid_connect_provider" "vercel" {
  url             = var.vercel_oidc_issuer
  client_id_list  = [var.vercel_oidc_audience]
  thumbprint_list = var.vercel_oidc_thumbprints
}

data "aws_iam_policy_document" "vercel_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.vercel.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(var.vercel_oidc_issuer, "https://", "")}:aud"
      values   = [var.vercel_oidc_audience]
    }
    condition {
      test     = "StringLike"
      variable = "${replace(var.vercel_oidc_issuer, "https://", "")}:sub"
      values   = [var.vercel_oidc_subject_pattern]
    }
  }
}

resource "aws_iam_role" "vercel_control_plane" {
  name               = "${var.name_prefix}-vercel-control-plane"
  assume_role_policy = data.aws_iam_policy_document.vercel_assume.json
}

data "aws_iam_policy_document" "vault_access" {
  statement {
    sid       = "EnvelopeEncryption"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.vault.arn]
  }
  statement {
    sid       = "ArtifactObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/workspaces/*"]
  }
  statement {
    sid       = "ArtifactListing"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["workspaces/*"]
    }
  }
}

resource "aws_iam_role_policy" "vault_access" {
  role   = aws_iam_role.vercel_control_plane.id
  policy = data.aws_iam_policy_document.vault_access.json
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.bucket.json
}
