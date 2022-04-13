import URL from 'url';
import is from '@sindresorhus/is';
import delay from 'delay';
import JSON5 from 'json5';
import semver from 'semver';
import type { MergeStrategy } from '../../../config/types';
import { PlatformId } from '../../../constants';
import {
  CONFIG_GIT_URL_UNAVAILABLE,
  PLATFORM_AUTHENTICATION_ERROR,
  REPOSITORY_ACCESS_FORBIDDEN,
  REPOSITORY_ARCHIVED,
  REPOSITORY_CHANGED,
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
  REPOSITORY_NOT_FOUND,
  TEMPORARY_ERROR,
} from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { BranchStatus, PrState, VulnerabilityAlert } from '../../../types';
import * as git from '../../../util/git';
import * as hostRules from '../../../util/host-rules';
import { setBaseUrl } from '../../../util/http/tgit';
import type { HttpResponse } from '../../../util/http/types';
import { regEx } from '../../../util/regex';
import { sanitize } from '../../../util/sanitize';
import { ensureTrailingSlash, getQueryString } from '../../../util/url';
import type {
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueConfig,
  FindPRConfig,
  GitUrlOption,
  Issue,
  PlatformParams,
  PlatformPrOptions,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types';
import { smartTruncate } from '../utils/pr-body';
import { getUserID, isUserActive, tgitApi } from './http';
import { getMR, updateMergeRequstReviewers } from './merge-request';
import type {
  MergeMethod,
  RepoResponse,
  TGitComment,
  TGitIssue,
  TGitMergeRequest,
} from './types';

let config: {
  repository: string;
  email: string;
  prList: any[];
  issueList: TGitIssue[];
  mergeMethod: MergeMethod;
  defaultBranch: string;
  cloneSubmodules: boolean;
  ignorePrAuthor: boolean;
  squash: boolean;
} = {} as any;

const defaults = {
  hostType: PlatformId.TGit,
  endpoint: 'https://git.code.tencent.com/api/v3/',
  version: '0.0.0',
};

const DRAFT_PREFIX = '[WIP] ';
const NOT_FORKED_PATTERN = 'Forked Project not found';

export async function initPlatform({
  endpoint,
  token,
  gitAuthor,
}: PlatformParams): Promise<PlatformResult> {
  if (!token) {
    throw new Error(
      'Init: You must configure a Tencent Git personal access token'
    );
  }
  if (endpoint) {
    defaults.endpoint = ensureTrailingSlash(endpoint);
    setBaseUrl(defaults.endpoint);
  } else {
    logger.debug('Using default Tencent Git endpoint: ' + defaults.endpoint);
  }
  const platformConfig: PlatformResult = {
    endpoint: defaults.endpoint,
  };
  try {
    if (!gitAuthor) {
      const user = (
        await tgitApi.getJson<{ email: string; name: string; id: number }>(
          `user`,
          { token }
        )
      ).body;
      platformConfig.gitAuthor = `${user.name} <${user.email}>`;
    }
  } catch (err) {
    logger.error(
      { err },
      'Error authenticating with Tencent Git. Check that your token includes "api" permissions'
    );
    throw new Error('Init: Authentication failure');
  }

  return platformConfig;
}

// Get all repositories that the user has access to
export async function getRepos(): Promise<string[]> {
  logger.debug('Autodiscovering Tencent Git repositories');
  try {
    const url = `projects/accessable?per_page=100`;
    const res = await tgitApi.getJson<RepoResponse[]>(url, {
      paginate: true,
    });
    logger.debug(`Discovered ${res.body.length} project(s)`);
    return res.body
      .filter((repo) => !repo.archived)
      .map((repo) => repo.path_with_namespace);
  } catch (err) {
    logger.error({ err }, `Tencent Git getRepos error`);
    throw err;
  }
}

function urlEscape(str: string): string {
  return str ? str.replace(regEx(/\//g), '%2F') : str;
}

export async function getRawFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string
): Promise<string | null> {
  const escapedFileName = urlEscape(fileName);
  const repo = urlEscape(repoName ?? config.repository);
  //  /api/v3/projects/:id/repository/blobs/:sha
  const url = `projects/${repo}/repository/blobs/${
    branchOrTag || 'HEAD'
  }?file_path=${escapedFileName}`;
  const res = await tgitApi.get(url);
  return res.body;
}

export async function getJsonFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string
): Promise<any | null> {
  const raw = await getRawFile(fileName, repoName, branchOrTag);
  if (fileName.endsWith('.json5')) {
    return JSON5.parse(raw);
  }
  return JSON.parse(raw);
}

function getRepoUrl(
  repository: string,
  gitUrl: GitUrlOption | undefined,
  res: HttpResponse<RepoResponse & { https_url_to_repo?: string }>
): string {
  if (gitUrl === 'ssh') {
    if (!res.body.ssh_url_to_repo) {
      throw new Error(CONFIG_GIT_URL_UNAVAILABLE);
    }
    logger.debug({ url: res.body.ssh_url_to_repo }, `using ssh URL`);
    return res.body.ssh_url_to_repo;
  }

  const opts = hostRules.find({
    hostType: defaults.hostType,
    url: defaults.endpoint,
  });

  // prefer using https URL, if empty using http url.
  const repoURL = res.body.https_url_to_repo ?? res.body.http_url_to_repo;
  if (repoURL) {
    logger.debug({ url: repoURL }, `using http/https URL`);
    const repoU = URL.parse(`${repoURL}`);
    repoU.auth = 'private:' + opts.token;
    return URL.format(repoU);
  }

  return null;
}

// Initialize TGit by getting base branch
export async function initRepo({
  repository,
  cloneSubmodules,
  ignorePrAuthor,
  gitUrl,
}: RepoParams): Promise<RepoResult> {
  config = {} as any;
  config.repository = urlEscape(repository);
  config.cloneSubmodules = cloneSubmodules;
  config.ignorePrAuthor = ignorePrAuthor;

  let res: HttpResponse<RepoResponse>;
  try {
    res = await tgitApi.getJson<RepoResponse>(`projects/${config.repository}`);
    if (res.body.archived) {
      logger.debug(
        'Repository is archived - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_ARCHIVED);
    }
    if (res.body.default_branch === null || res.body.template_repository) {
      throw new Error(REPOSITORY_EMPTY);
    }
    if (res.body.merge_requests_enabled === false) {
      logger.debug(
        'MRs are disabled for the project - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_DISABLED);
    }
    config.defaultBranch = res.body.default_branch;
    // istanbul ignore if
    if (!config.defaultBranch) {
      logger.warn({ resBody: res.body }, 'Error fetching TGit project');
      throw new Error(TEMPORARY_ERROR);
    }
    config.mergeMethod = res.body.merge_method || 'merge';
    logger.debug(`${repository} default branch = ${config.defaultBranch}`);
    delete config.prList;
    logger.debug('Enabling Git FS');
    const url = getRepoUrl(repository, gitUrl, res);
    await git.initRepo({
      ...config,
      url,
    });
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err }, 'Caught initRepo error');
    if (err.message.includes('HEAD is not a symbolic ref')) {
      throw new Error(REPOSITORY_EMPTY);
    }
    if ([REPOSITORY_ARCHIVED, REPOSITORY_EMPTY].includes(err.message)) {
      throw err;
    }
    if (err.statusCode === 403) {
      throw new Error(REPOSITORY_ACCESS_FORBIDDEN);
    }
    if (err.statusCode === 404) {
      throw new Error(REPOSITORY_NOT_FOUND);
    }
    if (err.message === REPOSITORY_DISABLED) {
      throw err;
    }
    logger.debug({ err }, 'Unknown TGit initRepo error');
    throw err;
  }
  const repoConfig: RepoResult = {
    defaultBranch: config.defaultBranch,
    isFork: res.body.forked_from_project !== NOT_FORKED_PATTERN,
  };
  return repoConfig;
}

export function getRepoForceRebase(): Promise<boolean> {
  return Promise.resolve(config?.mergeMethod !== 'merge');
}

type BranchState = 'pending' | 'success' | 'error' | 'failure';

interface TGitBranchStatus {
  state: BranchState;
  name: string;
  allow_failure?: boolean;
  target_url?: string;
  updated_at?: string;
}

async function getStatus(
  branchName: string,
  useCache = true
): Promise<TGitBranchStatus[]> {
  const branchSha = git.getBranchCommit(branchName);
  try {
    const url = `projects/${config.repository}/commits/${branchSha}/statuses`;

    return (
      await tgitApi.getJson<TGitBranchStatus[]>(url, {
        paginate: true,
        useCache,
      })
    ).body;
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err }, 'Error getting commit status');
    if (err.response?.statusCode === 404) {
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
}

const tgitToRenovateStatusMapping: Record<BranchState, BranchStatus> = {
  pending: BranchStatus.yellow,
  success: BranchStatus.green,
  failure: BranchStatus.red,
  error: BranchStatus.red,
};

// Returns the combined status for a branch.
export async function getBranchStatus(
  branchName: string
): Promise<BranchStatus> {
  logger.debug(`getBranchStatus(${branchName})`);

  if (!git.branchExists(branchName)) {
    throw new Error(REPOSITORY_CHANGED);
  }

  const branchStatuses = await getStatus(branchName);
  // istanbul ignore if
  if (!is.array(branchStatuses)) {
    logger.warn(
      { branchName, branchStatuses },
      'Empty or unexpected branch statuses'
    );
    return BranchStatus.yellow;
  }
  logger.debug(`Got res with ${branchStatuses.length} results`);
  if (branchStatuses.length === 0) {
    // Return 'pending' if we have no status checks
    return BranchStatus.yellow;
  }

  return computeBranchStatus(branchStatuses);
}

function computeBranchStatus(branchStatuses: TGitBranchStatus[]): BranchStatus {
  // default to green.
  let status: BranchStatus = BranchStatus.green;

  uniqTGitBranchStatus(branchStatuses)
    .filter((check) => !check.allow_failure)
    .forEach((check) => {
      if (status !== BranchStatus.red) {
        // if red, stay red
        let mappedStatus: BranchStatus =
          tgitToRenovateStatusMapping[check.state];
        if (!mappedStatus) {
          logger.warn(
            { check },
            'Could not map TGIT check.status to Renovate status'
          );
          mappedStatus = BranchStatus.yellow;
        }
        if (mappedStatus !== BranchStatus.green) {
          logger.trace({ check }, 'Found non-green check');
          status = mappedStatus;
        }
      }
    });

  return status;
}

function uniqTGitBranchStatus(
  branchStatuses: TGitBranchStatus[]
): TGitBranchStatus[] {
  const ret: TGitBranchStatus[] = [];

  // pipeline url => TGitBranchStatus for uniq with latest updated.
  const pipelineUrls: { [key: string]: TGitBranchStatus } = {};
  branchStatuses.forEach((b) => {
    if (b.target_url?.length > 0 && b.updated_at) {
      // override with new updated status
      const existVal = pipelineUrls[b.target_url];
      if (!existVal || b.updated_at > existVal.updated_at) {
        pipelineUrls[b.target_url] = b;
      }
    } else {
      ret.push(b);
    }
  });

  Object.keys(pipelineUrls).forEach((u) => {
    ret.push(pipelineUrls[u]);
  });

  return ret;
}

// Pull Request
function massagePr(prToModify: Pr): Pr {
  const pr = prToModify;
  if (pr.title.startsWith(DRAFT_PREFIX)) {
    pr.title = pr.title.substring(DRAFT_PREFIX.length);
    pr.isDraft = true;
  }
  return pr;
}

async function fetchPrList(): Promise<Pr[]> {
  const searchParams = {
    per_page: '100',
  } as any;
  // istanbul ignore if
  if (!config.ignorePrAuthor) {
    searchParams.scope = 'created_by_me';
  }
  const query = getQueryString(searchParams);
  const urlString = `projects/${config.repository}/merge_requests?${query}`;
  try {
    const res = await tgitApi.getJson<
      {
        id: number;
        source_branch: string;
        title: string;
        state: string;
        created_at: string;
      }[]
    >(urlString, { paginate: true });
    return res.body.map((pr) =>
      massagePr({
        number: pr.id,
        sourceBranch: pr.source_branch,
        title: pr.title,
        state: pr.state === 'opened' ? PrState.Open : pr.state,
        createdAt: pr.created_at,
      })
    );
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err }, 'Error fetching PR list');
    if (err.statusCode === 403) {
      throw new Error(PLATFORM_AUTHENTICATION_ERROR);
    }
    throw err;
  }
}

