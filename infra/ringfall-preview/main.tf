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
  ringfall = jsondecode(file("${path.module}/../ringfall/config.json"))
}

# Independent root and state: never include the production D1 in a Preview plan.
# cf/cloudflare.config.ts owns Worker, DO, assets and deployment; SQL is separate.
# PR Previews receiving this ID share one D1. Per-PR D1 needs a separate design.
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

output "ringfall_preview_database_id" {
  value = cloudflare_d1_database.ringfall_preview.id
}
