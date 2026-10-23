terraform {
  required_version = ">= 1.5.0"

  required_providers {
    runpod = {
      source  = "decentralized-infrastructure/runpod"
      version = "~> 1.0"
    }
  }
}

provider "runpod" {
  api_key = var.runpod_api_key
}