export async function getPrList(): Promise<Pr[]> {
  if (!config.prList) {
    config.prList = await fetchPrList();
  }
  return config.prList;
}

async function tryPrAutomerge(
  prID: number,
  platformOptions: PlatformPrOptions
): Promise<void> {
  if (platformOptions?.usePlatformAutomerge) {
    try {
      const desiredStatus = 'can_be_merged';
      const retryTimes = 5;

      // Check for correct merge request status before setting `merge_when_pipeline_succeeds` to  `true`.
      for (let attempt = 1; attempt <= retryTimes; attempt += 1) {
        const mr = await getMR(config.repository, prID);
        if (mr.merge_status === desiredStatus) {
          break;
        }

        await delay(500 * attempt);
      }

      await mergePr({
        id: prID,
        strategy:
          config.mergeMethod === 'merge' ? 'merge-commit' : config.mergeMethod,
      });
    } catch (err) /* istanbul ignore next */ {
      logger.debug({ err }, 'Automerge on PR creation failed');
    }
  }
}

export async function createPr({
  sourceBranch,
  targetBranch,
  prTitle,
  prBody: rawDescription,
  draftPR,
  labels,
  platformOptions,
}: CreatePRConfig): Promise<Pr> {
  let title = prTitle;
  if (draftPR) {
    title = DRAFT_PREFIX + title;
  }
  const description = sanitize(rawDescription);
  logger.debug(`Creating Merge Request: ${title}`);
  const res = await tgitApi.postJson<Pr & { iid: number; id: number }>(
    `projects/${config.repository}/merge_requests`,
    {
      body: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
        labels: (labels || []).join(','),
      },
    }
  );
  const pr = res.body;
  pr.number = pr.id;
  pr.sourceBranch = sourceBranch;
  pr.displayNumber = `Merge Request #${pr.iid}`;
  if (config.prList) {
    config.prList.push(pr);
  }

  await tryPrAutomerge(pr.id, platformOptions);

  return massagePr(pr);
}

