import { ApiError, fetchJson } from './http.ts';
import { useSessionStore } from '../../store/index.ts';
import type { MemorySummaryResponse, MemoryAtom } from '../../types/index.ts';
import { honestMemorySummary, summaryFromAtoms } from '../../utils/memory/memory.ts';
import {
  clearGuestGraph,
  deleteGuestAtom,
  loadGuestGraph,
  mergeAtomLists,
  updateGuestAtom,
} from '../../utils/memory/guestMemory.ts';

function toSummary(data: Partial<MemorySummaryResponse>): MemorySummaryResponse {
  return {
    summary: honestMemorySummary(data.summary),
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
    language: typeof data.language === 'string' ? data.language : '',
    atoms_count: typeof data.atoms_count === 'number' ? data.atoms_count : 0,
  };
}

function signedIn(): boolean {
  return useSessionStore.getState().isAuthenticated;
}

function asAtoms(data: { atoms?: Array<MemoryAtom & { category?: string }> }): MemoryAtom[] {
  return (data.atoms ?? []).map((atom) => ({
    id: atom.id,
    type: atom.type || atom.category || 'facts',
    value: atom.value,
    normalized_value: atom.normalized_value,
    confidence: atom.confidence,
    created_at: atom.created_at || '',
    updated_at: atom.updated_at,
  }));
}

async function fetchAccountGraph(): Promise<{ atoms: MemoryAtom[] }> {
  const data = await fetchJson<{ atoms?: Array<MemoryAtom & { category?: string }> }>(
    '/api/memory/graph',
    undefined,
    'Memory graph error',
  );
  return { atoms: asAtoms(data) };
}

export const memoryApi = {
  async getMemorySummary(): Promise<MemorySummaryResponse> {
    if (!signedIn()) {
      const local = loadGuestGraph();
      return toSummary({ summary: summaryFromAtoms(local.atoms), atoms_count: local.atoms.length });
    }
    try {
      await memoryApi.mergeGuestGraphIntoAccount();
    } catch {
      // Keep the account summary; leftover device atoms still surface in the inspector.
    }
    const data = await fetchJson<Partial<MemorySummaryResponse>>(
      '/api/memory/summary',
      undefined,
      'Memory summary error',
    );
    return toSummary(data);
  },

  async refreshMemorySummary(): Promise<MemorySummaryResponse> {
    const data = await fetchJson<Partial<MemorySummaryResponse>>(
      '/api/memory/summary/refresh',
      { method: 'POST' },
      'Memory refresh error',
    );
    return toSummary(data);
  },

  async getMemoryGraph(): Promise<{ atoms: MemoryAtom[] }> {
    if (!signedIn()) {
      return { atoms: loadGuestGraph().atoms };
    }
    try {
      await memoryApi.mergeGuestGraphIntoAccount();
      return fetchAccountGraph();
    } catch {
      const leftover = loadGuestGraph();
      const remote = await fetchAccountGraph();
      return { atoms: mergeAtomLists(remote.atoms, leftover.atoms) };
    }
  },

  async putMemoryGraph(graph: { atoms: MemoryAtom[] }): Promise<unknown> {
    return fetchJson<unknown>('/api/memory/graph', {
      method: 'PUT',
      body: JSON.stringify({
        atoms: graph.atoms.map((atom) => ({
          id: atom.id,
          category: atom.type,
          type: atom.type,
          value: atom.value,
          confidence: atom.confidence,
        })),
      }),
    }, 'Update memory graph error');
  },

  async patchMemoryGraphItem(atomId: string, value: string): Promise<MemoryAtom> {
    const text = value.trim();
    if (!text) {
      throw new Error('Memory text cannot be empty.');
    }
    if (!signedIn()) {
      const updated = updateGuestAtom(atomId, text);
      if (!updated) {
        throw new Error('Could not update that memory item.');
      }
      return updated;
    }
    try {
      const data = await fetchJson<{ atoms?: Array<MemoryAtom & { category?: string }> }>(
        `/api/memory/graph/items/${encodeURIComponent(atomId)}`,
        { method: 'PATCH', body: JSON.stringify({ value: text }) },
        'Update memory atom error',
      );
      const found = asAtoms(data).find((atom) => atom.id === atomId);
      if (!found) {
        throw new Error('Could not update that memory item.');
      }
      updateGuestAtom(atomId, found.value);
      return found;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        const leftover = updateGuestAtom(atomId, text);
        if (leftover) return leftover;
      }
      throw err;
    }
  },

  async deleteMemoryGraphItem(atomId: string): Promise<unknown> {
    if (!signedIn()) {
      deleteGuestAtom(atomId);
      return {};
    }
    const result = await fetchJson<unknown>(`/api/memory/graph/items/${encodeURIComponent(atomId)}`, {
      method: 'DELETE',
    }, 'Delete memory atom error');
    deleteGuestAtom(atomId);
    return result;
  },

  async mergeGuestGraphIntoAccount(): Promise<void> {
    if (!signedIn()) return;
    const leftover = loadGuestGraph();
    if (leftover.atoms.length === 0) return;
    const remote = await fetchAccountGraph();
    const merged = mergeAtomLists(remote.atoms, leftover.atoms);
    await memoryApi.putMemoryGraph({ atoms: merged });
    clearGuestGraph();
  },
};
