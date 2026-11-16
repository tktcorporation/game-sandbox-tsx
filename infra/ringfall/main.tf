terraform {
  required_version = ">= 1.8.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

variable "cloudflare_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.cloudflare_account_id))
    error_message = "Use the real 32-character Cloudflare account ID."
  }
}

locals {
  ringfall = jsondecode(file("${path.module}/config.json"))
}

# D1 lifecycle only. cf/cloudflare.config.ts owns Worker versions,
# deployments, assets, and bindings. SQL is applied separately.
resource "cloudflare_d1_database" "ringfall" {
  account_id = var.cloudflare_account_id
  name       = local.ringfall.database_name

  lifecycle {
    prevent_destroy = true
  }
}

# Shared by PR Previews that receive this database's ID. A different D1 per PR
# requires separately managed resources and branch-specific ID delivery.
resource "cloudflare_d1_database" "ringfall_preview" {
  account_id = var.cloudflare_account_id
  name       = local.ringfall.preview_database_name

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = local.ringfall.preview_database_name != local.ringfall.database_name
      error_message = "Preview D1 must have a different name from production D1."
    }
  }
}

output "ringfall_database_id" {
  value = cloudflare_d1_database.ringfall.id
}

output "ringfall_preview_database_id" {
  value = cloudflare_d1_database.ringfall_preview.id
}
