variable "runpod_api_key" {
  type        = string
  description = "RunPod API key."
  sensitive   = true
}

variable "endpoint_name" {
  type        = string
  description = "Display name for the serverless endpoint."
}

variable "template_id" {
  type        = string
  description = "RunPod serverless template ID (vLLM)."
}

variable "data_center_ids" {
  type        = string
  description = "Comma-separated RunPod data center IDs."
  default     = "US-CA-2"
}

variable "gpu_type_ids" {
  type        = string
  description = "Comma-separated GPU type names."
  default     = "NVIDIA A100 80GB PCIe"
}

variable "gpu_count" {
  type        = number
  description = "GPUs per serverless worker (use 2 for 70B tensor parallel)."
  default     = 2
}

variable "workers_max" {
  type        = number
  description = "Maximum workers."
  default     = 3
}

variable "idle_timeout" {
  type        = number
  description = "Idle scale-down timeout in seconds."
  default     = 60
}

variable "flashboot" {
  type        = bool
  description = "Enable flash boot."
  default     = true
}

locals {
  data_center_list = [for s in split(",", var.data_center_ids) : trimspace(s) if trimspace(s) != ""]
  gpu_type_list    = [for s in split(",", var.gpu_type_ids) : trimspace(s) if trimspace(s) != ""]
}
