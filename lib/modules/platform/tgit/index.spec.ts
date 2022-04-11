// TODO fix mocks
import type { Platform, RepoParams } from '..';
import * as httpMock from '../../../../test/http-mock';
import {
  CONFIG_GIT_URL_UNAVAILABLE,
  REPOSITORY_ARCHIVED,
  REPOSITORY_CHANGED,
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
} from '../../../constants/error-messages';
import { BranchStatus, PrState } from '../../../types';
import type * as _git from '../../../util/git';
import type * as _hostRules from '../../../util/host-rules';
const tgitApiHost = 'https://git.code.tencent.com';

describe('modules/platform/tgit/index', () => {
  const prBody = `https://github.com/foo/bar/issues/5 plus also [a link](https://github.com/foo/bar/issues/5

  Pull Requests are the best, here are some PRs.

  ## Open

These updates have all been created already. Click a checkbox below to force a retry/rebase of any.

 - [ ] <!-- rebase-branch=renovate/major-got-packages -->[build(deps): update got packages (major)](../pull/2433) (\`gh-got\`, \`gl-got\`, \`got\`)
`;

  let tgit: Platform;
  let hostRules: jest.Mocked<typeof _hostRules>;
  let git: jest.Mocked<typeof _git>;

  async function initPlatform() {
    httpMock.scope(tgitApiHost).get('/api/v3/user').reply(200, {
      email: 'a@b.com',
      name: 'Renovate Bot',
    });
    await tgit.initPlatform({
      token: 'some-token',
      endpoint: undefined,
    });
  }

  beforeEach(async () => {
    // reset module
    jest.resetModules();
    jest.resetAllMocks();
    tgit = await import('.');
    jest.mock('../../../util/host-rules');
    jest.mock('delay');
    hostRules = require('../../../util/host-rules');
    jest.mock('../../../util/git');
    git = require('../../../util/git');
    git.branchExists.mockReturnValue(true);
    git.isBranchStale.mockResolvedValue(true);
    git.getBranchCommit.mockReturnValue(
      '0d9c7726c3d628b7e28af234595cfd20febdbf8e'
    );
    hostRules.find.mockReturnValue({
      token: '123test',
    });
    delete process.env.TGIT_IGNORE_REPO_URL;
  });

  beforeEach(async () => await initPlatform());

  describe('initPlatform()', () => {
    it(`should throw if no token`, async () => {
      await expect(tgit.initPlatform({} as any)).rejects.toThrow();
    });
    it(`should throw if auth fails`, async () => {
      // user
      httpMock.scope(tgitApiHost).get('/api/v3/user').reply(403);
      const res = tgit.initPlatform({
        token: 'some-token',
        endpoint: undefined,
      });
      await expect(res).rejects.toThrow('Init: Authentication failure');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it(`should default to git.code.tencent.com`, async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/user').reply(200, {
        email: 'a@b.com',
        name: 'Renovate Bot',
      });
      expect(
        await tgit.initPlatform({
          token: 'some-token',
          endpoint: undefined,
        })
      ).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it(`should accept custom endpoint`, async () => {
      const endpoint = 'https://tgit.renovatebot.com';
      httpMock.scope(endpoint).get('/user').reply(200, {
        email: 'a@b.com',
        name: 'Renovate Bot',
      });
      expect(
        await tgit.initPlatform({
          endpoint,
          token: 'some-token',
        })
      ).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it(`should reuse existing gitAuthor`, async () => {
      expect(
        await tgit.initPlatform({
          token: 'some-token',
          endpoint: undefined,
          gitAuthor: 'somebody',
        })
      ).toEqual({ endpoint: 'https://git.code.tencent.com/api/v3/' });
    });
  });

  describe('getRepos', () => {
    it('should throw an error if it receives an error', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/accessable?per_page=100')
        .replyWithError('getRepos error');
      await expect(tgit.getRepos()).rejects.toThrow('getRepos error');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should return an array of repos', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/accessable?per_page=100')
        .reply(200, [
          {
            path_with_namespace: 'a/b',
          },
          {
            path_with_namespace: 'c/d',
          },
          {
            path_with_namespace: 'c/e',
            archived: true,
          },
          {
            path_with_namespace: 'c/f',
            mirror: true,
          },
        ]);
      const repos = await tgit.getRepos();
      expect(repos).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  async function initRepo(
    repoParams: RepoParams = {
      repository: 'some/repo',
    },
    repoResp = null,
    scope = httpMock.scope(tgitApiHost)
  ): Promise<httpMock.Scope> {
    const repo = repoParams.repository;
    const justRepo = repo.split('/').slice(0, 2).join('/');
    scope.get(`/api/v3/projects/${encodeURIComponent(repo)}`).reply(
      200,
      repoResp || {
        default_branch: 'master',
        http_url_to_repo: `https://git.code.tencent.com/${justRepo}.git`,
      }
    );
    await tgit.initRepo(repoParams);
    return scope;
  }

  describe('initRepo', () => {
    const okReturn = {
      default_branch: 'master',
      http_url_to_repo: 'http://some-url',
      https_url_to_repo: 'https://some-url',
    };
    it(`should escape all forward slashes in project names`, async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo%2Fproject')
        .reply(200, okReturn);
      await tgit.initRepo({
        repository: 'some/repo/project',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should throw an error if receiving an error', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo')
        .replyWithError('always error');
      await expect(
        tgit.initRepo({
          repository: 'some/repo',
        })
      ).rejects.toThrow('always error');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should throw an error if repository is archived', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo')
        .reply(200, { archived: true });
      await expect(
        tgit.initRepo({
          repository: 'some/repo',
        })
      ).rejects.toThrow(REPOSITORY_ARCHIVED);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should throw an error if MRs are disabled', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo')
        .reply(200, { merge_requests_enabled: false });
      await expect(
        tgit.initRepo({
          repository: 'some/repo',
        })
      ).rejects.toThrow(REPOSITORY_DISABLED);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should throw an error if repository is empty', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo')
        .reply(200, { default_branch: null });
      await expect(
        tgit.initRepo({
          repository: 'some/repo',
        })
      ).rejects.toThrow(REPOSITORY_EMPTY);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should fall back if http_url_to_repo is empty', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo%2Fproject')
        .reply(200, {
          default_branch: 'master',
          http_url_to_repo: null,
        });
      await tgit.initRepo({
        repository: 'some/repo/project',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('should use ssh_url_to_repo if gitUrl is set to ssh', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo%2Fproject')
        .reply(200, {
          default_branch: 'master',
          http_url_to_repo: `https://git.code.tencent.com/some%2Frepo%2Fproject.git`,
          ssh_url_to_repo: `ssh://git@git.code.tencent.com/some%2Frepo%2Fproject.git`,
        });
      await tgit.initRepo({
        repository: 'some/repo/project',
        gitUrl: 'ssh',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
      expect(git.initRepo.mock.calls).toMatchSnapshot();
    });

    it('should throw if ssh_url_to_repo is not present but gitUrl is set to ssh', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo%2Fproject')
        .reply(200, {
          default_branch: 'master',
          http_url_to_repo: `https://git.code.tencent.com/some%2Frepo%2Fproject.git`,
        });
      await expect(
        tgit.initRepo({
          repository: 'some/repo/project',
          gitUrl: 'ssh',
        })
      ).rejects.toThrow(CONFIG_GIT_URL_UNAVAILABLE);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('getRepoForceRebase', () => {
    it('should return false', async () => {
      await initRepo(
        {
          repository: 'some/repo/project',
        },
        {
          default_branch: 'master',
          http_url_to_repo: null,
          merge_method: 'merge',
        }
      );
      expect(await tgit.getRepoForceRebase()).toBeFalse();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('should return true', async () => {
      await initRepo(
        {
          repository: 'some/repo/project',
        },
        {
          default_branch: 'master',
          http_url_to_repo: null,
          merge_method: 'rebase',
        }
      );
      expect(await tgit.getRepoForceRebase()).toBeTrue();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  describe('getBranchPr(branchName)', () => {
    it('should return null if no PR exists', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, []);
      const pr = await tgit.getBranchPr('some-branch');
      expect(pr).toBeNull();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should return the PR object', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 91,
            iid: 9991,
            title: 'some change',
            source_branch: 'some-branch',
            target_branch: 'master',
            state: 'opened',
          },
        ])
        .get('/api/v3/projects/some%2Frepo/merge_request/91')
        .reply(200, {
          id: 91,
          iid: 9991,
          title: 'some change',
          state: 'opened',
          additions: 1,
          deletions: 1,
          commits: 1,
          source_branch: 'some-branch',
          target_branch: 'master',
          base: {
            sha: '1234',
          },
        })
        .get('/api/v3/projects/some%2Frepo/merge_request/91/review')
        .reply(200, {
          id: 91,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getBranchPr('some-branch');
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should strip draft prefix from title', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 91,
            iid: 9991,
            title: 'Draft: some change',
            source_branch: 'some-branch',
            target_branch: 'master',
            state: 'opened',
          },
        ])
        .get('/api/v3/projects/some%2Frepo/merge_request/91')
        .reply(200, {
          id: 91,
          iid: 9991,
          title: 'Draft: some change',
          state: 'opened',
          additions: 1,
          deletions: 1,
          commits: 1,
          source_branch: 'some-branch',
          target_branch: 'master',
          base: {
            sha: '1234',
          },
        })
        .get('/api/v3/projects/some%2Frepo/merge_request/91/review')
        .reply(200, {
          id: 91,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getBranchPr('some-branch');
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should strip deprecated draft prefix from title', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 91,
            iid: 9991,
            title: 'WIP: some change',
            source_branch: 'some-branch',
            target_branch: 'master',
            state: 'opened',
          },
        ])
        .get('/api/v3/projects/some%2Frepo/merge_request/91')
        .reply(200, {
          id: 91,
          iid: 9991,
          title: 'WIP: some change',
          state: 'opened',
          additions: 1,
          deletions: 1,
          commits: 1,
          source_branch: 'some-branch',
          target_branch: 'master',
          base: {
            sha: '1234',
          },
        })
        .get('/api/v3/projects/some%2Frepo/merge_request/91/review')
        .reply(200, {
          id: 91,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getBranchPr('some-branch');
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('getBranchStatus(branchName, ignoreTests)', () => {
    it('returns pending if no results', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, []);
      const res = await tgit.getBranchStatus('somebranch');
      expect(res).toEqual(BranchStatus.yellow);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns success if all are success', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, [{ state: 'success' }, { state: 'success' }]);
      const res = await tgit.getBranchStatus('somebranch');
      expect(res).toEqual(BranchStatus.green);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('returns failure if any mandatory jobs fails', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, [{ state: 'success' }, { state: 'failure' }]);
      const res = await tgit.getBranchStatus('somebranch');
      expect(res).toEqual(BranchStatus.red);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('maps custom statuses to yellow', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, [{ state: 'success' }, { state: 'foo' }]);
      const res = await tgit.getBranchStatus('somebranch');
      expect(res).toEqual(BranchStatus.yellow);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('throws repository-changed', async () => {
      expect.assertions(2);
      git.branchExists.mockReturnValue(false);
      await initRepo();
      await expect(tgit.getBranchStatus('somebranch')).rejects.toThrow(
        REPOSITORY_CHANGED
      );
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('getBranchStatusCheck', () => {
    it('returns null if no results', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, []);
      const res = await tgit.getBranchStatusCheck('somebranch', 'some-context');
      expect(res).toBeNull();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns null if no matching results', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, [{ name: 'context-1', state: 'pending' }]);
      const res = await tgit.getBranchStatusCheck('somebranch', 'some-context');
      expect(res).toBeNull();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns status if name found', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
        )
        .reply(200, [
          { name: 'context-1', state: 'pending' },
          { name: 'some-context', state: 'success' },
          { name: 'context-3', state: 'failure' },
        ]);
      const res = await tgit.getBranchStatusCheck('somebranch', 'some-context');
      expect(res).toEqual(BranchStatus.green);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('setBranchStatus', () => {
    it.each([BranchStatus.green, BranchStatus.yellow, BranchStatus.red])(
      'sets branch status %s',
      async (state) => {
        const scope = await initRepo();
        scope
          .post(
            '/api/v3/projects/some%2Frepo/commit/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
          )
          .reply(200, {})
          .get(
            '/api/v3/projects/some%2Frepo/commits/0d9c7726c3d628b7e28af234595cfd20febdbf8e/statuses'
          )
          .reply(200, []);

        await tgit.setBranchStatus({
          branchName: 'some-branch',
          context: 'some-context',
          description: 'some-description',
          state,
          url: 'some-url',
        });
        expect(httpMock.getTrace()).toMatchSnapshot();
      }
    );
  });

  describe('findIssue()', () => {
    it('returns null if no issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            iid: 1,
            title: 'title-1',
          },
          {
            iid: 2,
            title: 'title-2',
          },
        ]);
      const res = await tgit.findIssue('title-3');
      expect(res).toBeNull();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('finds issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            id: 1,
            iid: 111,
            title: 'title-1',
          },
          {
            id: 2,
            iid: 2222,
            title: 'title-2',
          },
        ])
        .get('/api/v3/projects/undefined/issues/2')
        .reply(200, { description: 'new-content' });
      const res = await tgit.findIssue('title-2');
      expect(res).not.toBeNull();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('ensureIssue()', () => {
    it('creates issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            iid: 1,
            title: 'title-1',
          },
          {
            iid: 2,
            title: 'title-2',
          },
        ])
        .post('/api/v3/projects/undefined/issues')
        .reply(200);
      const res = await tgit.ensureIssue({
        title: 'new-title',
        body: 'new-content',
      });
      expect(res).toBe('created');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('sets issue labels', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [])
        .post('/api/v3/projects/undefined/issues')
        .reply(200);
      const res = await tgit.ensureIssue({
        title: 'new-title',
        body: 'new-content',
        labels: ['Renovate', 'Maintenance'],
      });
      expect(res).toBe('created');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('updates issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            id: 1,
            iid: 111,
            title: 'title-1',
          },
          {
            id: 2,
            iid: 222,
            title: 'title-2',
          },
        ])
        .get('/api/v3/projects/undefined/issues/2')
        .reply(200, { description: 'new-content' })
        .put('/api/v3/projects/undefined/issues/2')
        .reply(200);
      const res = await tgit.ensureIssue({
        title: 'title-2',
        body: 'newer-content',
      });
      expect(res).toBe('updated');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('updates issue with labels', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            id: 1,
            iid: 111,
            title: 'title-1',
          },
          {
            id: 2,
            iid: 222,
            title: 'title-2',
          },
        ])
        .get('/api/v3/projects/undefined/issues/2')
        .reply(200, { description: 'new-content' })
        .put('/api/v3/projects/undefined/issues/2')
        .reply(200);
      const res = await tgit.ensureIssue({
        title: 'title-2',
        body: 'newer-content',
        labels: ['Renovate', 'Maintenance'],
      });
      expect(res).toBe('updated');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('skips update if unchanged', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            id: 1,
            iid: 111,
            title: 'title-1',
          },
          {
            id: 2,
            iid: 222,
            title: 'title-2',
          },
        ])
        .get('/api/v3/projects/undefined/issues/2')
        .reply(200, { description: 'newer-content' });
      const res = await tgit.ensureIssue({
        title: 'title-2',
        body: 'newer-content',
      });
      expect(res).toBeNull();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('creates confidential issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            id: 1,
            iid: 111,
            title: 'title-1',
          },
          {
            id: 2,
            iid: 2222,
            title: 'title-2',
          },
        ])
        .post('/api/v3/projects/undefined/issues')
        .reply(200);
      const res = await tgit.ensureIssue({
        title: 'new-title',
        body: 'new-content',
        confidential: true,
      });
      expect(res).toBe('created');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('updates confidential issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            id: 1,
            iid: 111,
            title: 'title-1',
          },
          {
            id: 2,
            iid: 222,
            title: 'title-2',
          },
        ])
        .get('/api/v3/projects/undefined/issues/2')
        .reply(200, { description: 'new-content' })
        .put('/api/v3/projects/undefined/issues/2')
        .reply(200);
      const res = await tgit.ensureIssue({
        title: 'title-2',
        body: 'newer-content',
        labels: ['Renovate', 'Maintenance'],
        confidential: true,
      });
      expect(res).toBe('updated');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('ensureIssueClosing()', () => {
    it('closes issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/issues?per_page=100&state=opened')
        .reply(200, [
          {
            iid: 1,
            id: 1,
            title: 'title-1',
          },
          {
            iid: 2,
            id: 2,
            title: 'title-2',
          },
        ])
        .put('/api/v3/projects/undefined/issues/2')
        .reply(200);
      await tgit.ensureIssueClosing('title-2');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  describe('addAssignees(issueNo, assignees)', () => {
    it('should add the given assignee to the issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/users/someuser')
        .reply(200, [{ id: 123 }])
        .put('/api/v3/projects/undefined/merge_request/42')
        .reply(200);
      await tgit.addAssignees(42, ['someuser']);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should add the given assignees to the issue', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/users/someuser')
        .reply(200, [{ id: 123 }])
        .get('/api/v3/users/someotheruser')
        .reply(200, [{ id: 124 }])
        .put('/api/v3/projects/undefined/merge_request/42')
        .reply(200);
      await tgit.addAssignees(42, ['someuser', 'someotheruser']);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('should swallow error', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/users/someuser')
        .replyWithError('some error');
      await tgit.addAssignees(42, ['someuser', 'someotheruser']);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  describe('addReviewers(id, reviewers)', () => {
    beforeEach(async () => {
      await initPlatform();
    });

    const existingReviewers = [
      { id: 1, username: 'foo' },
      { id: 2, username: 'bar' },
    ];

    it('should fail to get existing reviewers', async () => {
      const scope = httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/42')
        .reply(404);

      await tgit.addReviewers(42, ['someuser', 'foo', 'someotheruser']);
      expect(scope.isDone()).toBeTrue();
    });

    it('should fail to get user IDs', async () => {
      const scope = httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/42')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/42/review')
        .reply(200, { reviewers: existingReviewers })
        .get('/api/v3/users/someuser')
        .reply(200, [{ id: 10 }])
        .get('/api/v3/users/someotheruser')
        .reply(404);

      await tgit.addReviewers(42, ['someuser', 'foo', 'someotheruser']);
      expect(scope.isDone()).toBeTrue();
    });

    it('should fail to add reviewers to the MR', async () => {
      const scope = httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/42')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/42/review')
        .reply(200, { reviewers: existingReviewers })
        .get('/api/v3/users/someuser')
        .reply(200, { id: 10 })
        .get('/api/v3/users/someotheruser')
        .reply(200, { id: 15 })
        .put('/api/v3/projects/undefined/merge_request/42', {
          reviewer_ids: [1, 2, 10, 15],
        })
        .reply(404);

      await tgit.addReviewers(42, ['someuser', 'foo', 'someotheruser']);
      expect(scope.isDone()).toBeTrue();
    });

    it('should add the given reviewers to the MR', async () => {
      const scope = httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/42')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/42/review')
        .reply(200, { reviewers: existingReviewers })
        .get('/api/v3/users/someuser')
        .reply(200, { id: 10 })
        .get('/api/v3/users/someotheruser')
        .reply(200, { id: 15 })
        .put('/api/v3/projects/undefined/merge_request/42', {
          reviewer_ids: [1, 2, 10, 15],
        })
        .reply(200);

      await tgit.addReviewers(42, ['someuser', 'foo', 'someotheruser']);
      expect(scope.isDone()).toBeTrue();
    });

    it('should only add reviewers if necessary', async () => {
      const scope = httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/42')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/42/review')
        .reply(200, { reviewers: existingReviewers })
        .get('/api/v3/users/someuser')
        .reply(200, [{ id: 1 }])
        .get('/api/v3/users/someotheruser')
        .reply(200, [{ id: 2 }])
        .put('/api/v3/projects/undefined/merge_request/42')
        .reply(200);

      await tgit.addReviewers(42, ['someuser', 'foo', 'someotheruser']);
      expect(scope.isDone()).toBeTrue();
    });
  });

  describe('ensureComment', () => {
    it('add comment if not found', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200, [])
        .post('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200);
      await tgit.ensureComment({
        number: 42,
        topic: 'some-subject',
        content: 'some\ncontent',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('add updates comment if necessary', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200, [{ id: 1234, body: '### some-subject\n\nblablabla' }])
        .put('/api/v3/projects/some%2Frepo/merge_requests/42/notes/1234')
        .reply(200);
      await tgit.ensureComment({
        number: 42,
        topic: 'some-subject',
        content: 'some\ncontent',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('skips comment', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200, [{ id: 1234, body: '### some-subject\n\nsome\ncontent' }]);
      await tgit.ensureComment({
        number: 42,
        topic: 'some-subject',
        content: 'some\ncontent',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('handles comment with no description', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200, [{ id: 1234, body: '!merge' }]);
      await tgit.ensureComment({
        number: 42,
        topic: null,
        content: '!merge',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('ensureCommentRemoval', () => {
    it('deletes comment by topic if found', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200, [{ id: 1234, body: '### some-subject\n\nblablabla' }])
        .put('/api/v3/projects/some%2Frepo/merge_requests/42/notes/1234')
        .reply(200);
      await tgit.ensureCommentRemoval({
        type: 'by-topic',
        number: 42,
        topic: 'some-subject',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('deletes comment by content if found', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_requests/42/notes')
        .reply(200, [{ id: 1234, body: 'some-body\n' }])
        .put('/api/v3/projects/some%2Frepo/merge_requests/42/notes/1234')
        .reply(200);
      await tgit.ensureCommentRemoval({
        type: 'by-content',
        number: 42,
        content: 'some-body',
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('findPr(branchName, prTitle, state)', () => {
    it('returns true if no title and all state', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            iid: 1,
            source_branch: 'branch-a',
            title: 'branch a pr',
            state: 'opened',
          },
        ]);
      const res = await tgit.findPr({
        branchName: 'branch-a',
      });
      expect(res).toBeDefined();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns true if not open', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            iid: 1,
            source_branch: 'branch-a',
            title: 'branch a pr',
            state: PrState.Merged,
          },
        ]);
      const res = await tgit.findPr({
        branchName: 'branch-a',
        state: PrState.NotOpen,
      });
      expect(res).toBeDefined();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('returns true if open and with title', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            iid: 1,
            source_branch: 'branch-a',
            title: 'branch a pr',
            state: 'opened',
          },
        ]);
      const res = await tgit.findPr({
        branchName: 'branch-a',
        prTitle: 'branch a pr',
        state: PrState.Open,
      });
      expect(res).toBeDefined();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('returns true with title', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            iid: 1,
            source_branch: 'branch-a',
            title: 'branch a pr',
            state: 'opened',
          },
        ]);
      const res = await tgit.findPr({
        branchName: 'branch-a',
        prTitle: 'branch a pr',
      });
      expect(res).toBeDefined();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns true with draft prefix title', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            iid: 1,
            source_branch: 'branch-a',
            title: '[WIP] branch a pr',
            state: 'opened',
          },
        ]);
      const res = await tgit.findPr({
        branchName: 'branch-a',
        prTitle: 'branch a pr',
      });
      expect(res).toBeDefined();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  describe('createPr(branchName, title, body)', () => {
    beforeEach(async () => await initPlatform());
    it('returns the PR', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        });
      const pr = await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: null,
      });
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('uses default branch', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        });
      const pr = await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: [],
      });
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('supports draftPR', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'WIP: some title',
        });
      const pr = await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        draftPR: true,
      });
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('auto-accepts the MR when requested', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        })
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          merge_status: 'can_be_merged',
          pipeline: {
            id: 29626725,
            sha: '2be7ddb704c7b6b83732fdd5b9f09d5a397b5f8f',
            ref: 'patch-28',
            status: 'success',
          },
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          state: 'approved',
        })
        .put('/api/v3/projects/undefined/merge_request/1/merge')
        .reply(200);
      await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: [],
        platformOptions: {
          usePlatformAutomerge: true,
        },
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('raises with squash enabled when repository squash option is default_on', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo')
        .reply(200, {
          squash_option: 'default_on',
          default_branch: 'master',
          url: 'https://some-url',
        });
      await tgit.initRepo({
        repository: 'some/repo',
      });
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/some%2Frepo/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        });
      const pr = await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: null,
      });
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('raises with squash enabled when repository squash option is always', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/some%2Frepo')
        .reply(200, {
          squash_option: 'always',
          default_branch: 'master',
          url: 'https://some-url',
        });
      await tgit.initRepo({
        repository: 'some/repo',
      });
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/some%2Frepo/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        });
      const pr = await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: null,
      });
      expect(pr).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('adds approval rule to ignore all approvals', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        })
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          merge_status: 'can_be_merged',
          pipeline: {
            id: 29626725,
            sha: '2be7ddb704c7b6b83732fdd5b9f09d5a397b5f8f',
            ref: 'patch-28',
            status: 'success',
          },
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 12345,
          state: 'approved',
          reviewers: [],
        })
        .put('/api/v3/projects/undefined/merge_request/1/merge')
        .reply(200);
      await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: [],
        platformOptions: {
          usePlatformAutomerge: true,
        },
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('does not try to create already existing approval rule', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        })
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          merge_status: 'can_be_merged',
          pipeline: {
            id: 29626725,
            sha: '2be7ddb704c7b6b83732fdd5b9f09d5a397b5f8f',
            ref: 'patch-28',
            status: 'success',
          },
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 12345,
          state: 'approved',
          reviewers: [],
        })
        .put('/api/v3/projects/undefined/merge_request/1/merge')
        .reply(200);
      await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: [],
        platformOptions: {
          usePlatformAutomerge: true,
        },
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('silently ignores approval rules adding errors', async () => {
      httpMock
        .scope(tgitApiHost)
        .post('/api/v3/projects/undefined/merge_requests')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'some title',
        })
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {})
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          merge_status: 'can_be_merged',
          pipeline: {
            id: 29626725,
            sha: '2be7ddb704c7b6b83732fdd5b9f09d5a397b5f8f',
            ref: 'patch-28',
            status: 'success',
          },
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 12345,
          state: 'approved',
          reviewers: [],
        })
        .put('/api/v3/projects/undefined/merge_request/1/merge')
        .reply(200);
      await tgit.createPr({
        sourceBranch: 'some-branch',
        targetBranch: 'master',
        prTitle: 'some-title',
        prBody: 'the-body',
        labels: [],
        platformOptions: {
          usePlatformAutomerge: true,
        },
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('getPr(prNo)', () => {
    it('returns the PR', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'do something',
          description: 'a merge request',
          state: PrState.Merged,
          merge_status: 'cannot_be_merged',
          diverged_commits_count: 5,
          source_branch: 'some-branch',
          target_branch: 'master',
          assignees: [],
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getPr(1);
      expect(pr).toMatchSnapshot();
      expect(pr.hasAssignees).toBeFalse();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('removes draft prefix from returned title', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: '[WIP] do something',
          description: 'a merge request',
          state: PrState.Merged,
          merge_status: 'cannot_be_merged',
          diverged_commits_count: 5,
          source_branch: 'some-branch',
          target_branch: 'master',
          assignees: [],
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getPr(1);
      expect(pr).toMatchSnapshot();
      expect(pr.title).toBe('do something');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns the mergeable PR', async () => {
      const scope = await initRepo();
      scope
        .get('/api/v3/projects/some%2Frepo/merge_request/1')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'do something',
          description: 'a merge request',
          state: PrState.Open,
          diverged_commits_count: 5,
          source_branch: 'some-branch',
          target_branch: 'master',
          assignee: {
            id: 1,
          },
        })
        .get('/api/v3/projects/some%2Frepo/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getPr(1);
      expect(pr).toMatchSnapshot();
      expect(pr.hasAssignees).toBeTrue();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('returns the PR with nonexisting branch', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/1')
        .reply(200, {
          id: 1,
          iid: 12345,
          title: 'do something',
          description: 'a merge request',
          state: PrState.Open,
          merge_status: 'cannot_be_merged',
          diverged_commits_count: 2,
          source_branch: 'some-branch',
          target_branch: 'master',
          assignee: {
            id: 1,
          },
        })
        .get('/api/v3/projects/undefined/merge_request/1/review')
        .reply(200, {
          id: 1,
          iid: 9991,
          state: 'approved',
          reviewers: [],
        });
      const pr = await tgit.getPr(1);
      expect(pr).toMatchSnapshot();
      expect(pr.hasAssignees).toBeTrue();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('updatePr(prNo, title, body)', () => {
    jest.resetAllMocks();
    it('updates the PR', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 1,
            iid: 1111,
            source_branch: 'branch-a',
            title: 'branch a pr',
            state: PrState.Open,
          },
        ])
        .put('/api/v3/projects/undefined/merge_request/1')
        .reply(200);
      await tgit.updatePr({ number: 1, prTitle: 'title', prBody: 'body' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('retains draft status when draft uses current prefix', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 1,
            iid: 1111,
            source_branch: 'branch-a',
            title: 'Draft: foo',
            state: PrState.Open,
          },
        ])
        .put('/api/v3/projects/undefined/merge_request/1')
        .reply(200);
      await tgit.updatePr({ number: 1, prTitle: 'title', prBody: 'body' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('retains draft status when draft uses deprecated prefix', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 1,
            iid: 111,
            source_branch: 'branch-a',
            title: 'WIP: foo',
            state: PrState.Open,
          },
        ])
        .put('/api/v3/projects/undefined/merge_request/1')
        .reply(200);
      await tgit.updatePr({ number: 1, prTitle: 'title', prBody: 'body' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('closes the PR', async () => {
      httpMock
        .scope(tgitApiHost)
        .get(
          '/api/v3/projects/undefined/merge_requests?per_page=100&scope=created_by_me'
        )
        .reply(200, [
          {
            id: 1,
            iid: 111,
            source_branch: 'branch-a',
            title: 'branch a pr',
            state: PrState.Open,
          },
        ])
        .put('/api/v3/projects/undefined/merge_request/1')
        .reply(200);
      await tgit.updatePr({
        number: 1,
        prTitle: 'title',
        prBody: 'body',
        state: PrState.Closed,
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('mergePr(pr)', () => {
    jest.resetAllMocks();
    it('merges the PR', async () => {
      httpMock
        .scope(tgitApiHost)
        .put('/api/v3/projects/undefined/merge_request/1/merge')
        .reply(200);
      await tgit.mergePr({
        id: 1,
      });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  describe('massageMarkdown(input)', () => {
    it('returns updated pr body', async () => {
      jest.mock('../utils/pr-body');
      const { smartTruncate } = require('../utils/pr-body');

      await initPlatform();
      expect(tgit.massageMarkdown(prBody)).toMatchSnapshot();
      expect(smartTruncate).not.toHaveBeenCalled();
    });
  });

  describe('getVulnerabilityAlerts()', () => {
    it('returns empty', async () => {
      const res = await tgit.getVulnerabilityAlerts();
      expect(res).toHaveLength(0);
    });
  });
  describe('deleteLabel(issueNo, label)', () => {
    it('should delete the label', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/projects/undefined/merge_request/42')
        .reply(200, {
          id: 42,
          iid: 12345,
          title: 'some change',
          description: 'a merge request',
          state: PrState.Merged,
          merge_status: 'cannot_be_merged',
          diverged_commits_count: 5,
          source_branch: 'some-branch',
          labels: ['foo', 'renovate', 'rebase'],
        })
        .get('/api/v3/projects/undefined/merge_request/42/review')
        .reply(200, {
          id: 42,
          iid: 12345,
          state: 'approved',
        })
        .put('/api/v3/projects/undefined/merge_request/42')
        .reply(200);
      await tgit.deleteLabel(42, 'rebase');
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('getJsonFile()', () => {
    it('returns file content', async () => {
      const data = { foo: 'bar' };
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/repository/blobs/HEAD?file_path=dir%2Ffile.json'
        )
        .reply(200, JSON.stringify(data));
      const res = await tgit.getJsonFile('dir/file.json');
      expect(res).toEqual(data);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('returns file content in json5 format', async () => {
      const json5Data = `
        {
          // json5 comment
          foo: 'bar'
        }
        `;
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/repository/blobs/HEAD?file_path=dir%2Ffile.json5'
        )
        .reply(200, json5Data);
      const res = await tgit.getJsonFile('dir/file.json5');
      expect(res).toEqual({ foo: 'bar' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('returns file content from given repo', async () => {
      const data = { foo: 'bar' };
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/different%2Frepo/repository/blobs/HEAD?file_path=dir%2Ffile.json'
        )
        .reply(200, JSON.stringify(data));
      const res = await tgit.getJsonFile('dir/file.json', 'different%2Frepo');
      expect(res).toEqual(data);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('returns file content from branch or tag', async () => {
      const data = { foo: 'bar' };
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/repository/blobs/dev?file_path=dir%2Ffile.json'
        )
        .reply(200, JSON.stringify(data));
      const res = await tgit.getJsonFile('dir/file.json', 'some%2Frepo', 'dev');
      expect(res).toEqual(data);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('throws on malformed JSON', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/repository/blobs/HEAD?file_path=dir%2Ffile.json'
        )
        .reply(200, '!@#');
      await expect(tgit.getJsonFile('dir/file.json')).rejects.toThrow();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
    it('throws on errors', async () => {
      const scope = await initRepo();
      scope
        .get(
          '/api/v3/projects/some%2Frepo/repository/blobs/HEAD?file_path=dir%2Ffile.json'
        )
        .replyWithError('some error');
      await expect(tgit.getJsonFile('dir/file.json')).rejects.toThrow();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
  describe('filterUnavailableUsers(users)', () => {
    it('filters users that are busy', async () => {
      httpMock
        .scope(tgitApiHost)
        .get('/api/v3/users/maria')
        .reply(200, {
          state: 'busy',
        })
        .get('/api/v3/users/john')
        .reply(200, {
          availability: 'active',
        });
      const filteredUsers = await tgit.filterUnavailableUsers([
        'maria',
        'john',
      ]);
      expect(filteredUsers).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('keeps users with missing availability', async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/users/maria').reply(200, {});
      const filteredUsers = await tgit.filterUnavailableUsers(['maria']);
      expect(filteredUsers).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('keeps users with failing requests', async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/users/maria').reply(404);
      const filteredUsers = await tgit.filterUnavailableUsers(['maria']);
      expect(filteredUsers).toMatchSnapshot();
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
});