export async function getPr(id: number): Promise<Pr> {
  logger.debug(`getPr(${id})`);
  const mr = await getMR(config.repository, id);

  // Harmonize fields with GitHub
  const pr: Pr = {
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    number: mr.id,
    displayNumber: `Merge Request #${mr.iid}`,
    body: mr.description,
    cannotMergeReason:
      mr.merge_status === 'can_be_merged'
        ? undefined
        : `mr.merge_status="${mr.merge_status}"`,
    state: mr.state === 'opened' ? PrState.Open : mr.state,
    hasAssignees: !!mr.assignee?.id,
    hasReviewers: !!mr.reviewers?.length,
    title: mr.title,
    labels: mr.labels,
    sha: mr.sha,
  };

  return massagePr(pr);
}

export async function updatePr({
  number: id,
  prTitle,
  prBody: description,
  state,
  platformOptions,
}: UpdatePrConfig): Promise<void> {
  let title = prTitle;
  if ((await getPrList()).find((pr) => pr.number === id)?.isDraft) {
    title = DRAFT_PREFIX + title;
  }
  const newState = {
    [PrState.Closed]: 'close',
    [PrState.Open]: 'reopen',
  }[state];
  await tgitApi.putJson(`projects/${config.repository}/merge_request/${id}`, {
    body: {
      title,
      description: sanitize(description),
      ...(newState && { state_event: newState }),
    },
  });

  await tryPrAutomerge(id, platformOptions);
}

