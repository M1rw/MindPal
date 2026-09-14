import { fetchJson } from './http.ts';
import type { MemorySummaryResponse, MemoryAtom } from '../../types/index.ts';

export const memoryApi = {
  async getMemorySummary(): Promise<MemorySummaryResponse> {
    return fetchJson<MemorySummaryResponse>('/api/memory/summary', undefined, 'Memory summary error');
  },

  async refreshMemorySummary(): Promise<MemorySummaryResponse> {
    return fetchJson<MemorySummaryResponse>('/api/memory/summary/refresh', { method: 'POST' }, 'Memory refresh error');
  },

  async getMemoryGraph(): Promise<{ atoms: MemoryAtom[] }> {
    return fetchJson<{ atoms: MemoryAtom[] }>('/api/memory/graph', undefined, 'Memory graph error');
  },

  async putMemoryGraph(graph: { atoms: MemoryAtom[] }): Promise<unknown> {
    return fetchJson<unknown>('/api/memory/graph', {
      method: 'PUT',
      body: JSON.stringify(graph),
    }, 'Update memory graph error');
  },

  async deleteMemoryGraphItem(atomId: string): Promise<unknown> {
    return fetchJson<unknown>(`/api/memory/graph/items/${encodeURIComponent(atomId)}`, {
      method: 'DELETE',
    }, 'Delete memory atom error');
  },
};
