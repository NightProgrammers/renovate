import { logger } from '../../../logger';
import { tgitApi } from './http';
import type { TGitMergeRequest, TGitMergeRequestReview } from './types';

export async function getMR(
  repository: string,
  id: number
): Promise<TGitMergeRequest> {
  logger.debug(`getMR(${id})`);

  const url = `projects/${repository}/merge_request/${id}`;
  const mr = (
    await tgitApi.getJson<TGitMergeRequest & { source_commit: string }>(url)
  ).body;
  mr.sha = mr.source_commit;

  const cr = await getMergeRequstReview(repository, id);
  mr.reviewers = cr.reviewers;
  if (mr.merge_status === 'can_be_merged' && cr.state !== 'approved') {
    mr.merge_status = cr.state;
  }

  return mr;
}

export async function updateMergeRequstReviewers(
  repository: string,
  id: number,
  newReviewIDs: number[]
): Promise<void> {
  logger.debug(`update mr reviews(${id})`);

  const url = `projects/${repository}/merge_request/${id}/review/invite`;
  await Promise.all(
    newReviewIDs.map(async (reviewID) => {
      await tgitApi.postJson<TGitMergeRequestReview>(url, {
        body: { reviewer_id: reviewID },
      });
    })
  );
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
