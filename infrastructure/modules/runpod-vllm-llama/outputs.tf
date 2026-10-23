output "endpoint_id" {
  description = "RunPod serverless endpoint ID."
  value       = runpod_endpoint.vllm.id
}

output "endpoint_name" {
  description = "Endpoint display name."
  value       = runpod_endpoint.vllm.name
}

output "model_id" {
  description = "Model configured on the RunPod template."
  value       = "meta-llama/Llama-3.3-70B-Instruct"
}

output "openai_base_url" {
  description = "OpenAI-compatible API base URL for this endpoint."
  value       = "https://api.runpod.ai/v2/${runpod_endpoint.vllm.id}/openai/v1"
}