export async function mergePr({
  id,
  strategy,
}: {
  id: number;
  strategy: MergeStrategy;
}): Promise<boolean> {
  try {
    await tgitApi.putJson(
      `projects/${config.repository}/merge_request/${id}/merge`,
      { body: { merge_type: strategy } }
    );
    return true;
  } catch (err) /* istanbul ignore next */ {
    if (err.statusCode === 401) {
      logger.debug('No permissions to merge PR');
      return false;
    }
    if (err.statusCode === 406) {
      logger.debug({ err }, 'PR not acceptable for merging');
      return false;
    }
    logger.debug({ err }, 'merge PR error');
    logger.debug('PR merge failed');
    return false;
  }
}

export function massageMarkdown(input: string): string {
  let desc = input
    .replace(regEx(/Pull Request/g), 'Merge Request')
    .replace(regEx(/PR/g), 'MR')
    .replace(regEx(/\]\(\.\.\/pull\//g), '](!');

  if (semver.lt(defaults.version, '13.4.0')) {
    logger.debug(
      { version: defaults.version },
      'GitLab versions earlier than 13.4 have issues with long descriptions, truncating to 25K characters'
    );

    desc = smartTruncate(desc, 25000);
  } else {
    desc = smartTruncate(desc, 1000000);
  }

  return desc;
}

// Branch

function matchesState(state: string, desiredState: string): boolean {
  if (desiredState === PrState.All) {
    return true;
  }
  if (desiredState.startsWith('!')) {
    return state !== desiredState.substring(1);
  }
  return state === desiredState;
}

export async function findPr({
  branchName,
  prTitle,
  state = PrState.All,
}: FindPRConfig): Promise<Pr> {
  logger.debug(`findPr(${branchName}, ${prTitle}, ${state})`);
  const prList = await getPrList();
  return prList.find(
    (p: { sourceBranch: string; title: string; state: string }) =>
      p.sourceBranch === branchName &&
      (!prTitle || p.title === prTitle) &&
      matchesState(p.state, state)
  );
}

// Returns the Pull Request for a branch. Null if not exists.
export async function getBranchPr(branchName: string): Promise<Pr> {
  logger.debug(`getBranchPr(${branchName})`);
  const existingPr = await findPr({
    branchName,
    state: PrState.Open,
  });
  return existingPr ? getPr(existingPr.number) : null;
}

export async function getBranchStatusCheck(
  branchName: string,
  context: string
): Promise<BranchStatus | null> {
  // cache-bust in case we have rebased
  const res = await getStatus(branchName, false);
  logger.debug(`Got res with ${res.length} results`);
  for (const check of res) {
    if (check.name === context) {
      return tgitToRenovateStatusMapping[check.state] || BranchStatus.yellow;
    }
  }
  return null;
}

export async function setBranchStatus({
  branchName,
  context,
  description,
  state: renovateState,
  url: targetUrl,
}: BranchStatusConfig): Promise<void> {
  // First, get the branch commit SHA
  const branchSha = git.getBranchCommit(branchName);
  // Now, check the statuses for that commit
  const url = `projects/${config.repository}/commit/${branchSha}/statuses`;
  let state = 'success';
  if (renovateState === BranchStatus.yellow) {
    state = 'pending';
  } else if (renovateState === BranchStatus.red) {
    state = 'failure';
  }
  const options: any = {
    state,
    description,
    context,
  };
  if (targetUrl) {
    options.target_url = targetUrl;
  }
  try {
    // give tgit some time to create pipelines for the sha
    await delay(1000);

    await tgitApi.postJson(url, { body: options });

    // update status cache
    await getStatus(branchName, false);
  } catch (err) /* istanbul ignore next */ {
    if (
      err.body?.message?.startsWith(
        'Cannot transition status via :enqueue from :pending'
      )
    ) {
      logger.debug('Ignoring status transition error');
    } else {
      logger.debug({ err });
      logger.warn('Failed to set branch status');
    }
  }
}

// Issue
export async function getIssueList(): Promise<TGitIssue[]> {
  if (!config.issueList) {
    const query = getQueryString({
      per_page: '100',
      // scope: 'created_by_me',
      state: 'opened',
    });
    const res = await tgitApi.getJson<
      {
        iid: number;
        id: number;
        title: string;
        labels: string[];
      }[]
    >(`projects/${config.repository}/issues?${query}`, {
      useCache: false,
      paginate: true,
    });
    // istanbul ignore if
    if (!is.array(res.body)) {
      logger.warn({ responseBody: res.body }, 'Could not retrieve issue list');
      return [];
    }
    config.issueList = res.body;
  }

  return config.issueList;
}

export async function getIssue(
  number: number,
  useCache = true
): Promise<Issue | null> {
  try {
    const body = (
      await tgitApi.getJson<{ title: string; description?: string | null }>(
        `projects/${config.repository}/issues/${number}`,
        { useCache }
      )
    ).body;

    return {
      number,
      title: body.title,
      body: body.description,
    };
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err, number }, 'Error getting issue');
    return null;
  }
}

