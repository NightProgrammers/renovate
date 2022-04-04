import { logger } from '../../../logger';
import { tgitApi } from './http';
import type { TGitMergeRequest, UpdateMergeRequest } from './types';

export async function getMR(
  repository: string,
  id: number
): Promise<TGitMergeRequest> {
  logger.debug(`getMR(${id})`);

  const url = `projects/${repository}/merge_request/${id}`;
  return (await tgitApi.getJson<TGitMergeRequest>(url)).body;
}

export async function updateMR(
  repository: string,
  id: number,
  data: UpdateMergeRequest
): Promise<void> {
  logger.debug(`updateMR(${id})`);

  const url = `projects/${repository}/merge_request/${id}`;
  await tgitApi.putJson(url, {
    body: data,
  });
}
