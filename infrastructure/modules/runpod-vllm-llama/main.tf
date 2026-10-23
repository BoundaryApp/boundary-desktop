resource "runpod_endpoint" "vllm" {
  name            = var.endpoint_name
  template_id     = var.template_id
  data_center_ids = local.data_center_list
  gpu_type_ids    = local.gpu_type_list
  gpu_count       = var.gpu_count
  workers_max     = var.workers_max
  idle_timeout    = var.idle_timeout
  flashboot       = var.flashboot

  # RunPod read API returns "" for compute_type; provider v1.0.1 errors if plan is
  # "GPU" but state is "". Empty string matches API and omitempty skips on create.
  compute_type = ""
}