export async function findIssue(title: string): Promise<Issue | null> {
  logger.debug(`findIssue(${title})`);
  try {
    const issueList = await getIssueList();
    const issue = issueList.find((i) => i.title === title);
    if (!issue) {
      return null;
    }
    return await getIssue(issue.id);
  } catch (err) /* istanbul ignore next */ {
    logger.warn('Error finding issue');
    return null;
  }
}

export async function ensureIssue({
  title,
  reuseTitle,
  body,
  labels,
  confidential,
}: EnsureIssueConfig): Promise<'updated' | 'created' | null> {
  logger.debug(`ensureIssue()`);
  const description = massageMarkdown(sanitize(body));
  try {
    const issueList = await getIssueList();
    let issue = issueList.find((i) => i.title === title);
    if (!issue) {
      issue = issueList.find((i) => i.title === reuseTitle);
    }
    if (issue) {
      const existingDescription = (
        await tgitApi.getJson<{ description: string }>(
          `projects/${config.repository}/issues/${issue.id}`
        )
      ).body.description;
      if (issue.title !== title || existingDescription !== description) {
        logger.debug('Updating issue');
        await tgitApi.putJson(
          `projects/${config.repository}/issues/${issue.id}`,
          {
            body: {
              title,
              description,
              labels: (labels || issue.labels || []).join(','),
              confidential: confidential ?? false,
            },
          }
        );
        return 'updated';
      }
    } else {
      await tgitApi.postJson(`projects/${config.repository}/issues`, {
        body: {
          title,
          description,
          labels: (labels || []).join(','),
          confidential: confidential ?? false,
        },
      });
      logger.info('Issue created');
      // delete issueList so that it will be refetched as necessary
      delete config.issueList;
      return 'created';
    }
  } catch (err) /* istanbul ignore next */ {
    if (err.message.startsWith('Issues are disabled for this repo')) {
      logger.debug(`Could not create issue: ${(err as Error).message}`);
    } else {
      logger.warn({ err }, 'Could not ensure issue');
    }
  }
  return null;
}

