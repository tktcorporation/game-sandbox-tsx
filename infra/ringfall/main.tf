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

# D1 lifecycle only. Wrangler owns Worker versions, deployments, and all bindings.
resource "cloudflare_d1_database" "ringfall" {
  account_id = var.cloudflare_account_id
  name       = local.ringfall.database_name

  lifecycle {
    prevent_destroy = true
  }
}

output "ringfall_database_id" {
  value = cloudflare_d1_database.ringfall.id
}
