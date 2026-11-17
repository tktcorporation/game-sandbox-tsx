# Preview-only encryption template. The passphrase must come from the approved
# external secret store at execution time; there is deliberately no default.
# No backend or authentication is configured in this repository.
variable "preview_state_passphrase" {
  type      = string
  sensitive = true

  validation {
    condition     = length(var.preview_state_passphrase) >= 32
    error_message = "Preview state encryption requires a passphrase of at least 32 characters."
  }
}

terraform {
  encryption {
    key_provider "pbkdf2" "ringfall_preview" {
      passphrase = var.preview_state_passphrase
    }

    method "aes_gcm" "ringfall_preview" {
      keys = key_provider.pbkdf2.ringfall_preview
    }

    state {
      method   = method.aes_gcm.ringfall_preview
      enforced = true
    }

    plan {
      method   = method.aes_gcm.ringfall_preview
      enforced = true
    }
  }
}