export async function ensureIssueClosing(title: string): Promise<void> {
  logger.debug(`ensureIssueClosing()`);
  const issueList = await getIssueList();
  for (const issue of issueList) {
    if (issue.title === title) {
      logger.debug({ issue }, 'Closing issue');
      await tgitApi.putJson(
        `projects/${config.repository}/issues/${issue.id}`,
        {
          body: { state_event: 'close' },
        }
      );
    }
  }
}

export async function addAssignees(
  id: number,
  assignees: string[]
): Promise<void> {
  try {
    logger.debug(`Adding assignees '${assignees.join(', ')}' to #${id}`);
    const assigneeIds = [];
    for (const assignee of assignees) {
      assigneeIds.push(await getUserID(assignee));
    }
    await tgitApi.putJson(`projects/${config.repository}/merge_request/${id}`, {
      body: { assignee_id: assigneeIds[0] },
    });
  } catch (err) {
    logger.debug({ err }, 'addAssignees error');
    logger.warn({ id: id, assignees }, 'Failed to add assignees');
  }
}

export async function addReviewers(
  id: number,
  reviewers: string[]
): Promise<void> {
  logger.debug(`Adding reviewers '${reviewers.join(', ')}' to #${id}`);

  let mr: TGitMergeRequest;
  try {
    mr = await getMR(config.repository, id);
  } catch (err) {
    logger.warn({ err }, 'Failed to get existing reviewers');
    return;
  }

  mr.reviewers = mr.reviewers ?? [];
  const existingReviewers = mr.reviewers.map((r) => r.username);

  // Figure out which reviewers (of the ones we want to add) are not already on the MR as a reviewer
  const newReviewers = reviewers.filter((r) => !existingReviewers.includes(r));

  // Gather the IDs for all the reviewers we want to add
  let newReviewerIDs: number[];
  try {
    newReviewerIDs = await Promise.all<number>(newReviewers.map(getUserID));
  } catch (err) {
    logger.warn({ err }, 'Failed to get IDs of the new reviewers');
    return;
  }

  try {
    await updateMergeRequstReviewers(config.repository, id, newReviewerIDs);
  } catch (err) {
    logger.warn({ err }, 'Failed to add reviewers');
  }
}

export async function deleteLabel(id: number, label: string): Promise<void> {
  logger.debug(`Deleting label ${label} from #${id}`);
  try {
    const pr = await getPr(id);
    const labels = (pr.labels || [])
      .filter((l: string) => l !== label)
      .join(',');
    await tgitApi.putJson(`projects/${config.repository}/merge_request/${id}`, {
      body: { labels },
    });
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err, issueNo: id, label }, 'Failed to delete label');
  }
}

