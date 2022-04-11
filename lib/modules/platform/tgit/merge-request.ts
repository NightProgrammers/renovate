import { logger } from '../../../logger';
import { tgitApi } from './http';
import type {
  TGitMergeRequest,
  TGitMergeRequestReview,
  UpdateMergeRequest,
} from './types';

export async function getMR(
  repository: string,
  id: number
): Promise<TGitMergeRequest> {
  logger.debug(`getMR(${id})`);

  const url = `projects/${repository}/merge_request/${id}`;
  const mr = (
    await tgitApi.getJson<TGitMergeRequest & { source_commit: string }>(url)
  ).body;
  mr.sha = mr.source_branch;

  const cr = await getMergeRequstReview(repository, id);
  mr.reviewers = cr.reviewers;
  if (mr.merge_status === 'can_be_merged' && cr.state !== 'approved') {
    mr.merge_status = cr.state;
  }

  return mr;
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

async function getMergeRequstReview(
  repository: string,
  id: number
): Promise<TGitMergeRequestReview> {
  logger.debug(`getReview(${id})`);

  const url = `projects/${repository}/merge_request/${id}/review`;
  const res = await tgitApi.getJson<TGitMergeRequestReview>(url);

  return res.body;
}
