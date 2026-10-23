/** Deep link to a serverless endpoint in the RunPod web console. */
export function runpodConsoleUrl(endpointId: string): string {
  return `https://www.runpod.io/console/serverless/user/endpoint/${endpointId}`;
}