async function getComments(id: number): Promise<TGitComment[]> {
  // GET projects/:owner/:repo/merge_requests/:number/notes
  logger.debug(`Getting comments for #${id}`);
  const url = `projects/${config.repository}/merge_requests/${id}/notes`;
  const comments = (
    await tgitApi.getJson<TGitComment[]>(url, { paginate: true })
  ).body;
  logger.debug(`Found ${comments.length} comments`);
  return comments;
}

async function addComment(issueNo: number, body: string): Promise<void> {
  // POST projects/:owner/:repo/merge_requests/:number/notes
  await tgitApi.postJson(
    `projects/${config.repository}/merge_requests/${issueNo}/notes`,
    {
      body: { body },
    }
  );
}

async function editComment(
  issueNo: number,
  commentId: number,
  body: string
): Promise<void> {
  // PUT projects/:owner/:repo/merge_requests/:number/notes/:id
  await tgitApi.putJson(
    `projects/${config.repository}/merge_requests/${issueNo}/notes/${commentId}`,
    {
      body: { body },
    }
  );
}

async function deleteComment(
  issueNo: number,
  commentId: number
): Promise<void> {
  await editComment(issueNo, commentId, '> deleted');
}

export async function ensureComment({
  number,
  topic,
  content,
}: EnsureCommentConfig): Promise<boolean> {
  const sanitizedContent = sanitize(content);
  const massagedTopic = topic
    ? topic
        .replace(regEx(/Pull Request/g), 'Merge Request')
        .replace(regEx(/PR/g), 'MR')
    : topic;
  const comments = await getComments(number);
  let body: string;
  let commentId: number;
  let commentNeedsUpdating: boolean;
  if (topic) {
    logger.debug(`Ensuring comment "${massagedTopic}" in #${number}`);
    body = `### ${topic}\n\n${sanitizedContent}`;
    body = body
      .replace(regEx(/Pull Request/g), 'Merge Request')
      .replace(regEx(/PR/g), 'MR');
    comments.forEach((comment: { body: string; id: number }) => {
      if (comment.body.startsWith(`### ${massagedTopic}\n\n`)) {
        commentId = comment.id;
        commentNeedsUpdating = comment.body !== body;
      }
    });
  } else {
    logger.debug(`Ensuring content-only comment in #${number}`);
    body = `${sanitizedContent}`;
    comments.forEach((comment: { body: string; id: number }) => {
      if (comment.body === body) {
        commentId = comment.id;
        commentNeedsUpdating = false;
      }
    });
  }
  if (!commentId) {
    await addComment(number, body);
    logger.debug(
      { repository: config.repository, issueNo: number },
      'Added comment'
    );
  } else if (commentNeedsUpdating) {
    await editComment(number, commentId, body);
    logger.debug(
      { repository: config.repository, issueNo: number },
      'Updated comment'
    );
  } else {
    logger.debug('Comment is already update-to-date');
  }
  return true;
}

export async function ensureCommentRemoval(
  deleteConfig: EnsureCommentRemovalConfig
): Promise<void> {
  const { number: issueNo } = deleteConfig;
  const key =
    deleteConfig.type === 'by-topic'
      ? deleteConfig.topic
      : deleteConfig.content;
  logger.debug(`Ensuring comment "${key}" in #${issueNo} is removed`);

  const comments = await getComments(issueNo);
  let commentId: number | null | undefined = null;

  if (deleteConfig.type === 'by-topic') {
    const byTopic = (comment: TGitComment): boolean =>
      comment.body.startsWith(`### ${deleteConfig.topic}\n\n`);
    commentId = comments.find(byTopic)?.id;
  } else if (deleteConfig.type === 'by-content') {
    const byContent = (comment: TGitComment): boolean =>
      comment.body.trim() === deleteConfig.content;
    commentId = comments.find(byContent)?.id;
  }

  if (commentId) {
    await deleteComment(issueNo, commentId);
  }
}

export function getVulnerabilityAlerts(): Promise<VulnerabilityAlert[]> {
  return Promise.resolve([]);
}

export async function filterUnavailableUsers(
  users: string[]
): Promise<string[]> {
  const filteredUsers = [];
  for (const user of users) {
    if (await isUserActive(user)) {
      filteredUsers.push(user);
    }
  }
  return filteredUsers;
}
