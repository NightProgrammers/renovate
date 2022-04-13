import { PlatformId } from '../../../constants';
import { logger } from '../../../logger';
import { cache } from '../../../util/cache/package/decorator';
import { TGitHttp } from '../../../util/http/tgit';
import { joinUrlParts } from '../../../util/url';
import { Datasource } from '../datasource';
import type { DigestConfig, GetReleasesConfig, ReleaseResult } from '../types';
import type { TGitCommit, TGitTag } from './types';
import { defaultRegistryUrl, getDepHost, tgitSourceUrl } from './util';

export class TGitTagsDatasource extends Datasource {
  static readonly id = `${PlatformId.TGit}-tags`;
  protected override http: TGitHttp;

  constructor() {
    super(TGitTagsDatasource.id);
    this.http = new TGitHttp();
  }

  override readonly defaultRegistryUrls = [defaultRegistryUrl];

  @cache({
    namespace: `datasource-${TGitTagsDatasource.id}`,
    key: ({ registryUrl, packageName }: GetReleasesConfig) =>
      `${getDepHost(registryUrl)}:${packageName}`,
  })
  async getReleases({
    registryUrl,
    packageName,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    const depHost = getDepHost(registryUrl);
    const repo = await this.getRepo({ registryUrl, packageName });
    const urlEncodedRepo = encodeURIComponent(repo);

    const url = joinUrlParts(
      depHost,
      `api/v3/projects`,
      urlEncodedRepo,
      `repository/tags?per_page=100`
    );

    const tags = (
      await this.http.getJson<TGitTag[]>(url, {
        paginate: true,
      })
    ).body;

    const dependency: ReleaseResult = {
      sourceUrl: tgitSourceUrl(repo, registryUrl),
      releases: null,
    };
    dependency.releases = tags.map(({ name, commit }) => ({
      version: name,
      gitRef: name,
      releaseTimestamp: commit?.created_at,
    }));

    return dependency;
  }

  /**
   * tgit.getDigest
   *
   * Returs the latest commit hash of the repository.
   */
  @cache({
    namespace: `datasource-${TGitTagsDatasource.id}-commit`,
    key: ({ registryUrl, packageName }: GetReleasesConfig) =>
      `${getDepHost(registryUrl)}:${packageName}`,
  })
  override async getDigest(
    { packageName, registryUrl }: Partial<DigestConfig>,
    newValue?: string
  ): Promise<string | null> {
    const depHost = getDepHost(registryUrl);
    const repo = await this.getRepo({ registryUrl, packageName });

    const urlEncodedRepo = encodeURIComponent(repo);
    let digest: string;

    try {
      if (newValue) {
        const url = joinUrlParts(
          depHost,
          `api/v3/projects`,
          urlEncodedRepo,
          `repository/commits/`,
          newValue
        );
        const commits = await this.http.getJson<TGitCommit>(url);
        digest = commits.body.id;
      } else {
        const url = joinUrlParts(
          depHost,
          `api/v3/projects`,
          urlEncodedRepo,
          `repository/commits?per_page=1`
        );
        const commits = await this.http.getJson<TGitCommit[]>(url);
        digest = commits.body[0].id;
      }
    } catch (err) {
      logger.debug(
        { tgitRepo: repo, err, registryUrl },
        'Error getting latest commit from Tencent Git repo'
      );
    }

    if (!digest) {
      return null;
    }

    return digest;
  }

  @cache({
    namespace: `datasource-${TGitTagsDatasource.id}-repo`,
    key: ({ registryUrl, packageName }: GetReleasesConfig) =>
      `${getDepHost(registryUrl)}:${packageName}`,
  })
  async getRepo({
    registryUrl,
    packageName,
  }: GetReleasesConfig): Promise<string> {
    const depHost = getDepHost(registryUrl);
    return await this.getSourceRepo(depHost, packageName.split('/'));
  }

  async getSourceRepo(
    depHost: string,
    packagePathParts: string[]
  ): Promise<string> {
    const packageName = packagePathParts.join('/');
    if (packagePathParts.length <= 2) {
      return packageName;
    }

    const url = joinUrlParts(
      depHost,
      `api/v3/projects`,
      encodeURIComponent(packageName)
    );

    try {
      await this.http.getJson<{ id: number }>(url, {
        throwHttpErrors: false,
      });

      return packageName;
    } catch (err) {
      logger.debug({ packageName }, err.statusCode);
      if (err.statusCode === 404) {
        // 缩一级路径递归检测
        return await this.getSourceRepo(depHost, packagePathParts.slice(0, -1));
      }

      throw err;
    }
  }
}
