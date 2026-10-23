import type {
  AssistantStackPortKey,
  AssistantStackPorts,
  AssistantUiServiceCard,
} from './types/assistantStack';

export interface AssistantUiServiceDefinition {
  id: string;
  title: string;
  description: string;
  portKey: AssistantStackPortKey;
  /** Path appended to origin (e.g. `/webui/` for LightRAG). */
  path: string;
}

/**
 * Product-home cards that open in the system browser.
 * Order matches the Phase 2 plan (no Hermes Dashboard).
 */
export const ASSISTANT_UI_SERVICES: readonly AssistantUiServiceDefinition[] = [
  {
    id: 'hermes-webui',
    title: 'Hermes WebUI',
    description: 'Chat with Hermes in the browser.',
    portKey: 'webui',
    path: '/',
  },
  {
    id: 'searxng',
    title: 'SearXNG',
    description: 'Local meta-search used by the assistant stack.',
    portKey: 'searxng',
    path: '/',
  },
  {
    id: 'lightrag',
    title: 'LightRAG',
    description: 'Knowledge graph and RAG WebUI.',
    portKey: 'lightrag',
    path: '/webui/',
  },
  {
    id: 'neo4j',
    title: 'Neo4j',
    description: 'Graph database browser for LightRAG.',
    portKey: 'neo4jHttp',
    path: '/',
  },
  {
    id: 'gpt-researcher',
    title: 'GPT Researcher',
    description: 'Deep web research API and UI.',
    portKey: 'gptResearcher',
    path: '/',
  },
  {
    id: 'n8n',
    title: 'n8n',
    description: 'Workflow automation.',
    portKey: 'n8n',
    path: '/',
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    description: 'AI coding agent WebUI.',
    portKey: 'opencode',
    path: '/',
  },
] as const;

export function buildServiceUrl(
  ports: AssistantStackPorts,
  portKey: AssistantStackPortKey,
  path = '/'
): string {
  const port = ports[portKey];
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `http://127.0.0.1:${port}${normalizedPath === '/' ? '/' : normalizedPath}`;
}

export function buildAssistantUiServiceCards(
  ports: AssistantStackPorts
): AssistantUiServiceCard[] {
  return ASSISTANT_UI_SERVICES.map((service) => ({
    id: service.id,
    title: service.title,
    description: service.description,
    portKey: service.portKey,
    path: service.path,
    url: buildServiceUrl(ports, service.portKey, service.path),
  }));
}
