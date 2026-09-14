import { fetchJson, fetchBlob, expectOk } from './http.ts';
import type { UserProfile, UserInsightsResponse } from '../../types/index.ts';

export const usersApi = {
  async getUserMe(): Promise<unknown> {
    return fetchJson<unknown>('/api/user/me', undefined, 'User me error');
  },

  async getUserProfile(): Promise<UserProfile> {
    return fetchJson<UserProfile>('/api/user/profile', undefined, 'Profile error');
  },

  async patchUserProfile(data: Partial<UserProfile>): Promise<UserProfile> {
    return fetchJson<UserProfile>('/api/user/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, 'Patch profile error');
  },

  async getUserInsights(): Promise<UserInsightsResponse> {
    return fetchJson<UserInsightsResponse>('/api/user/insights', undefined, 'User insights error');
  },

  async exportUserData(): Promise<Blob> {
    return fetchBlob('/api/user/export', undefined, 'Export error');
  },

  async deleteUserData(): Promise<void> {
    await expectOk('/api/user/data', { method: 'DELETE' }, 'Delete user data error');
  },
};
