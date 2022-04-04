import { logger } from '../../../logger';
import { TGitHttp } from '../../../util/http/tgit';
import type { TGitUserStatus } from './types';

export const tgitApi = new TGitHttp();

export async function getUserID(username: string): Promise<number> {
  const url = `users/${username}`;
  return (await tgitApi.getJson<{ id: number }>(url)).body.id;
}

export async function isUserActive(user: string): Promise<boolean> {
  try {
    const url = `users/${user}`;
    const userStatus = (await tgitApi.getJson<TGitUserStatus>(url)).body;
    return userStatus.state === 'active';
  } catch (err) {
    logger.warn({ err }, 'Failed to get user status');
    return false;
  }
}
